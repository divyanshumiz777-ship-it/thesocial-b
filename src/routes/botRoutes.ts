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
  getWebhookEventLogs,
} from "../controllers/botController.ts";

import { authMiddleware } from "../middleware/authMiddleware.ts";
import { validateInput } from "../middleware/validateInput.ts";

export const botRouter = new Hono();

botRouter.post(
  "/webhook-event-logs/:logId/replay",
  authMiddleware,
  replayWebhookEvent
);
botRouter.get(
  "/webhook-event-logs/:serverId",
  authMiddleware,
  getWebhookEventLogs
);
botRouter.post(
  "/bot",
  authMiddleware,
  validateInput(["name", "permissions", "serverId"]),
  createBot
);
botRouter.get("/bots/:serverId", authMiddleware, listBots);
botRouter.delete("/bot/:id", authMiddleware, deleteBot);
botRouter.post("/bot/:id/permissions", authMiddleware, setBotPermissions);

botRouter.post(
  "/webhook",
  authMiddleware,
  validateInput(["url", "events", "serverId"]),
  createWebhook
);
botRouter.get("/webhooks/:serverId", authMiddleware, listWebhooks);
botRouter.delete("/webhook/:id", authMiddleware, deleteWebhook);
botRouter.post("/webhook/:id/trigger", authMiddleware, triggerWebhook);
