import { Hono } from "hono";
import { authMiddleware } from "../middleware/authMiddleware.ts";

import {
  createChannel,
  getChannels,
  updateChannel,
  deleteChannel,
  searchChannels,
} from "../controllers/channelController.ts";

export const channelRouter = new Hono();

channelRouter.get("/search", searchChannels);
channelRouter.post("/create-channel/:serverId", authMiddleware, createChannel);
channelRouter.get("/:serverId", getChannels);
channelRouter.put("/:channelId", authMiddleware, updateChannel);
channelRouter.delete("/:channelId", authMiddleware, deleteChannel);
