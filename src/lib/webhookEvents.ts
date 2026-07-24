import type { Server } from "socket.io";
import Webhook from "../models/Webhook.ts";
import WebhookEventLog from "../models/WebhookEventLog.ts";

// The full outgoing-webhook pipeline (delivery, WebhookEventLog, replay with
// audit trail in Integrations.tsx) already worked — it just only ever fired
// from a manual "Test Payload" click (grep confirmed postToWebhook/
// triggerWebhook were called from nowhere else). This is the missing piece:
// a canonical event name list plus real call sites.
export const WEBHOOK_EVENTS = [
  "message_created",
  "channel_created",
  "channel_deleted",
  "member_joined",
  "member_banned",
  "member_muted",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

async function postToWebhook(
  url: string,
  payload: unknown,
): Promise<{ status: "success" | "error"; error: string }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload ?? {}),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        status: "error",
        error: `Destination responded ${res.status} ${res.statusText}${body ? `: ${body.slice(0, 300)}` : ""}`,
      };
    }
    return { status: "success", error: "" };
  } catch (err: any) {
    return { status: "error", error: err?.message || "Failed to reach destination" };
  }
}

// Fire-and-forget from the caller (never awaited on the hot path — a message
// send / channel create / ban should never block on an external URL's
// response time). Finds every webhook on this server subscribed to `event`
// and delivers to each independently, logging + broadcasting exactly like
// the existing manual "Test Payload" trigger does.
export async function fireWebhooksForEvent(
  serverId: string,
  event: WebhookEvent,
  payload: unknown,
  io?: Server,
): Promise<void> {
  try {
    const webhooks = await Webhook.find({ server: serverId, events: event }).lean();
    if (webhooks.length === 0) return;

    await Promise.all(
      webhooks.map(async (webhook) => {
        const { status, error } = await postToWebhook(webhook.url, payload);
        await WebhookEventLog.create({
          webhookId: webhook._id,
          event,
          payload,
          status,
          error,
        });
        io?.to(serverId).emit("webhook:triggered", {
          serverId,
          webhookId: webhook._id.toString(),
          event,
          status,
        });
      }),
    );
  } catch (err) {
    console.error(`fireWebhooksForEvent failed for server ${serverId}, event ${event}:`, err);
  }
}
