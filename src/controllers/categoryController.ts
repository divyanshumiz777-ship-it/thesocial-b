import { Context } from "hono";
import Category from "../models/Category.ts";
import DiscordServer from "../models/DiscordServer.ts";
import mongoose from "mongoose";

export const createCategory = async (c: Context) => {
  const { serverId } = c.req.param();
  const body = await c.req.json();
  const { name } = body;
  try {
    const category = new Category({
      name,
      server: serverId,
    });
    const server = await DiscordServer.findById(serverId);
    if (!server) {
      return c.json({ error: "Server not found" }, 404);
    }
    await category.save();
    server.categories.push(category._id);
    await server.save();
    return c.json({
      message: "Category created successfully",
      category,
    });
  } catch (error) {
    console.error("Error creating category:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};
export const updateCategory = async (c: Context) => {
  const { categoryId } = c.req.param();
  const body = await c.req.json();
  const { name } = body;

  if (!mongoose.Types.ObjectId.isValid(categoryId)) {
    return c.json({ error: "Invalid category ID format" }, 400);
  }

  try {
    const updatedCategory = await Category.findByIdAndUpdate(
      categoryId,
      { name },
      { new: true }
    );

    if (!updatedCategory) {
      return c.json({ error: "Category not found" }, 404);
    }

    return c.json({
      message: "Category updated successfully",
      category: updatedCategory,
    });
  } catch (error) {
    console.error("Error updating category:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};
export const getCategories = async (c: Context) => {
  const { serverId } = c.req.param();

  if (!mongoose.Types.ObjectId.isValid(serverId)) {
    return c.json({ error: "Invalid server ID format" }, 400);
  }

  try {
    const categories = await Category.find({ server: serverId }).populate(
      "channels"
    );
    return c.json({ categories });
  } catch (error) {
    console.error("Error fetching categories:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};
export const deleteCategory = async (c: Context) => {
  const { categoryId } = c.req.param();
  try {
    await Category.findByIdAndDelete(categoryId);
    return c.json({ message: "Category deleted successfully" });
  } catch (error) {
    console.error("Error deleting category:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};
