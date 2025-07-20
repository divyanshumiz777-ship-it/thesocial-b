import { Context } from "hono";
import { Server } from "socket.io";
import Message from "../models/MessageModel.ts";
import mongoose from "mongoose";
import Channel from "../models/Channel.ts";
import DiscordServer from "../models/DiscordServer.ts";

export const createMessage = async (c: Context) => {
  try {
    const io: Server = c.get("io");
    if (!io) {
      return c.json({ error: "Socket.IO instance not available" }, 500);
    }
    const { channelId } = c.req.param();
    const { content, senderId } = await c.req.json();
    if (!channelId || !senderId || !content) {
      return c.json({ error: "Missing required fields" }, 400);
    }
    if (
      !mongoose.Types.ObjectId.isValid(channelId) ||
      !mongoose.Types.ObjectId.isValid(senderId)
    ) {
      return c.json({ error: "Invalid ID format" }, 400);
    }
    const channel = await Channel.findById(channelId);
    if (!channel) {
      return c.json({ error: "Channel not found" }, 404);
    }

    const canUserSendMessages = await DiscordServer.findOne({
      _id: channel?.server,
      members: {
        $elemMatch: { user: senderId, roles: "send messages" },
      },
    });
    if (!canUserSendMessages) {
      return c.json(
        { error: "You do not have permission to send messages" },
        403
      );
    }

    const newMessage = await Message.create({
      channel: channelId,
      sender: senderId,
      content,
    });

    io.to(`channel-${channelId}`).emit("message", newMessage);

    await Channel.findByIdAndUpdate(channelId, {
      $push: { messages: newMessage._id },
      $addToSet: { senders: senderId },
    });
    return c.json(newMessage, 201);
  } catch (error) {
    console.error("Error creating message:", error);
    return c.json({ error: "Failed to create message" }, 500);
  }
};

export const getMessagesByChannelId = async (c: Context) => {
  const { channelId } = c.req.param();
  const page = parseInt(c.req.query("page") || "1");
  const limit = parseInt(c.req.query("limit") || "50");
  const skip = (page - 1) * limit;
  if (!channelId) {
    return c.json({ error: "Channel ID is required" }, 400);
  }
  if (!mongoose.Types.ObjectId.isValid(channelId)) {
    return c.json({ error: "Invalid channel ID format" }, 400);
  }
  try {
    const messages = await Message.find({ channel: channelId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("sender");
    if (messages.length === 0) {
      return c.json({ message: "No messages found for this channel" }, 404);
    }
    return c.json(messages, 200);
  } catch (error) {
    console.error("Error fetching messages:", error);
    return c.json({ error: "Failed to fetch messages" }, 500);
  }
};
export const deleteMessage = async (c: Context) => {
  const { messageId, user, serverId } = c.req.param();
  if (!messageId) {
    return c.json({ error: "Message ID is required" }, 400);
  }
  if (!mongoose.Types.ObjectId.isValid(messageId)) {
    return c.json({ error: "Invalid message ID format" }, 400);
  }
  try {
    const canDeleteMessage = await Message.findOne({
      _id: messageId,
      sender: user,
    });

    if (!canDeleteMessage)
      return c.json(
        { error: "You do not have permission to delete messages" },
        403
      );

    const deletedMessage = await Message.findByIdAndDelete(messageId);
    if (!deletedMessage) {
      return c.json({ error: "Message not found" }, 404);
    }
    const io: Server = c.get("io");
    if (io) {
      io.to(`channel-${deletedMessage.channel}`).emit(
        "messageDeleted",
        messageId
      );
    }
    await Channel.updateOne(
      { messages: messageId },
      { $pull: { messages: messageId } }
    );
    return c.json({ message: "Message deleted successfully" }, 200);
  } catch (error) {
    console.error("Error deleting message:", error);
    return c.json({ error: "Failed to delete message" }, 500);
  }
};
export const updateMessage = async (c: Context) => {
  const { messageId, userId } = c.req.param();
  if (!messageId) {
    return c.json({ error: "Message ID is required" }, 400);
  }
  if (
    !mongoose.Types.ObjectId.isValid(messageId) ||
    !mongoose.Types.ObjectId.isValid(userId)
  ) {
    return c.json(
      {
        error: "Invalid message ID format or user ID format",
      },
      400
    );
  }
  const { content } = await c.req.json();
  if (!content) {
    return c.json({ error: "Content is required" }, 400);
  }
  try {
    const canUpdateMessage = await Message.findOne({
      _id: messageId,
      sender: userId,
    });
    if (!canUpdateMessage)
      return c.json(
        { error: "You do not have permission to update messages" },
        403
      );
    const updatedMessage = await Message.findByIdAndUpdate(
      messageId,
      { content },
      { new: true }
    );
    if (!updatedMessage) {
      return c.json({ error: "Message not found" }, 404);
    }
    const io: Server = c.get("io");
    if (io) {
      io.to(`channel-${updatedMessage.channel}`).emit(
        "messageUpdated",
        updatedMessage
      );
    }
    return c.json(updatedMessage, 200);
  } catch (error) {
    console.error("Error updating message:", error);
    return c.json({ error: "Failed to update message" }, 500);
  }
};
