import { Hono } from "hono";
import {
  createCategory,
  getCategories,
  updateCategory,
  deleteCategory,
} from "../controllers/categoryController.ts";

export const categoryRouter = new Hono();

categoryRouter.post("/create-category/:serverId", createCategory);
categoryRouter.get("/:serverId", getCategories);
categoryRouter.put("/:categoryId", updateCategory);
categoryRouter.delete("/:categoryId", deleteCategory);
