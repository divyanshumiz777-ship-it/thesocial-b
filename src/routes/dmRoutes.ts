import { Hono } from "hono";

import {
  createDm,
  getDm,
  editMessage,
  deleteMessage,
  deleteDm,
  toggleReaction,
} from "../controllers/dmController.ts";
import groupDmController from "../controllers/groupDmController.ts";

export const dmRouter = new Hono();

dmRouter.post("/create-dm", createDm);
dmRouter.get("/get-dm/:conversationId", getDm);
dmRouter.put("/edit-message/:conversationId", editMessage);
dmRouter.put("/delete-message/:conversationId", deleteMessage);
dmRouter.delete("/delete-dm/:conversationId", deleteDm);
dmRouter.put("/add-reaction/:messageId", toggleReaction);
dmRouter.route("/groups", groupDmController);
