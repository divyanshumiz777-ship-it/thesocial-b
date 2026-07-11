import { Context } from "hono";
import DiscordServer from "../models/DiscordServer.ts";
import Channel from "../models/Channel.ts";
import Category from "../models/Category.ts";
import Message from "../models/Message.ts";
import mongoose from "mongoose";
import AuditLog from "../models/AuditLog.ts";
import { Server } from "socket.io";
import ServerMember from "../models/ServerMember.ts";

export const createChannel = async (c: Context) => {
  const { serverId } = c.req.param();
  const body = await c.req.json();
  const { name, categoryId, typeOfChannel } = body;
  const user = c.get("user");

  if (!mongoose.Types.ObjectId.isValid(serverId)) {
    return c.json({ error: "Invalid server ID format" }, 400);
  }

  try {
    const server = await DiscordServer.findById(serverId).lean();
    if (!server) {
      return c.json({ error: "Server not found" }, 404);
    }

    // Previously unchecked — any authenticated user (not just server
    // members) could create a channel in any server. Mirrors updateChannel's
    // owner-or-admin/mod check, the same weight of structural change.
    const isAllowed =
      server.owner.toString() === user?.id ||
      !!(await ServerMember.exists({
        server: serverId,
        user: user?.id,
        roles: { $in: ["admin", "mod"] },
      }));
    if (!isAllowed) return c.json({ error: "Permission denied" }, 403);

    // The category must actually belong to this server — otherwise a caller
    // could pass an arbitrary categoryId and file a channel under a category
    // in a DIFFERENT server they don't manage.
    const category = await Category.findOne({ _id: categoryId, server: serverId });
    if (!category) {
      return c.json({ error: "Category not found in this server" }, 404);
    }

    const channel = new Channel({
      name,
      server: serverId,
      category: categoryId,
      type: typeOfChannel,
    });
    await channel.save();

    // Both parent documents index this channel by id — DiscordServer.channels
    // (server-wide flat list) AND Category.channels (what getServerById's
    // `categories.channels` populate actually reads to render the sidebar).
    // Previously only the former was updated, so a newly created channel was
    // saved successfully but never appeared anywhere in the UI: the category
    // it belonged to had no record of it, no matter how many times the
    // client refetched the server.
    await Promise.all([
      DiscordServer.findByIdAndUpdate(serverId, {
        $push: { channels: channel._id },
      }),
      Category.findByIdAndUpdate(categoryId, {
        $push: { channels: channel._id },
      }),
    ]);

    return c.json({
      message: "Channel created successfully",
      channel,
    });
  } catch (error) {
    console.error("Error creating channel:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};
export const updateChannel = async (c: Context) => {
  const { channelId } = c.req.param();
  const body = await c.req.json();
  const { name } = body;
  const user = c.get("user");

  if (!mongoose.Types.ObjectId.isValid(channelId)) {
    return c.json({ error: "Invalid channel ID format" }, 400);
  }

  try {
    const channel = await Channel.findById(channelId);
    if (!channel) return c.json({ error: "Channel not found" }, 404);

    const server = await DiscordServer.findById(channel.server).lean();
    if (!server) return c.json({ error: "Server not found" }, 404);
    const isAllowed =
      server.owner.toString() === user?.id ||
      !!(await ServerMember.exists({
        server: channel.server,
        user: user?.id,
        roles: { $in: ["admin", "mod"] },
      }));
    if (!isAllowed) return c.json({ error: "Permission denied" }, 403);

    const updatedChannel = await Channel.findByIdAndUpdate(
      channelId,
      { name },
      { new: true }
    );

    if (!updatedChannel) {
      return c.json({ error: "Channel not found" }, 404);
    }

    await AuditLog.create({
      server: channel.server,
      action: "channel_rename",
      performedBy: user?.id,
      details: `Channel ${channelId} renamed to '${name}'`,
    });

    try {
      const io = (c as any).get("io") as Server | undefined;
      if (io) {
        io.to(channel.server.toString()).emit("channel:updated", {
          serverId: channel.server.toString(),
          channelId,
          name,
        });
      }
    } catch {}

    return c.json({
      message: "Channel updated successfully",
      channel: updatedChannel,
    });
  } catch (error) {
    console.error("Error updating channel:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};
export const getChannels = async (c: Context) => {
  const { serverId } = c.req.param();

  if (!mongoose.Types.ObjectId.isValid(serverId)) {
    return c.json({ error: "Invalid server ID format" }, 400);
  }

  try {
    const channels = await Channel.find({ server: serverId });
    return c.json({ channels });
  } catch (error) {
    console.error("Error fetching channels:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};
export const deleteChannel = async (c: Context) => {
  const { channelId } = c.req.param();
  const user = c.get("user");

  if (!mongoose.Types.ObjectId.isValid(channelId)) {
    return c.json({ error: "Invalid channel ID format" }, 400);
  }

  try {
    const channel = await Channel.findById(channelId);
    if (!channel) return c.json({ error: "Channel not found" }, 404);

    const server = await DiscordServer.findById(channel.server).lean();
    if (!server) return c.json({ error: "Server not found" }, 404);
    const isAllowed =
      server.owner.toString() === user?.id ||
      !!(await ServerMember.exists({
        server: channel.server,
        user: user?.id,
        roles: "admin",
      }));
    if (!isAllowed) return c.json({ error: "Permission denied" }, 403);

    const deletedChannel = await Channel.findByIdAndDelete(channelId);

    if (!deletedChannel) {
      return c.json({ error: "Channel not found" }, 404);
    }

    await Message.deleteMany({ channel: channelId });

    await DiscordServer.findByIdAndUpdate(channel.server, {
      $pull: { channels: deletedChannel._id },
    });
    await AuditLog.create({
      server: channel.server,
      action: "channel_delete",
      performedBy: user?.id,
      details: `Channel ${channelId} deleted`,
    });

    try {
      const io = (c as any).get("io") as Server | undefined;
      if (io) {
        io.to(channel.server.toString()).emit("channel:deleted", {
          serverId: channel.server.toString(),
          channelId,
        });
      }
    } catch {}

    return c.json({
      message: "Channel deleted successfully",
      channel: deletedChannel,
    });
  } catch (error) {
    console.error("Error deleting channel:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const searchChannels = async (c: Context) => {
  const query = c.req.query("q") || "";
  const limit = Number.parseInt(c.req.query("limit") || "20", 10);
  const skip = Number.parseInt(c.req.query("skip") || "0", 10);
  if (!query) {
    return c.json({ error: "Query required" }, 400);
  }
  const filter = { name: { $regex: query, $options: "i" } };
  const total = await Channel.countDocuments(filter);
  const channels = await Channel.find(filter)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean();
  return c.json({ channels, total, limit, skip }, 200);
};
