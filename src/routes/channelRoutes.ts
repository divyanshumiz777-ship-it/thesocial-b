import { Hono } from "hono";

import {
  createChannel,
  getChannels,
  updateChannel,
  deleteChannel,
} from "../controllers/channelController.ts";

export const channelRouter = new Hono();

channelRouter.post("/create-channel/:serverId", createChannel);
channelRouter.get("/:serverId", getChannels);
channelRouter.put("/:channelId", updateChannel);
channelRouter.delete("/:channelId", deleteChannel);
