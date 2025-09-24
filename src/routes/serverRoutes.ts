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
  acceptInvite,
  searchServers,
  getServerById,
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
serverRouter.post("/create-invite/:serverId", createInvite);
serverRouter.put("/accept-invite/:serverId", acceptInvite);
