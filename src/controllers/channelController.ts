import { Context } from "hono";
import DiscordServer from "../models/DiscordServer.ts";
import Channel from "../models/Channel.ts";
import mongoose from "mongoose";

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

  if (!mongoose.Types.ObjectId.isValid(channelId)) {
    return c.json({ error: "Invalid channel ID format" }, 400);
  }

  try {
    const updatedChannel = await Channel.findByIdAndUpdate(
      channelId,
      { name },
      { new: true }
    );

    if (!updatedChannel) {
      return c.json({ error: "Channel not found" }, 404);
    }

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

  if (!mongoose.Types.ObjectId.isValid(channelId)) {
    return c.json({ error: "Invalid channel ID format" }, 400);
  }

  try {
    const deletedChannel = await Channel.findByIdAndDelete(channelId);

    if (!deletedChannel) {
      return c.json({ error: "Channel not found" }, 404);
    }

    return c.json({
      message: "Channel deleted successfully",
      channel: deletedChannel,
    });
  } catch (error) {
    console.error("Error deleting channel:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};
