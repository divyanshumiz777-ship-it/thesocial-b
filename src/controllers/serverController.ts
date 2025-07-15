import { Context } from "hono";
import DiscordServer from "../models/DiscordServer.ts";
import Category from "../models/Category.ts";
import mongoose from "mongoose";
import Channel from "../models/Channel.ts";

export const createServer = async (c: Context) => {
  const body = await c.req.json();
  const { serverName, user } = body;

  if (!serverName || !user?._id) {
    return c.json({ error: "Server name and user ID are required" }, 400);
  }

  try {
    const newServer = new DiscordServer({
      name: serverName,
      owner: user._id,
      categories: [],
      channels: [],
      members: [user._id],
    });
    await newServer.save();

    const textCategoryDoc = await Category.create({
      name: "Text Channels",
      server: newServer._id,
    });
    const textCategoryId = new mongoose.Types.ObjectId(textCategoryDoc._id);

    const voiceCategoryDoc = await Category.create({
      name: "Voice Channels",
      server: newServer._id,
    });
    const voiceCategoryId = new mongoose.Types.ObjectId(voiceCategoryDoc._id);

    const generalTextChannel = await Channel.create({
      name: "general",
      type: "Text",
      category: textCategoryId,
      server: newServer._id,
    });

    const generalVoiceChannel = await Channel.create({
      name: "General",
      type: "Voice",
      category: voiceCategoryId,
      server: newServer._id,
    });

    newServer.categories = [textCategoryId, voiceCategoryId];
    newServer.channels = [generalTextChannel._id, generalVoiceChannel._id];
    await newServer.save();

    return c.json(
      { message: "Server created successfully", server: newServer },
      201
    );
  } catch (error) {
    console.error("Error creating server:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const getAllServers = async (c: Context) => {
  try {
    const servers = await DiscordServer.find();
    if (servers.length === 0)
      return c.json({ message: "No servers found" }, 404);
    return c.json({ servers: servers }, 200);
  } catch (error) {
    console.error("Error fetching servers: ", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};
export const getServer = async (c: Context) => {
  const { id } = c.req.param();
  try {
    const server = await DiscordServer.findById(id);
    if (!server) return c.json({ message: "No such server exists" }, 404);
    return c.json({ server: server }, 200);
  } catch (error) {
    console.error("Error fetching server: ", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const editServer = async (c: Context) => {
  const { id } = c.req.param();
  const body = await c.req.json();
  const { name, category, channel, categoryType, channelCategoryId } = body;

  try {
    const serverToUpdate = await DiscordServer.findById(id);
    if (!serverToUpdate) {
      return c.json({ error: "No such server exists" }, 404);
    }
    if (category) {
      const newCategory = await Category.create({
        name: category,
        server: serverToUpdate._id,
      });
      serverToUpdate.categories.push(newCategory._id);
    }
    if (channel) {
      let assignedCategoryId = channelCategoryId;

      if (!channelCategoryId) {
        let uncategorized = await Category.findOne({
          name: "Uncategorized",
          server: serverToUpdate._id,
        });

        if (!uncategorized) {
          uncategorized = await Category.create({
            name: "Uncategorized",
            server: serverToUpdate._id,
          });
          serverToUpdate.categories.push(uncategorized._id);
        }

        assignedCategoryId = uncategorized._id;
      }

      const newChannel = await Channel.create({
        name: channel,
        type: categoryType,
        category: assignedCategoryId,
        server: serverToUpdate._id,
      });

      await Category.findByIdAndUpdate(
        assignedCategoryId,
        { $push: { channels: newChannel._id } },
        { new: true }
      );

      serverToUpdate.channels.push(newChannel._id);
    }

    if (name) {
      serverToUpdate.name = name;
    }

    await serverToUpdate.save();

    return c.json(
      { message: "Server updated successfully", server: serverToUpdate },
      200
    );
  } catch (error) {
    console.error("Error updating server: ", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const deleteServer = async (c: Context) => {
  const { id } = c.req.param();
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return c.json({ error: "Invalid server ID format" }, 400);
  }
  try {
    const deletedServer = await DiscordServer.findByIdAndDelete(id);
    if (!deletedServer) return c.json({ error: "Server not found" }, 404);
    return c.json({ message: "Server deleted successfully" }, 200);
  } catch (error) {
    console.error("Error deleting server: ", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};
