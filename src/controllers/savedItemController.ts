import { Context } from "hono";
import mongoose from "mongoose";
import SavedItem from "../models/SavedItem.ts";

export const saveItem = async (c: Context) => {
  try {
    const me = c.get("user");
    const body = await c.req.json().catch(() => ({}));
    const { itemType, itemId, serverId, channelId, conversationId, snippet } = body as {
      itemType?: string;
      itemId?: string;
      serverId?: string;
      channelId?: string;
      conversationId?: string;
      snippet?: string;
    };

    if (!itemType || !["message", "reel"].includes(itemType)) {
      return c.json({ error: "itemType must be message or reel" }, 400);
    }
    if (!itemId || !mongoose.Types.ObjectId.isValid(itemId)) {
      return c.json({ error: "Invalid itemId" }, 400);
    }

    const saved = await SavedItem.findOneAndUpdate(
      { user: me.id, itemType, itemId },
      {
        $setOnInsert: {
          user: me.id,
          itemType,
          itemId,
          serverId: serverId && mongoose.Types.ObjectId.isValid(serverId) ? serverId : undefined,
          channelId: channelId && mongoose.Types.ObjectId.isValid(channelId) ? channelId : undefined,
          conversationId:
            conversationId && mongoose.Types.ObjectId.isValid(conversationId) ? conversationId : undefined,
          snippet: (snippet || "").slice(0, 500),
          savedAt: new Date(),
        },
      },
      { upsert: true, new: true },
    );

    return c.json({ message: "Saved", savedItemId: saved._id }, 201);
  } catch (error: any) {
    // Duplicate key from the unique (user, itemType, itemId) index — already
    // saved is a success from the caller's point of view, not an error.
    if (error?.code === 11000) {
      return c.json({ message: "Already saved" }, 200);
    }
    console.error("Error saving item:", error);
    return c.json({ error: "Failed to save item" }, 500);
  }
};

export const unsaveItem = async (c: Context) => {
  try {
    const me = c.get("user");
    const { itemType, itemId } = c.req.param();
    if (!itemType || !["message", "reel"].includes(itemType)) {
      return c.json({ error: "Invalid itemType" }, 400);
    }
    if (!itemId || !mongoose.Types.ObjectId.isValid(itemId)) {
      return c.json({ error: "Invalid itemId" }, 400);
    }
    await SavedItem.deleteOne({ user: me.id, itemType, itemId });
    return c.json({ message: "Unsaved" });
  } catch (error) {
    console.error("Error unsaving item:", error);
    return c.json({ error: "Failed to unsave item" }, 500);
  }
};

export const getSavedItems = async (c: Context) => {
  try {
    const me = c.get("user");
    const limit = Math.min(
      Math.max(parseInt(c.req.query("limit") || "50", 10) || 50, 1),
      100,
    );
    const items = await SavedItem.find({ user: me.id })
      .sort({ savedAt: -1 })
      .limit(limit)
      .populate("serverId", "name")
      .populate("channelId", "name")
      .lean();
    return c.json({ items, count: items.length });
  } catch (error) {
    console.error("Error fetching saved items:", error);
    return c.json({ error: "Failed to fetch saved items" }, 500);
  }
};
