import { Hono } from "hono";
import {
  getAllServers,
  getServer,
  createServer,
  editServer,
  deleteServer,
  editMemberRole,
  addMember,
  removeMember,
} from "../controllers/serverController.ts";

export const serverRouter = new Hono();

serverRouter.get("/all-servers", getAllServers);
serverRouter.get("/get-server/:id", getServer);
serverRouter.post("/create-server", createServer);
serverRouter.delete("delete-server/:id", deleteServer);
serverRouter.put("/edit-server/:id", editServer);
serverRouter.put("/edit-member-role/:serverId", editMemberRole);
serverRouter.put("/add-member/:serverId", addMember);
serverRouter.put("/remove-member/:serverId", removeMember);
