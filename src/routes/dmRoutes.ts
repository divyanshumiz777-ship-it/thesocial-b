import { Hono } from "hono";

import {
  createDm,
  getDm,
  editMessage,
  deleteMessage,
  deleteDm,
  toggleReaction,
  hideConversation,
  unhideConversation,
  deleteConversationForUser,
  blockUser,
  unblockUser,
  getBlockedUsers,
} from "../controllers/dmController.ts";
import groupDmController from "../controllers/groupDmController.ts";
import { authMiddleware } from "../middleware/authMiddleware.ts";

export const dmRouter = new Hono();

dmRouter.post("/create-dm", authMiddleware, createDm);
dmRouter.get("/get-dm/:conversationId", authMiddleware, getDm);
dmRouter.put("/edit-message/:conversationId", authMiddleware, editMessage);
dmRouter.put("/delete-message/:conversationId", authMiddleware, deleteMessage);
dmRouter.delete("/delete-dm/:conversationId", authMiddleware, deleteDm);
dmRouter.put("/add-reaction/:messageId", authMiddleware, toggleReaction);
dmRouter.put(
  "/hide-conversation/:conversationId",
  authMiddleware,
  hideConversation
);
dmRouter.put(
  "/unhide-conversation/:conversationId",
  authMiddleware,
  unhideConversation
);
dmRouter.delete(
  "/delete-conversation/:conversationId",
  authMiddleware,
  deleteConversationForUser
);
dmRouter.post("/block-user/:userId", authMiddleware, blockUser);
dmRouter.delete("/unblock-user/:userId", authMiddleware, unblockUser);
dmRouter.get("/blocked-users", authMiddleware, getBlockedUsers);
dmRouter.route("/groups", groupDmController);
