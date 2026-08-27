import { Context } from "hono";
import { Server } from "socket.io";
import Message from "../models/Message.ts";
import mongoose from "mongoose";
import Channel from "../models/Channel.ts";
import ChannelReadStatus from "../models/ChannelReadStatus.ts";
import ServerMember from "../models/ServerMember.ts";
import { uploadOnCloudinary } from "../lib/cloudinary.ts";
import { Buffer } from "node:buffer";
import User from "../models/User.ts";
import {
  createNotification,
  sendNotificationViaSocket,
} from "./notificationController.ts";
import {
  markdownToHtml,
  markdownToPlainText,
  hasMarkdown,
} from "../lib/markdown.ts";
import { invalidateAfterMessage } from "../lib/cacheInvalidation.ts";
import { fireWebhooksForEvent } from "../lib/webhookEvents.ts";
import {
  getFileType as getSharedFileType,
  getCloudinaryResourceType,
} from "../lib/fileUpload.ts";
import { forwardDeleteContent, isChatServiceEnabled } from "../lib/chatServiceClient.ts";

// Only gates "for-everyone" — see deleteMessage below. "for-me" (hiding a
// message from your own view only) never affects anyone else, so it stays
// available regardless of age.
const DELETE_FOR_EVERYONE_WINDOW_MS = 24 * 60 * 60 * 1000;

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

    const membership = await ServerMember.findOne(
      { server: serverId, user: senderId },
      "banned muted"
    ).lean();
    if (membership?.banned?.isBanned) {
      return c.json({ error: "You are banned from this server" }, 403);
    }
    if (
      membership?.muted?.isMuted &&
      (!membership.muted.expiresAt || membership.muted.expiresAt > new Date())
    ) {
      return c.json({ error: "You are muted in this server" }, 403);
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

      const cloudinaryResponse = await uploadOnCloudinary(buffer, {
        folder: `attachments/${fileType}s`,
        resource_type: getCloudinaryResourceType(fileType),
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
      formattedContent: hasMarkdown(content)
        ? markdownToHtml(content)
        : content,
      plainText: markdownToPlainText(content),
      mentions,
      attachments,
      attachmentsV2,
      replyTo: replyToId || undefined,
    });

    const populatedMessage = await Message.findById(newMessage._id)
      .populate("sender", "name profilePic email")
      .populate({
        path: "replyTo",
        populate: { path: "sender", select: "name profilePic email" },
      });

    if (!populatedMessage) {
      return c.json({ error: "Failed to retrieve the created message" }, 500);
    }

    io.to(channelId).emit("messageCreated", populatedMessage);
    io.to(serverId.toString()).emit("server:new-message", {
      serverId: serverId.toString(),
      channelId: channelId.toString(),
      message: populatedMessage,
    });

    // Fire-and-forget — never awaited, must never add latency to sending a
    // message. A server admin's own configured webhook (Discord/Slack/
    // Zapier) sees this exactly like the existing manual "Test Payload".
    void fireWebhooksForEvent(serverId.toString(), "message_created", {
      channelId: channelId.toString(),
      sender: { id: senderId, name: user.name },
      content,
      messageId: newMessage._id.toString(),
    }, io);

    if (mentions.length > 0) {
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
      $addToSet: { senders: senderId },
    });

    await invalidateAfterMessage(channelId, serverId);
    return c.json(populatedMessage, 201);
  } catch (error) {
    console.error("Error creating message:", error);
    return c.json({ error: "Failed to create message" }, 500);
  }
};

export const getMessagesByChannelId = async (c: Context) => {
  const { channelId } = c.req.param();
  const viewer = c.get("user");

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
    // Block enforcement was inconsistent: enforced in shared member lists
    // and DM calls, but never here — a blocked harasser's messages still
    // rendered verbatim in any channel you both belonged to. Same
    // both-directions convention as getServerById's hiddenUserIds.
    const [viewerDoc, blockedByOthers] = await Promise.all([
      User.findById(viewer?.id).select("blockedUsers").lean(),
      User.find({ blockedUsers: viewer?.id }, "_id").lean(),
    ]);
    const hiddenUserIds = new Set<string>([
      ...(viewerDoc?.blockedUsers ?? []).map((u: any) => u.toString()),
      ...blockedByOthers.map((u) => u._id.toString()),
    ]);

    const messages = await Message.find({ channel: channelId, deletedFor: { $ne: viewer?.id } })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("sender", "name profilePic email")
      .populate({
        path: "replyTo",
        populate: { path: "sender", select: "name profilePic email" },
      });

    const visible = hiddenUserIds.size
      ? messages.filter((m: any) => !hiddenUserIds.has(m.sender?._id?.toString()))
      : messages;

    // hasMore is derived from the raw (pre-block-filter) page size, not
    // visible.length — filtering out a blocked user's messages can shrink a
    // full page below `limit` for reasons that have nothing to do with
    // history actually running out, which would otherwise make pagination
    // stop early for anyone who happens to have blocked/been blocked by a
    // chatty member of the channel.
    return c.json({ messages: visible || [], hasMore: messages.length === limit }, 200);
  } catch (error) {
    console.error("Error fetching messages:", error);
    return c.json({ error: "Failed to fetch messages" }, 500);
  }
};

export const deleteMessage = async (c: Context) => {
  const { messageId } = c.req.param();
  const user = c.get("user");
  const userId = user?.id;
  const { deleteType } = await c.req.json().catch(() => ({}));
  const io: Server = c.get("io");
  if (!user || !userId) {
    return c.json({ error: "Authentication required" }, 401);
  }
  if (!messageId) {
    return c.json({ error: "Message ID is required" }, 400);
  }
  if (!mongoose.Types.ObjectId.isValid(messageId)) {
    return c.json({ error: "Invalid message ID format" }, 400);
  }
  try {
    const message = await Message.findById(messageId);

    if (!message) {
      return c.json({ error: "Message not found" }, 404);
    }

    // Scoped to "for-everyone" only — mirrors dmController.ts's deleteMessage
    // exactly. A "for-me" hide is a per-viewer visibility flag (deletedFor),
    // not a mutation of the shared message, so any channel member may apply
    // it to their own view regardless of who sent the message (matching the
    // mobile/web client's own canDelete assumption: "any member can hide
    // ANY message from just their own view, sender or not").
    if (deleteType === "for-everyone" && message.sender.toString() !== userId) {
      return c.json(
        { error: "You do not have permission to delete this message" },
        403
      );
    }

    const channelIdString = message.channel?.toString();
    if (!channelIdString) {
      return c.json({ error: "Invalid channel ID" }, 400);
    }

    if (
      deleteType === "for-everyone" &&
      Date.now() - message.createdAt.getTime() > DELETE_FOR_EVERYONE_WINDOW_MS
    ) {
      return c.json(
        { error: "This message is too old to delete for everyone" },
        403
      );
    }

    if (deleteType === "for-everyone") {
      message.deletedForEveryone = true;
      message.content = "[This message was deleted]";
      message.attachmentsV2 = [];
      message.attachments = [];
      await message.save();

      io.to(channelIdString).emit("messageDeleted", {
        messageId,
        type: "for-everyone",
      });

      // Only for "for-everyone" — NOT "for-me". A "for-me" hide is a
      // per-user visibility flag (deletedFor), and a pre-existing chunker
      // quirk (normalize_channel_message) already excludes a whole chunk if
      // ANY member has deletedFor set on it, backwards from the per-user ACL
      // DM/group messages get. Forwarding a delete here would make that
      // worse — an immediate global hide instead of just a stale one until
      // the next re-ingest — so only a genuine for-everyone delete tombstones.
      if (isChatServiceEnabled()) {
        void forwardDeleteContent("source", messageId, "message");
      }
    } else {
      if (!message.deletedFor) {
        message.deletedFor = [];
      }

      if (!message.deletedFor.includes(new mongoose.Types.ObjectId(userId))) {
        message.deletedFor.push(new mongoose.Types.ObjectId(userId));
      }

      await message.save();

      io.to(userId).emit("messageDeletedForMe", {
        messageId,
        type: "for-me",
      });
    }

    await invalidateAfterMessage(channelIdString, message.server?.toString());
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
        resource_type: getCloudinaryResourceType(
          getSharedFileType(attachmentFile.type)
        ),
      });

      if (cloudinaryResponse) {
        newAttachmentUrl = cloudinaryResponse.secure_url;
      }
    }

    const updateOperation: any = {
      $set: {
        content,
        formattedContent: hasMarkdown(content)
          ? markdownToHtml(content)
          : content,
        plainText: markdownToPlainText(content),
        edited: true,
      },
    };

    if (newAttachmentUrl) {
      updateOperation.$push = { attachments: newAttachmentUrl };
    }

    const updatedMessage = await Message.findByIdAndUpdate(
      messageId,
      updateOperation,
      { new: true }
    )
      .populate("sender", "name profilePic email")
      .populate({
        path: "replyTo",
        populate: { path: "sender", select: "name profilePic email" },
      });

    if (!updatedMessage) {
      return c.json({ error: "Message not found" }, 404);
    }

    const channelIdString = updatedMessage.channel?.toString();
    if (channelIdString) {
      io.to(channelIdString).emit("messageUpdated", updatedMessage);
      await invalidateAfterMessage(channelIdString, updatedMessage.server?.toString());
    }

    return c.json(updatedMessage, 200);
  } catch (error) {
    console.error("Error updating message:", error);
    return c.json({ error: "Failed to update message" }, 500);
  }
};

export const toggleReaction = async (c: Context) => {
  const { messageId } = c.req.param();
  const { emoji, channelId } = await c.req.json();
  const user = c.get("user");
  const io: Server = c.get("io");

  if (!user) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  if (
    !mongoose.Types.ObjectId.isValid(messageId) ||
    !mongoose.Types.ObjectId.isValid(channelId)
  )
    return c.json({ error: "Invalid ID format" }, 400);

  try {
    const message = await Message.findById(messageId);
    if (!message) return c.json({ error: "Message not found" }, 404);

    const userIdString = user.id;
    const userObjectId = new mongoose.Types.ObjectId(user.id);

    const reactionIndex = message.reactions.findIndex((r) => r.emoji === emoji);
    const hasThisReaction =
      reactionIndex > -1 &&
      message.reactions[reactionIndex].users.some(
        (u) => u.toString() === userIdString
      );

    if (hasThisReaction) {
      const userIndex = message.reactions[reactionIndex].users.findIndex(
        (u) => u.toString() === userIdString
      );
      message.reactions[reactionIndex].users.splice(userIndex, 1);

      if (message.reactions[reactionIndex].users.length === 0) {
        message.reactions.splice(reactionIndex, 1);
      }
    } else {
      for (const reaction of message.reactions) {
        const userIndex = reaction.users.findIndex(
          (u) => u.toString() === userIdString
        );
        if (userIndex > -1) {
          reaction.users.splice(userIndex, 1);
        }
      }

      message.reactions = message.reactions.filter((r) => r.users.length > 0);

      const newReactionIndex = message.reactions.findIndex(
        (r) => r.emoji === emoji
      );
      if (newReactionIndex > -1) {
        message.reactions[newReactionIndex].users.push(userObjectId);
      } else {
        message.reactions.push({ emoji, users: [userObjectId] });
      }
    }

    await message.save();

    io.to(channelId).emit("reactionUpdated", {
      messageId: message._id,
      reactions: message.reactions,
    });

    return c.json(
      {
        message: "Reaction updated successfully",
        reactions: message.reactions,
      },
      200
    );
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
