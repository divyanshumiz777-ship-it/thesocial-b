import { Context } from "hono";
import { Server } from "socket.io";
import Message from "../models/Message.ts";
import mongoose from "mongoose";
import Channel from "../models/Channel.ts";
import ChannelReadStatus from "../models/ChannelReadStatus.ts";
import { uploadOnCloudinary } from "../lib/cloudinary.ts";
import { Buffer } from "node:buffer";
import User from "../models/User.ts";
import {
  createNotification,
  sendNotificationViaSocket,
} from "./notificationController.ts";

export const searchMessages = async (c: Context) => {
  const { channelId } = c.req.param();
  const query = c.req.query("q") || "";
  const limit = Number.parseInt(c.req.query("limit") || "20", 10);
  const skip = Number.parseInt(c.req.query("skip") || "0", 10);
  if (!channelId || !query) {
    return c.json({ error: "Channel ID and query required" }, 400);
  }
  try {
    const filter = { channel: channelId, $text: { $search: query } };
    const total = await Message.countDocuments(filter);
    const messages = await Message.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();
    return c.json({ messages, total, limit, skip }, 200);
  } catch (error) {
    return c.json({ error: "Search failed" }, 500);
  }
};

export const createMessage = async (c: Context) => {
  try {
    const io: Server = c.get("io");
    if (!io) return c.json({ error: "Socket.IO instance not available" }, 500);

    const { channelId } = c.req.param();
    const user = c.get("user");
    const contentType = c.req.header("content-type") || "";
    const senderId = user.id;

    let content = "";
    let serverId = "";
    let mentions: any[] = [];
    let replyToId: string | null = null;
    let gifUrl: string | null = null;
    let stickerUrl: string | null = null;
    const attachmentFiles: File[] = [];

    if (contentType.includes("application/json")) {
      const body = await c.req.json();
      content = body.content ?? "";
      serverId = body.serverId ?? "";
      mentions = Array.isArray(body.mentions) ? body.mentions : [];
      replyToId = body.replyTo ?? null;
      gifUrl = body.gifUrl ?? null;
      stickerUrl = body.stickerUrl ?? null;
    } else {
      const formData = await c.req.formData();
      content = (formData.get("content") as string) ?? "";
      serverId = (formData.get("serverId") as string) ?? "";
      const mentionsString = formData.get("mentions") as string | null;
      mentions = mentionsString ? JSON.parse(mentionsString) : [];
      replyToId = (formData.get("replyTo") as string | null) ?? null;
      gifUrl = (formData.get("gifUrl") as string | null) ?? null;
      stickerUrl = (formData.get("stickerUrl") as string | null) ?? null;

      let index = 0;
      while (formData.get(`attachment${index}`)) {
        const file = formData.get(`attachment${index}`) as File;
        if (file) attachmentFiles.push(file);
        index++;
      }

      const singleAttachment = formData.get("attachment") as File | null;
      if (singleAttachment) {
        attachmentFiles.push(singleAttachment);
      }
    }

    if (
      !mongoose.Types.ObjectId.isValid(channelId) ||
      !mongoose.Types.ObjectId.isValid(senderId) ||
      !mongoose.Types.ObjectId.isValid(serverId)
    ) {
      return c.json({ error: "Invalid ID format" }, 400);
    }

    const getFileType = (
      file: File
    ): "image" | "video" | "document" | "audio" => {
      const mimeType = file.type;
      if (mimeType.startsWith("image/")) return "image";
      if (mimeType.startsWith("video/")) return "video";
      if (mimeType.startsWith("audio/")) return "audio";
      return "document";
    };

    const attachments = [];
    const attachmentsV2 = [];

    if (gifUrl) {
      attachments.push(gifUrl);
      attachmentsV2.push({
        url: gifUrl,
        type: "gif",
        mimeType: "image/gif",
      });
    }

    if (stickerUrl) {
      attachments.push(stickerUrl);
      attachmentsV2.push({
        url: stickerUrl,
        type: "sticker",
        mimeType: "image/png",
      });
    }

    for (const attachmentFile of attachmentFiles) {
      const arrayBuffer = await attachmentFile.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      const fileType = getFileType(attachmentFile);
      let resourceType: "auto" | "video" = "auto";
      if (fileType === "video" || fileType === "audio") {
        resourceType = "video";
      }

      const cloudinaryResponse = await uploadOnCloudinary(buffer, {
        folder: `attachments/${fileType}s`,
        resource_type: resourceType,
      });

      if (cloudinaryResponse) {
        attachments.push(cloudinaryResponse.secure_url);
        attachmentsV2.push({
          url: cloudinaryResponse.secure_url,
          type: fileType,
          fileName: attachmentFile.name,
          fileSize: attachmentFile.size,
          mimeType: attachmentFile.type,
        });
      }
    }

    const newMessage = await Message.create({
      channel: channelId,
      server: serverId,
      sender: senderId,
      content,
      mentions,
      attachments,
      attachmentsV2,
      replyTo: replyToId || undefined,
    });

    const populatedMessage = await Message.findById(newMessage._id)
      .populate("sender")
      .populate({
        path: "replyTo",
        populate: { path: "sender" },
      });

    if (!populatedMessage) {
      return c.json({ error: "Failed to retrieve the created message" }, 500);
    }

    io.to(channelId).emit("message", populatedMessage);
    io.to(channelId).emit("messageCreated", populatedMessage);
    io.to(serverId.toString()).emit("server:new-message", {
      serverId: serverId.toString(),
      channelId: channelId.toString(),
      message: populatedMessage,
    });

    if (mentions.length > 0) {
      mentions.forEach((userId: string) => {
        io.to(userId).emit("newMention", {
          message: populatedMessage,
          channelId,
          serverId,
        });
      });

      try {
        const channelDoc = await Channel.findById(channelId).select("name");
        const channelName = channelDoc?.name || "channel";
        const senderName = (populatedMessage as any)?.sender?.name || "Someone";
        const snippet = String(content || "").slice(0, 140);

        for (const recipientId of mentions as string[]) {
          if (!mongoose.Types.ObjectId.isValid(recipientId)) continue;
          const recipient = await User.findById(recipientId).select("settings");
          const level =
            (recipient as any)?.settings?.notifications?.level || "all";
          const mutedServers: string[] = (
            (recipient as any)?.settings?.mutedServers || []
          ).map(String);

          const allowByLevel = level === "all" || level === "mentions";
          const muted = mutedServers.includes(String(serverId));
          if (!allowByLevel || muted) continue;

          const actionUrl = `${
            process.env.FRONTEND_URL || "http://localhost:3000"
          }/community/${serverId}/${channelId}?messageId=${String(
            (populatedMessage as any)?._id
          )}`;

          const notif = await createNotification({
            recipient: String(recipientId),
            sender: String(senderId),
            type: "message_mention",
            title: `Mentioned in #${channelName}`,
            message: `${senderName}: ${snippet}`,
            metadata: {
              serverId,
              channelId,
              messageId: String((populatedMessage as any)?._id),
            },
            actionUrl,
          });

          if (notif) {
            sendNotificationViaSocket(io, String(recipientId), notif);
          }
        }
      } catch (e) {
        console.error("Failed to create mention notifications:", e);
      }
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
      .populate("sender")
      .populate({
        path: "replyTo",
        populate: { path: "sender" },
      });

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
    const user = c.get("user");

    if (!user || !user.id) {
      console.error("Authentication failed: User not found or missing ID");
      return c.json({ error: "Authentication required" }, 401);
    }

    const contentType = c.req.header("content-type") || "";

    let content: string;
    let senderId: string;
    let attachmentFile: File | null = null;

    if (contentType.includes("application/json")) {
      const body = await c.req.json();
      content = body.content;
      senderId = user.id;
    } else {
      const formData = await c.req.formData();
      content = formData.get("content") as string;
      senderId = user.id;
      attachmentFile = formData.get("attachment") as File | null;
    }

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
    )
      .populate("sender")
      .populate({
        path: "replyTo",
        populate: { path: "sender" },
      });

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

export const updateLastReadMessage = async (c: Context) => {
  try {
    const { channelId } = c.req.param();
    const user = c.get("user");
    const { messageId } = await c.req.json();

    if (
      !mongoose.Types.ObjectId.isValid(channelId) ||
      !mongoose.Types.ObjectId.isValid(user.id) ||
      !mongoose.Types.ObjectId.isValid(messageId)
    ) {
      return c.json({ error: "Invalid ID format" }, 400);
    }

    await ChannelReadStatus.findOneAndUpdate(
      { user: user.id, channel: channelId },
      {
        lastReadMessage: messageId,
        lastReadAt: new Date(),
      },
      { upsert: true, new: true }
    );

    return c.json({ message: "Last read message updated successfully" }, 200);
  } catch (error) {
    console.error("Error updating last read message:", error);
    return c.json({ error: "Failed to update last read message" }, 500);
  }
};

export const getLastReadMessage = async (c: Context) => {
  try {
    const { channelId } = c.req.param();
    const user = c.get("user");

    if (
      !mongoose.Types.ObjectId.isValid(channelId) ||
      !mongoose.Types.ObjectId.isValid(user.id)
    ) {
      return c.json({ error: "Invalid ID format" }, 400);
    }

    const readStatus = await ChannelReadStatus.findOne({
      user: user.id,
      channel: channelId,
    });

    if (!readStatus) {
      return c.json({ lastReadMessage: null }, 200);
    }

    return c.json(
      {
        lastReadMessage: readStatus.lastReadMessage,
        lastReadAt: readStatus.lastReadAt,
      },
      200
    );
  } catch (error) {
    console.error("Error fetching last read message:", error);
    return c.json({ error: "Failed to fetch last read message" }, 500);
  }
};
