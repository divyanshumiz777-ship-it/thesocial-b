import { Hono } from "hono";
import {
  searchMessages,
  getMessagesByChannelId,
  createMessage,
  deleteMessage,
  updateMessage,
  toggleReaction,
  updateLastReadMessage,
  getLastReadMessage,
} from "../controllers/messageController.ts";
import { authMiddleware } from "../middleware/authMiddleware.ts";
export const messageRouter = new Hono();

messageRouter.get("/search/:channelId", searchMessages);
messageRouter.get("/get-messages/:channelId", getMessagesByChannelId);
messageRouter.post("/create-message/:channelId", authMiddleware, createMessage);
messageRouter.delete("/delete-message/:messageId", deleteMessage);
messageRouter.put("/update-message/:messageId", authMiddleware, updateMessage);
messageRouter.put("/add-reaction/:messageId", toggleReaction);
messageRouter.put(
  "/last-read/:channelId",
  authMiddleware,
  updateLastReadMessage
);
messageRouter.get("/last-read/:channelId", authMiddleware, getLastReadMessage);
