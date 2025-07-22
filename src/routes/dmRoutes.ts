import { Hono } from "hono";

import {
  createDm,
  getDm,
  editMessage,
  deleteMessage,
  deleteDm,
  toggleReaction,
} from "../controllers/dmController.ts";

export const dmRouter = new Hono();

dmRouter.post("/create-dm", createDm);
dmRouter.get("/get-dm/:conversationId", getDm);
dmRouter.put("/dm/edit-message/:conversationId", editMessage);
dmRouter.put("/dm/delete-message/:conversationId", deleteMessage);
dmRouter.delete("/delete-dm/:conversationId", deleteDm);
dmRouter.put("/dm/add-reaction/:messageId", toggleReaction);
