import { Context } from "hono";
import DiscordServer from "../models/DiscordServer.ts";
import Channel from "../models/Channel.ts";
import mongoose from "mongoose";
import AuditLog from "../models/AuditLog.ts";
import { Server } from "socket.io";

export const createChannel = async (c: Context) => {
  const { serverId } = c.req.param();
  const body = await c.req.json();
  const { name, categoryId, typeOfChannel } = body;
  try {
    const channel = new Channel({
      name,
      server: serverId,
      category: categoryId,
      type: typeOfChannel,
    });
    const server = await DiscordServer.findById(serverId);
    if (!server) {
      return c.json({ error: "Server not found" }, 404);
    }
    await channel.save();
    server.channels.push(channel._id);
    await server.save();
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
      server.members?.some(
        (m: any) =>
          m.user.toString() === user?.id &&
          (m.roles.includes("admin") || m.roles.includes("mod"))
      );
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
      server.members?.some(
        (m: any) => m.user.toString() === user?.id && m.roles.includes("admin")
      );
    if (!isAllowed) return c.json({ error: "Permission denied" }, 403);

    const deletedChannel = await Channel.findByIdAndDelete(channelId);

    if (!deletedChannel) {
      return c.json({ error: "Channel not found" }, 404);
    }

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
