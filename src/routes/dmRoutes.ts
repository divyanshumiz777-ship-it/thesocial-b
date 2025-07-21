import { Hono } from "hono";

import {
  createDm,
  getDm,
  editMessage,
  deleteMessage,
  deleteDm,
} from "../controllers/dmController.ts";

export const dmRouter = new Hono();

dmRouter.post("/create-dm", createDm);
dmRouter.get("/get-dm/:id", getDm);
dmRouter.put("/dm/edit-message/:id", editMessage);
dmRouter.put("/dm/delete-message/:id", deleteMessage);
dmRouter.delete("/delete-dm/:id", deleteDm);
