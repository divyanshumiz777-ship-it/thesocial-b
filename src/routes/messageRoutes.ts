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
import {
  togglePinMessage,
  getPinnedMessages,
  markMessageAsRead,
  markMessagesAsRead,
} from "../controllers/featureController.ts";
import { forwardMessage, getForwardTargets } from "../controllers/forwardController.ts";
import { authMiddleware } from "../middleware/authMiddleware.ts";
export const messageRouter = new Hono();

messageRouter.get("/search/:channelId", searchMessages);
messageRouter.get(
  "/get-messages/:channelId",
  authMiddleware,
  getMessagesByChannelId,
);
messageRouter.post("/create-message/:channelId", authMiddleware, createMessage);
messageRouter.delete("/delete-message/:messageId", authMiddleware, deleteMessage);
messageRouter.put("/update-message/:messageId", authMiddleware, updateMessage);
messageRouter.put("/add-reaction/:messageId", authMiddleware, toggleReaction);
messageRouter.put(
  "/last-read/:channelId",
  authMiddleware,
  updateLastReadMessage,
);
messageRouter.get("/last-read/:channelId", authMiddleware, getLastReadMessage);

messageRouter.put("/pin/:messageId", authMiddleware, togglePinMessage);
messageRouter.get("/pinned", authMiddleware, getPinnedMessages);
messageRouter.put("/mark-read/:messageId", authMiddleware, markMessageAsRead);
messageRouter.post("/mark-read-bulk", authMiddleware, markMessagesAsRead);
messageRouter.get("/forward-targets", authMiddleware, getForwardTargets);
messageRouter.post("/:messageId/forward", authMiddleware, forwardMessage);
