import { Context } from "hono";
import Category from "../models/Category.ts";
import Channel from "../models/Channel.ts";
import Message from "../models/Message.ts";
import DiscordServer from "../models/DiscordServer.ts";
import mongoose from "mongoose";
import { invalidateAfterServerUpdate } from "../lib/cacheInvalidation.ts";

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

    await invalidateAfterServerUpdate(serverId);

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

    await invalidateAfterServerUpdate(updatedCategory.server.toString());

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

  if (!mongoose.Types.ObjectId.isValid(categoryId)) {
    return c.json({ error: "Invalid category ID format" }, 400);
  }

  const session = await mongoose.startSession();
  let deletedServerId: string | null = null;
  try {
    await session.withTransaction(async () => {
      const category = await Category.findById(categoryId).session(session);
      if (!category) {
        throw Object.assign(new Error("Category not found"), { status: 404 });
      }
      deletedServerId = category.server.toString();

      const channels = await Channel.find({ category: categoryId }, "_id").session(session);
      const channelIds = channels.map((ch) => ch._id);

      if (channelIds.length > 0) {
        await Message.deleteMany({ channel: { $in: channelIds } }).session(session);
        await Channel.deleteMany({ category: categoryId }).session(session);
      }

      await DiscordServer.updateOne(
        { categories: categoryId },
        { $pull: { categories: new mongoose.Types.ObjectId(categoryId) } }
      ).session(session);

      await Category.findByIdAndDelete(categoryId).session(session);
    });

    // Outside the transaction (already committed) — cache invalidation
    // isn't itself transactional/revertible, and doesn't need to be, since
    // the Mongo delete is the source of truth either way.
    if (deletedServerId) await invalidateAfterServerUpdate(deletedServerId);

    return c.json({ message: "Category deleted successfully" });
  } catch (error: any) {
    console.error("Error deleting category:", error);
    if (error.status === 404) {
      return c.json({ error: "Category not found" }, 404);
    }
    return c.json({ error: "Internal server error" }, 500);
  } finally {
    await session.endSession();
  }
};
