import { Hono } from "hono";
import {
  createBot,
  listBots,
  deleteBot,
  createWebhook,
  listWebhooks,
  deleteWebhook,
  triggerWebhook,
  setBotPermissions,
  replayWebhookEvent,
} from "../controllers/botController.ts";
import WebhookEventLog from "../models/WebhookEventLog.ts";

import { authMiddleware } from "../middleware/authMiddleware.ts";
import { validateInput } from "../middleware/validateInput.ts";

export const botRouter = new Hono();

botRouter.post(
  "/webhook-event-logs/:logId/replay",
  authMiddleware,
  replayWebhookEvent
);
botRouter.get("/webhook-event-logs", authMiddleware, async (c) => {
  const jwtPayload = c.get("jwtPayload");
  const ownerId = jwtPayload?.id;
  const { event, status } = c.req.query();
  const query: any = {};
  if (event) query.event = event;
  if (status) query.status = status;
  if (ownerId) query["owner"] = ownerId;
  const logs = await WebhookEventLog.find(query)
    .sort({ triggeredAt: -1 })
    .limit(100);
  return c.json({ logs }, 200);
});
botRouter.post(
  "/bot",
  authMiddleware,
  validateInput(["name", "permissions"]),
  createBot
);
botRouter.get("/bots", authMiddleware, listBots);
botRouter.delete("/bot/:id", authMiddleware, deleteBot);
botRouter.post("/bot/:id/permissions", authMiddleware, setBotPermissions);

botRouter.post(
  "/webhook",
  authMiddleware,
  validateInput(["url", "events"]),
  createWebhook
);
botRouter.get("/webhooks", authMiddleware, listWebhooks);
botRouter.delete("/webhook/:id", authMiddleware, deleteWebhook);
botRouter.post("/webhook/:id/trigger", triggerWebhook);
