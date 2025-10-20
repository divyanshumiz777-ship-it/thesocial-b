import { Context } from "hono";
import Bot from "../models/Bot.ts";
import Webhook from "../models/Webhook.ts";
import WebhookEventLog from "../models/WebhookEventLog.ts";

export const replayWebhookEvent = async (c: Context) => {
  const { logId } = c.req.param();
  const eventLog = await WebhookEventLog.findById(logId);
  if (!eventLog) return c.json({ error: "Event log not found" }, 404);
  const webhook = await Webhook.findById(eventLog.webhookId);
  if (!webhook) return c.json({ error: "Webhook not found" }, 404);
  let status = "success";
  let error = "";
  try {
    await fetch(webhook.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: eventLog.event,
        payload: eventLog.payload,
      }),
    });
  } catch (err: any) {
    status = "error";
    error = err?.message || "Failed to replay webhook event";
  }
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
  const { name, permissions } = await c.req.json();
  const owner = c.get("user")?.id;
  if (!name || !Array.isArray(permissions) || !owner) {
    return c.json({ error: "Invalid bot data" }, 400);
  }
  const bot = await Bot.create({ name, permissions, owner });
  return c.json({ message: "Bot created", bot }, 201);
};

export const listBots = async (c: Context) => {
  const owner = c.get("user")?.id;
  const bots = await Bot.find({ owner });
  return c.json({ bots }, 200);
};

export const deleteBot = async (c: Context) => {
  const { id } = c.req.param();
  const owner = c.get("user")?.id;
  const bot = await Bot.findOneAndDelete({ _id: id, owner });
  if (!bot) return c.json({ error: "Bot not found or unauthorized" }, 404);
  return c.json({ message: `Bot ${id} deleted` }, 200);
};

export const setBotPermissions = async (c: Context) => {
  const { id } = c.req.param();
  const { permissions } = await c.req.json();
  const owner = c.get("user")?.id;
  if (!Array.isArray(permissions))
    return c.json({ error: "Invalid permissions" }, 400);
  const bot = await Bot.findOneAndUpdate(
    { _id: id, owner },
    { permissions },
    { new: true }
  );
  if (!bot) return c.json({ error: "Bot not found or unauthorized" }, 404);
  console.log(`[AUDIT] Bot permissions updated`, {
    botId: id,
    owner,
    permissions,
  });
  return c.json({ message: `Permissions updated for bot ${id}`, bot }, 200);
};

export const createWebhook = async (c: Context) => {
  const { url, events } = await c.req.json();
  const owner = c.get("user")?.id;
  if (!url || !Array.isArray(events) || !owner) {
    return c.json({ error: "Invalid webhook data" }, 400);
  }
  const webhook = await Webhook.create({ url, events, owner });
  return c.json({ message: "Webhook created", webhook }, 201);
};

export const listWebhooks = async (c: Context) => {
  const owner = c.get("user")?.id;
  const webhooks = await Webhook.find({ owner });
  return c.json({ webhooks }, 200);
};

export const deleteWebhook = async (c: Context) => {
  const { id } = c.req.param();
  const owner = c.get("user")?.id;
  const webhook = await Webhook.findOneAndDelete({ _id: id, owner });
  if (!webhook)
    return c.json({ error: "Webhook not found or unauthorized" }, 404);
  return c.json({ message: `Webhook ${id} deleted` }, 200);
};

export const triggerWebhook = async (c: Context) => {
  const { id } = c.req.param();
  const { event, payload } = await c.req.json();
  const webhook = await Webhook.findById(id);
  if (!webhook || !webhook.events.includes(event)) {
    return c.json({ error: "Webhook or event not found" }, 404);
  }
  let status = "success";
  let error = "";
  try {
    await fetch(webhook.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, payload }),
    });
  } catch (err: any) {
    status = "error";
    error = err?.message || "Failed to trigger webhook";
  }
  await WebhookEventLog.create({
    webhookId: webhook._id,
    event,
    payload,
    status,
    error,
  });
  if (status === "success") {
    return c.json(
      { message: `Webhook ${id} triggered for event ${event}` },
      200
    );
  } else {
    return c.json({ error }, 500);
  }
};
