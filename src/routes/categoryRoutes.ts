import { Hono } from "hono";
import {
  createCategory,
  getCategories,
  updateCategory,
  deleteCategory,
} from "../controllers/categoryController.ts";
import { authMiddleware } from "../middleware/authMiddleware.ts";

export const categoryRouter = new Hono();

categoryRouter.use(authMiddleware);

categoryRouter.post("/create-category/:serverId", createCategory);
categoryRouter.get("/:serverId", getCategories);
categoryRouter.put("/:categoryId", updateCategory);
categoryRouter.delete("/:categoryId", deleteCategory);
