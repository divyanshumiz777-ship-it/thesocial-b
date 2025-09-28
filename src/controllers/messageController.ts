import { Context } from "hono";
import { Server } from "socket.io";
import Message from "../models/Message.ts";
import mongoose from "mongoose";
import Channel from "../models/Channel.ts";
import { uploadOnCloudinary } from "../lib/cloudinary.ts";
import { Buffer } from "node:buffer";

export const createMessage = async (c: Context) => {
  try {
    const io: Server = c.get("io");
    if (!io) {
      return c.json({ error: "Socket.IO instance not available" }, 500);
    }
    const { channelId } = c.req.param();

    const user = c.get("user");

    const formData = await c.req.formData();

    const content = formData.get("content") as string;
    const senderId = user.id;
    const serverId = formData.get("serverId") as string;
    const attachmentFile = formData.get("attachment") as File | null;
    const mentionsString = formData.get("mentions") as string | null;
    const mentions = mentionsString ? JSON.parse(mentionsString) : [];

    if (
      !mongoose.Types.ObjectId.isValid(channelId) ||
      !mongoose.Types.ObjectId.isValid(senderId) ||
      !mongoose.Types.ObjectId.isValid(serverId)
    ) {
      return c.json({ error: "Invalid ID format" }, 400);
    }
    // const canUserSendMessages = await DiscordServer.findOne({
    //   _id: serverId,
    //   members: {
    //     $elemMatch: {
    //       user: senderId,
    //       "muted.isMuted": { $ne: true },
    //       "banned.isBanned": { $ne: true },
    //       roles: "send messages",
    //     },
    //   },
    // });
    // if (!canUserSendMessages) {
    //   return c.json(
    //     {
    //       error: "You do not have permission to send messages in this server.",
    //     },
    //     403
    //   );
    // }
    const attachments = [];
    if (attachmentFile) {
      const arrayBuffer = await attachmentFile.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      const cloudinaryResponse = await uploadOnCloudinary(buffer, {
        folder: "attachments",
        resource_type: "auto",
      });

      if (cloudinaryResponse) {
        attachments.push(cloudinaryResponse.secure_url);
      }
    }

    const newMessage = await Message.create({
      channel: channelId,
      server: serverId,
      sender: senderId,
      content,
      mentions,
      attachments,
    });
    const populatedMessage = await Message.findById(newMessage._id).populate(
      "sender"
    );

    io.to(channelId).emit("message", populatedMessage);

    if (mentions.length > 0) {
      mentions.forEach((userId: string) => {
        io.to(userId).emit("newMention", {
          message: populatedMessage,
          channelId,
          serverId,
        });
      });
    }

    await Channel.findByIdAndUpdate(channelId, {
      $push: { messages: newMessage._id },
      $addToSet: { senders: senderId },
    });

    return c.json(populatedMessage, 201);
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

    return c.json(messages || [], 200);
  } catch (error) {
    console.error("Error fetching messages:", error);
    return c.json({ error: "Failed to fetch messages" }, 500);
  }
};

export const deleteMessage = async (c: Context) => {
  const { messageId, user } = c.req.param();
  const io: Server = c.get("io");
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
    const channelIdString = deletedMessage.channel?.toString();
    if (!channelIdString) {
      return c.json({ error: "Invalid channel ID" }, 400);
    }

    io.to(channelIdString).emit("messageDeleted", messageId);

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
  try {
    const io: Server = c.get("io");
    const { messageId } = c.req.param();
    const formData = await c.req.formData();
    const content = formData.get("content") as string;
    const senderId = formData.get("senderId") as string;
    const attachmentFile = formData.get("attachment") as File | null;

    if (
      !mongoose.Types.ObjectId.isValid(messageId) ||
      !mongoose.Types.ObjectId.isValid(senderId)
    ) {
      return c.json({ error: "Invalid message or user ID format" }, 400);
    }

    const originalMessage = await Message.findOne({
      _id: messageId,
      sender: senderId,
    });

    if (!originalMessage) {
      return c.json(
        { error: "Message not found or you don't have permission to edit it." },
        403
      );
    }

    let newAttachmentUrl: string | null = null;
    if (attachmentFile) {
      const arrayBuffer = await attachmentFile.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const cloudinaryResponse = await uploadOnCloudinary(buffer, {
        folder: "attachments",
        resource_type: "auto",
      });

      if (cloudinaryResponse) {
        newAttachmentUrl = cloudinaryResponse.secure_url;
      }
    }

    const updateOperation: any = {
      $set: { content, edited: true },
    };

    if (newAttachmentUrl) {
      updateOperation.$push = { attachments: newAttachmentUrl };
    }

    const updatedMessage = await Message.findByIdAndUpdate(
      messageId,
      updateOperation,
      { new: true }
    ).populate("sender");

    if (!updatedMessage) {
      return c.json({ error: "Message not found" }, 404);
    }

    const channelIdString = updatedMessage.channel?.toString();
    if (channelIdString) {
      io.to(channelIdString).emit("messageUpdated", updatedMessage);
    }

    return c.json(updatedMessage, 200);
  } catch (error) {
    console.error("Error updating message:", error);
    return c.json({ error: "Failed to update message" }, 500);
  }
};

export const toggleReaction = async (c: Context) => {
  const { messageId } = c.req.param();
  const { emoji, user, conversationId } = await c.req.json();
  const io: Server = c.get("io");
  if (
    !mongoose.Types.ObjectId.isValid(messageId) ||
    !mongoose.Types.ObjectId.isValid(conversationId)
  )
    return c.json({ error: "Invalid ID format" }, 400);
  try {
    const message = await Message.findById(messageId);
    if (!message) return c.json({ error: "Message not found" }, 404);

    const reactionIndex = message.reactions.findIndex((r) => r.emoji === emoji);
    const userIdString = user._id.toString();

    if (reactionIndex > -1) {
      const reaction = message.reactions[reactionIndex];
      const userIndex = reaction.users.findIndex(
        (u) => u.toString() === userIdString
      );

      if (userIndex > -1) {
        reaction.users.splice(userIndex, 1);
        if (reaction.users.length === 0) {
          message.reactions.splice(reactionIndex, 1);
        }
      } else {
        reaction.users.push(user._id);
      }
    } else {
      message.reactions.push({ emoji, users: [user._id] });
    }
    await message.save();

    io.to(conversationId).emit("reactionUpdated", message);

    return c.json({ message: "Reaction updated successfully" }, 200);
  } catch (error) {
    console.error("Error adding reaction:", error);
    return c.json({ error: "Failed to add reaction" }, 500);
  }
};
