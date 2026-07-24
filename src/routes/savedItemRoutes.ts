import { Hono } from "hono";
import { authMiddleware } from "../middleware/authMiddleware.ts";
import { saveItem, unsaveItem, getSavedItems } from "../controllers/savedItemController.ts";

const savedItemRoutes = new Hono();

savedItemRoutes.use(authMiddleware);
savedItemRoutes.get("/", getSavedItems);
savedItemRoutes.post("/", saveItem);
savedItemRoutes.delete("/:itemType/:itemId", unsaveItem);

export default savedItemRoutes;
