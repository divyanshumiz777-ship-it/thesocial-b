import { createSign } from "node:crypto";
import { PushSubscription } from "../models/PushSubscription.ts";
import type { PushPayload } from "./webPush.ts";

// Mirrors webPush.ts's isPushEnabled()/sendPushToUser() shape exactly, for
// the native (FCM) half of push delivery.
//
// Calls FCM's HTTP v1 API directly rather than depending on firebase-admin.
// That package transitively pulls in @google-cloud/firestore and
// @google-cloud/storage (~150 extra packages) purely to support Admin SDK
// features this app never uses — and installing it forced npm to
// re-resolve a wide swath of unrelated shared dependencies (down to
// mongodb's own @mongodb-js/saslprep) to older versions, breaking server
// startup entirely. This gets the same send capability with zero new
// dependencies: Node's built-in crypto module signs the standard Google
// service-account JWT bearer assertion (the same mechanism firebase-admin
// itself uses under the hood), exchanged for a short-lived OAuth2 access
// token, then POSTed straight to the FCM v1 REST endpoint.
const FIREBASE_SERVICE_ACCOUNT_JSON = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "";

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

let cachedServiceAccount: ServiceAccount | null = null;

function getServiceAccount(): ServiceAccount | null {
  if (cachedServiceAccount) return cachedServiceAccount;
  if (!FIREBASE_SERVICE_ACCOUNT_JSON) return null;
  cachedServiceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT_JSON);
  return cachedServiceAccount;
}

export function isFcmEnabled(): boolean {
  return Boolean(FIREBASE_SERVICE_ACCOUNT_JSON);
}

function base64url(input: Buffer | string): string {
  return (Buffer.isBuffer(input) ? input : Buffer.from(input))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// Standard Google service-account "self-signed JWT" bearer assertion —
// https://developers.google.com/identity/protocols/oauth2/service-account#authorizingrequests.
// Cached and reused until shortly before its 1-hour expiry.
let cachedAccessToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(account: ServiceAccount): Promise<string> {
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 60_000) {
    return cachedAccessToken.token;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = base64url(
    JSON.stringify({
      iss: account.client_email,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: nowSec,
      exp: nowSec + 3600,
    }),
  );
  const signature = base64url(createSign("RSA-SHA256").update(`${header}.${body}`).sign(account.private_key));
  const assertion = `${header}.${body}.${signature}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!res.ok) {
    throw new Error(`Failed to obtain FCM access token: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedAccessToken = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

// Fire-and-forget from notificationController.createNotification, same as
// sendPushToUser — a dispatch failure (or the feature being unconfigured)
// never blocks or fails notification creation.
export async function sendFcmToUser(userId: string, payload: PushPayload): Promise<void> {
  const account = getServiceAccount();
  if (!account) return;

  const subscriptions = await PushSubscription.find({
    user: userId,
    platform: { $ne: "web" },
    fcmToken: { $exists: true },
  }).lean();
  if (subscriptions.length === 0) return;

  const accessToken = await getAccessToken(account);

  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        const res = await fetch(
          `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              message: {
                token: sub.fcmToken,
                notification: { title: payload.title, body: payload.body },
                data: {
                  ...(payload.actionUrl ? { actionUrl: payload.actionUrl } : {}),
                  ...(payload.notificationId ? { notificationId: payload.notificationId } : {}),
                },
                android: { priority: "high" as const },
              },
            }),
          },
        );

        if (!res.ok) {
          const errBody: any = await res.json().catch(() => ({}));
          // FCM v1's documented signal that a token is dead (app
          // uninstalled, token rotated) — same pruning webPush.ts does for a
          // 404/410 Web Push response.
          if (errBody?.error?.status === "UNREGISTERED" || errBody?.error?.status === "NOT_FOUND") {
            await PushSubscription.deleteOne({ _id: sub._id }).catch(() => {});
          } else {
            console.error("FCM send failed for subscription", sub._id, res.status, errBody?.error?.status);
          }
        }
      } catch (err) {
        console.error("FCM send failed for subscription", sub._id, err);
      }
    }),
  );
}
