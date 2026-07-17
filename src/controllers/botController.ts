import { Context } from "hono";
import { Server } from "socket.io";
import Bot from "../models/Bot.ts";
import Webhook from "../models/Webhook.ts";
import WebhookEventLog from "../models/WebhookEventLog.ts";
import { checkPermission } from "../lib/permissionHelper.ts";
import ServerMember from "../models/ServerMember.ts";
import DiscordServer from "../models/DiscordServer.ts";

/**
 * Bots/webhooks are server-scoped resources (surfaced in a server's
 * Integrations settings tab) — every mutation requires the acting user to be
 * that server's owner or an admin, not just "any authenticated user who
 * happens to know the record's id" (the previous owner-only check).
 */
async function requireServerAdmin(serverId: string, userId: string): Promise<boolean> {
  return checkPermission(serverId, userId, "admin");
}

async function isServerMember(serverId: string, userId: string): Promise<boolean> {
  const server = await DiscordServer.findById(serverId).select("owner").lean();
  if (!server) return false;
  if (server.owner.toString() === userId) return true;
  return !!(await ServerMember.exists({ server: serverId, user: userId }));
}

/**
 * POSTs the payload AS-IS (not wrapped in an {event, payload} envelope) —
 * most real destinations (Discord/Slack incoming webhooks, Zapier catch
 * hooks) expect their own specific top-level shape (Discord: `content` or
 * `embeds`) and have no idea what to do with a foreign wrapper object.
 * Also treats a non-2xx response as a real failure: `fetch()` only rejects
 * on a network-level error, so a destination that rejects the payload with
 * 400/404/etc used to be silently recorded as "success".
 */
async function postToWebhook(
  url: string,
  payload: unknown
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

export const replayWebhookEvent = async (c: Context) => {
  const { logId } = c.req.param();
  const userId = c.get("user")?.id;
  const eventLog = await WebhookEventLog.findById(logId);
  if (!eventLog) return c.json({ error: "Event log not found" }, 404);
  const webhook = await Webhook.findById(eventLog.webhookId);
  if (!webhook) return c.json({ error: "Webhook not found" }, 404);
  if (!(await requireServerAdmin(webhook.server.toString(), userId))) {
    return c.json({ error: "Permission denied" }, 403);
  }

  const { status, error } = await postToWebhook(webhook.url, eventLog.payload);
  await WebhookEventLog.create({
    webhookId: webhook._id,
    event: eventLog.event,
    payload: eventLog.payload,
    status,
    error,
  });
  if (status === "success") {
    return c.json({ message: `Webhook event replayed for log ${logId}` }, 200);
  } else {
    return c.json({ error }, 500);
  }
};

export const createBot = async (c: Context) => {
  const { name, permissions, serverId } = await c.req.json();
  const owner = c.get("user")?.id;
  if (!name || !Array.isArray(permissions) || !owner || !serverId) {
    return c.json({ error: "Invalid bot data" }, 400);
  }
  if (!(await requireServerAdmin(serverId, owner))) {
    return c.json({ error: "Permission denied" }, 403);
  }
  const bot = await Bot.create({ name, permissions, owner, server: serverId });

  const io = c.get("io") as Server | undefined;
  if (io) io.to(serverId.toString()).emit("bot:created", { serverId, bot });

  return c.json({ message: "Bot created", bot }, 201);
};

export const listBots = async (c: Context) => {
  const { serverId } = c.req.param();
  const userId = c.get("user")?.id;
  if (!(await isServerMember(serverId, userId))) {
    return c.json({ error: "Permission denied" }, 403);
  }
  const bots = await Bot.find({ server: serverId });
  return c.json({ bots }, 200);
};

export const deleteBot = async (c: Context) => {
  const { id } = c.req.param();
  const userId = c.get("user")?.id;
  const bot = await Bot.findById(id);
  if (!bot) return c.json({ error: "Bot not found" }, 404);
  if (!(await requireServerAdmin(bot.server.toString(), userId))) {
    return c.json({ error: "Bot not found or unauthorized" }, 404);
  }
  await Bot.findByIdAndDelete(id);

  const io = c.get("io") as Server | undefined;
  if (io) {
    io.to(bot.server.toString()).emit("bot:deleted", {
      serverId: bot.server.toString(),
      botId: id,
    });
  }

  return c.json({ message: `Bot ${id} deleted` }, 200);
};

export const setBotPermissions = async (c: Context) => {
  const { id } = c.req.param();
  const { permissions } = await c.req.json();
  const userId = c.get("user")?.id;
  if (!Array.isArray(permissions))
    return c.json({ error: "Invalid permissions" }, 400);
  const existing = await Bot.findById(id);
  if (!existing) return c.json({ error: "Bot not found" }, 404);
  if (!(await requireServerAdmin(existing.server.toString(), userId))) {
    return c.json({ error: "Bot not found or unauthorized" }, 404);
  }
  const bot = await Bot.findByIdAndUpdate(id, { permissions }, { new: true });
  console.log(`[AUDIT] Bot permissions updated`, {
    botId: id,
    updatedBy: userId,
    permissions,
  });

  const io = c.get("io") as Server | undefined;
  if (io) {
    io.to(existing.server.toString()).emit("bot:updated", {
      serverId: existing.server.toString(),
      bot,
    });
  }

  return c.json({ message: `Permissions updated for bot ${id}`, bot }, 200);
};

export const createWebhook = async (c: Context) => {
  const { url, events, serverId } = await c.req.json();
  const owner = c.get("user")?.id;
  if (!url || !Array.isArray(events) || !owner || !serverId) {
    return c.json({ error: "Invalid webhook data" }, 400);
  }
  if (!(await requireServerAdmin(serverId, owner))) {
    return c.json({ error: "Permission denied" }, 403);
  }
  const webhook = await Webhook.create({ url, events, owner, server: serverId });

  const io = c.get("io") as Server | undefined;
  if (io) io.to(serverId.toString()).emit("webhook:created", { serverId, webhook });

  return c.json({ message: "Webhook created", webhook }, 201);
};

export const listWebhooks = async (c: Context) => {
  const { serverId } = c.req.param();
  const userId = c.get("user")?.id;
  if (!(await isServerMember(serverId, userId))) {
    return c.json({ error: "Permission denied" }, 403);
  }
  const webhooks = await Webhook.find({ server: serverId });
  return c.json({ webhooks }, 200);
};

export const deleteWebhook = async (c: Context) => {
  const { id } = c.req.param();
  const userId = c.get("user")?.id;
  const webhook = await Webhook.findById(id);
  if (!webhook) return c.json({ error: "Webhook not found" }, 404);
  if (!(await requireServerAdmin(webhook.server.toString(), userId))) {
    return c.json({ error: "Webhook not found or unauthorized" }, 404);
  }
  await Webhook.findByIdAndDelete(id);

  const io = c.get("io") as Server | undefined;
  if (io) {
    io.to(webhook.server.toString()).emit("webhook:deleted", {
      serverId: webhook.server.toString(),
      webhookId: id,
    });
  }

  return c.json({ message: `Webhook ${id} deleted` }, 200);
};

export const triggerWebhook = async (c: Context) => {
  const { id } = c.req.param();
  const { event, payload } = await c.req.json();
  const userId = c.get("user")?.id;
  const webhook = await Webhook.findById(id);
  if (!webhook || !webhook.events.includes(event)) {
    return c.json({ error: "Webhook or event not found" }, 404);
  }
  if (!(await requireServerAdmin(webhook.server.toString(), userId))) {
    return c.json({ error: "Permission denied" }, 403);
  }
  const { status, error } = await postToWebhook(webhook.url, payload);
  await WebhookEventLog.create({
    webhookId: webhook._id,
    event,
    payload,
    status,
    error,
  });

  const io = c.get("io") as Server | undefined;
  if (io) {
    io.to(webhook.server.toString()).emit("webhook:triggered", {
      serverId: webhook.server.toString(),
      webhookId: id,
      event,
      status,
    });
  }

  if (status === "success") {
    return c.json(
      { message: `Webhook ${id} triggered for event ${event}` },
      200
    );
  } else {
    return c.json({ error }, 500);
  }
};

export const getWebhookEventLogs = async (c: Context) => {
  const { serverId } = c.req.param();
  const userId = c.get("user")?.id;
  if (!(await requireServerAdmin(serverId, userId))) {
    return c.json({ error: "Permission denied" }, 403);
  }
  const { event, status } = c.req.query();
  const webhookIds = await Webhook.find({ server: serverId }).distinct("_id");
  const query: any = { webhookId: { $in: webhookIds } };
  if (event) query.event = event;
  if (status) query.status = status;
  const logs = await WebhookEventLog.find(query)
    .sort({ triggeredAt: -1 })
    .limit(100);
  return c.json({ logs }, 200);
};
