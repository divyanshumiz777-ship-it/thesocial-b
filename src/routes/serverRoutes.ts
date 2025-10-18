import { Hono } from "hono";
import {
  getAllServers,
  createServer,
  editServer,
  deleteServer,
  editMemberRole,
  addMember,
  removeMember,
  banMember,
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
} from "../controllers/serverController.ts";
import { authMiddleware } from "../middleware/authMiddleware.ts";

export const serverRouter = new Hono();

serverRouter.post("/create-server", authMiddleware, createServer);
serverRouter.get("/all-servers", getAllServers);
serverRouter.get("/get-server/:id", authMiddleware, getServerById);
serverRouter.get("/search-servers", searchServers);
serverRouter.delete("delete-server/:id", deleteServer);
serverRouter.put("/edit-server/:id", editServer);
serverRouter.put("/edit-member-role/:serverId", editMemberRole);
serverRouter.put("/add-member/:serverId", addMember);
serverRouter.put("/remove-member/:serverId", removeMember);
serverRouter.put("/ban-member/:serverId", banMember);
serverRouter.put("/unBan-member/:serverId", unBanMember);
serverRouter.put("/mute-member/:serverId", muteMember);
serverRouter.put("/unmute-member/:serverId", unmuteMember);
serverRouter.post("/create-invite/:serverId", authMiddleware, createInvite);
serverRouter.get("/:serverId/invites", authMiddleware, getServerInvites);
serverRouter.delete("/delete-invite/:inviteId", authMiddleware, deleteInvite);
serverRouter.put("/accept-invite/:serverId", acceptInvite);

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
