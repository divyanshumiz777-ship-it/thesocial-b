import webpush from "web-push";
import { PushSubscription } from "../models/PushSubscription.ts";

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:support@example.com";

export function isPushEnabled(): boolean {
  return Boolean(VAPID_PUBLIC_KEY) && Boolean(VAPID_PRIVATE_KEY);
}

if (isPushEnabled()) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

export function getVapidPublicKey(): string | null {
  return isPushEnabled() ? VAPID_PUBLIC_KEY : null;
}

export interface PushPayload {
  title: string;
  body: string;
  actionUrl?: string;
  notificationId?: string;
}

// Fire-and-forget from notificationController.createNotification — a push
// failure (or the feature being disabled entirely, VAPID keys unset) never
// blocks or fails notification creation itself; the in-app notification
// (REST + socket) always exists independent of push delivery succeeding.
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<void> {
  if (!isPushEnabled()) return;

  // platform:"web" (or absent, for docs predating the field) is what has an
  // endpoint/keys pair at all — native (FCM) subscriptions are a separate
  // schema shape, dispatched instead by fcmPush.ts's sendFcmToUser.
  const subscriptions = await PushSubscription.find({
    user: userId,
    endpoint: { $exists: true },
  }).lean();
  if (subscriptions.length === 0) return;

  const body = JSON.stringify(payload);

  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint as string, keys: sub.keys as { p256dh: string; auth: string } },
          body,
          // No options object at all previously — push services default to
          // urgency "normal", which Android/Chrome's FCM backend is allowed
          // to defer under Doze/battery-saver instead of waking the device
          // immediately. "high" is the documented signal for "the user is
          // waiting on this now" (a new message/call, as opposed to e.g. a
          // digest), matching what every other real chat app requests for
          // this class of notification. TTL bounds how long the push
          // service holds it for an offline device — long enough to
          // reliably survive a brief connectivity gap, short enough that a
          // days-old "new message" ping never suddenly arrives stale.
          { urgency: "high", TTL: 60 * 60 * 24 },
        );
      } catch (err: any) {
        // 404/410 = the browser/OS revoked this subscription (uninstalled,
        // permission reset, expired) — Web Push's own documented signal to
        // stop sending to it, not a transient failure worth retrying.
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          await PushSubscription.deleteOne({ _id: sub._id }).catch(() => {});
        } else {
          console.error("Push send failed for subscription", sub._id, err?.statusCode || err);
        }
      }
    }),
  );
}
