import { Hono } from "hono";

import {
  createThread,
  getThreads,
  updateThread,
  deleteThread,
  toggleReaction,
  createMessage,
  getMessages,
  deleteMessage,
  updateMessage,
} from "../controllers/threadController.ts";

export const threadRouter = new Hono();

threadRouter.post("/create-thread/:channelId", createThread);
threadRouter.get("/:channelId", getThreads);
threadRouter.put("/update-thread/:threadId", updateThread);
threadRouter.delete("/:threadId", deleteThread);
threadRouter.put("/add-reaction/:threadId", toggleReaction);
threadRouter.put("/add-message/:threadId", createMessage);
threadRouter.get("/get-messages/:threadId", getMessages);
threadRouter.delete("/delete-message/:messageId", deleteMessage);
threadRouter.put("/update-message/:messageId", updateMessage);
