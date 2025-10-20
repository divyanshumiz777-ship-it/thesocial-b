import { Hono } from "hono";
import {
  getAuditLogs,
  kickUser,
  getAllServers,
  createServer,
  editServer,
  deleteServer,
  editMemberRole,
  addMember,
  banMember,
  removeMember,
  unBanMember,
  muteMember,
  unmuteMember,
  createInvite,
  getServerInvites,
  deleteInvite,
  acceptInvite,
  searchServers,
  getServerById,
  requestJoinServer,
  getJoinRequests,
  approveJoinRequest,
  rejectJoinRequest,
  cancelJoinRequest,
  getUnreadCounts,
} from "../controllers/serverController.ts";
import { authMiddleware } from "../middleware/authMiddleware.ts";

export const serverRouter = new Hono();

serverRouter.get("/search", searchServers);
serverRouter.get("/search-servers", searchServers);
serverRouter.get("/audit-logs/:serverId", authMiddleware, getAuditLogs);
serverRouter.put("/kick-user/:serverId/:userId", authMiddleware, kickUser);
serverRouter.post("/create-server", authMiddleware, createServer);
serverRouter.get("/all-servers", getAllServers);
serverRouter.get("/get-server/:id", authMiddleware, getServerById);

serverRouter.delete("/delete-server/:serverId", authMiddleware, deleteServer);
serverRouter.put("/edit-server/:serverId", authMiddleware, editServer);
serverRouter.put("/edit-member-role/:serverId", authMiddleware, editMemberRole);
serverRouter.put("/add-member/:serverId", addMember);
serverRouter.put("/remove-member/:serverId", removeMember);
serverRouter.put("/ban-member/:serverId", banMember);
serverRouter.put("/unBan-member/:serverId", unBanMember);
serverRouter.put("/mute-member/:serverId", muteMember);
serverRouter.put("/unmute-member/:serverId", unmuteMember);
serverRouter.post("/create-invite/:serverId", authMiddleware, createInvite);
serverRouter.get("/:serverId/invites", authMiddleware, getServerInvites);
serverRouter.delete("/delete-invite/:inviteId", authMiddleware, deleteInvite);
serverRouter.put("/accept-invite/:inviteCode", authMiddleware, acceptInvite);

serverRouter.post("/:serverId/request-join", authMiddleware, requestJoinServer);
serverRouter.delete(
  "/:serverId/cancel-join",
  authMiddleware,
  cancelJoinRequest
);
serverRouter.get("/:serverId/join-requests", authMiddleware, getJoinRequests);
serverRouter.post(
  "/:serverId/approve-join",
  authMiddleware,
  approveJoinRequest
);
serverRouter.post("/:serverId/reject-join", authMiddleware, rejectJoinRequest);
serverRouter.get("/:serverId/unread-counts", authMiddleware, getUnreadCounts);
