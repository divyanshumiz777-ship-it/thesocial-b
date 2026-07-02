import { Hono } from "hono";

import {
  createDm,
  findOrRestoreDm,
  getDm,
  editMessage,
  deleteMessage,
  deleteDm,
  toggleReaction,
  hideConversation,
  unhideConversation,
  getHiddenConversations,
  deleteConversationForUser,
  clearConversation,
  blockUser,
  unblockUser,
  getBlockedUsers,
  markConversationRead,
  markConversationDelivered,
  getConvStatus,
  getConversationFiles,
  getConversationMuteStatus,
  setConversationMute,
  getConversationTheme,
  setConversationTheme,
} from "../controllers/dmController.ts";
import groupDmController from "../controllers/groupDmController.ts";
import { authMiddleware } from "../middleware/authMiddleware.ts";

export const dmRouter = new Hono();

dmRouter.post("/create-dm", authMiddleware, createDm);
dmRouter.post("/find-or-restore-dm", authMiddleware, findOrRestoreDm);
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
dmRouter.get("/hidden-conversations", authMiddleware, getHiddenConversations);
dmRouter.delete(
  "/delete-conversation/:conversationId",
  authMiddleware,
  deleteConversationForUser
);
dmRouter.put(
  "/clear-conversation/:conversationId",
  authMiddleware,
  clearConversation
);
dmRouter.put(
  "/mark-read/:conversationId",
  authMiddleware,
  markConversationRead
);
dmRouter.put(
  "/mark-delivered/:conversationId",
  authMiddleware,
  markConversationDelivered
);
dmRouter.get(
  "/conv-status/:conversationId",
  authMiddleware,
  getConvStatus
);
dmRouter.get("/files/:conversationId", authMiddleware, getConversationFiles);
dmRouter.get(
  "/mute-status/:conversationId",
  authMiddleware,
  getConversationMuteStatus
);
dmRouter.put("/mute/:conversationId", authMiddleware, setConversationMute);
dmRouter.get(
  "/theme/:conversationId",
  authMiddleware,
  getConversationTheme
);
dmRouter.put("/theme/:conversationId", authMiddleware, setConversationTheme);
dmRouter.post("/block-user/:userId", authMiddleware, blockUser);
dmRouter.delete("/unblock-user/:userId", authMiddleware, unblockUser);
dmRouter.get("/blocked-users", authMiddleware, getBlockedUsers);
dmRouter.route("/groups", groupDmController);
