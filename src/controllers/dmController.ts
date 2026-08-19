import { Context } from "hono";
import mongoose from "mongoose";
import Conversation from "../models/Conversation.ts";
import Message from "../models/Message.ts";
import User from "../models/User.ts";
import ConversationReadStatus from "../models/ConversationReadStatus.ts";
import { Server } from "socket.io";
import {
  invalidateAfterDM,
  invalidateAfterFollowChange,
} from "../lib/cacheInvalidation.ts";
import { formatSingleConversationForUser } from "../lib/dmFormatting.ts";
import { isMemberDmBlocked } from "../lib/serverPrivacy.ts";
import { forwardDeleteContent, isChatServiceEnabled } from "../lib/chatServiceClient.ts";
import { isValidChatTheme } from "../constants/chatThemes.ts";
import { createNotification, sendNotificationViaSocket } from "./notificationController.ts";

/**
 * Emits a lightweight conversation-list update to each participant's personal
 * room (every socket auto-joins its own `userId` room on connect). This is what
 * keeps the DM sidebar live — ordering, last-message preview and unread badges —
 * for conversations that are NOT currently open. The existing room-scoped events
 * (`dm:new-message`, `messageUpdated`, ...) are preserved for the open chat.
 */
export const emitConversationActivity = (
  io: Server | undefined,
  participantIds: (string | mongoose.Types.ObjectId)[],
  payload: {
    conversationId: string;
    type: "new" | "edit" | "delete";
    senderId?: string;
    messageId?: string;
    lastMessage?: unknown;
  }
) => {
  if (!io) return;
  for (const pid of participantIds) {
    if (!pid) continue;
    io.to(pid.toString()).emit("conversation:activity", payload);
  }
};

// Only gates "for-everyone" — un-sending a message the other participant(s)
// can already see. "for-me" (hiding it from your own view only) never
// affects anyone else, so it stays available regardless of age.
const DELETE_FOR_EVERYONE_WINDOW_MS = 24 * 60 * 60 * 1000;

export const createDm = async (c: Context) => {
  const senderId = c.get("user").id;
  const { receiverId, content, attachments, gifUrl, stickerUrl, replyTo } =
    await c.req.json();
  const io = c.get("io") as Server | undefined;

  const hasAttachments =
    (Array.isArray(attachments) && attachments.length > 0) ||
    !!gifUrl ||
    !!stickerUrl;

  if (!senderId || !receiverId || (!content && !hasAttachments)) {
    return c.json({ error: "Missing required fields" }, 400);
  }
  if (
    !mongoose.Types.ObjectId.isValid(senderId) ||
    !mongoose.Types.ObjectId.isValid(receiverId)
  ) {
    return c.json({ error: "Invalid ID format" }, 400);
  }

  try {
    const sender = await User.findById(senderId);
    if (!sender) {
      return c.json({ error: "Sender not found" }, 404);
    }

    const receiver = await User.findById(receiverId);
    if (!receiver) {
      return c.json({ error: "Receiver not found" }, 404);
    }

    if (receiver.blockedUsers?.some((u) => u.toString() === senderId)) {
      return c.json({ error: "You cannot send messages to this user" }, 403);
    }

    if (sender.blockedUsers?.some((u) => u.toString() === receiverId)) {
      return c.json(
        { error: "You have blocked this user. Unblock them to send messages." },
        403
      );
    }

    const isFriend = sender.friends?.includes(
      mongoose.Types.ObjectId.createFromHexString(receiverId)
    );

    if (!isFriend) {
      return c.json(
        { error: "You can only message friends. Send a friend request first." },
        403
      );
    }

    if (await isMemberDmBlocked(senderId, receiverId)) {
      return c.json(
        {
          error:
            "Direct messages are disabled between members of a community you share.",
        },
        403
      );
    }

    const participants = [senderId, receiverId].sort();

    let conversation = await Conversation.findOne({
      participants: { $all: participants },
    });

    if (!conversation) {
      conversation = await Conversation.create({ participants });
    }

    // Build the typed attachment list. GIFs/stickers arrive as URLs (from the
    // picker); files arrive as already-uploaded metadata (from /attachments/upload).
    const attachmentsV2: Array<Record<string, unknown>> = [];
    if (gifUrl) {
      attachmentsV2.push({ url: gifUrl, type: "gif", mimeType: "image/gif" });
    }
    if (stickerUrl) {
      attachmentsV2.push({
        url: stickerUrl,
        type: "sticker",
        mimeType: "image/png",
      });
    }
    if (Array.isArray(attachments)) {
      for (const a of attachments) {
        if (a && a.url) attachmentsV2.push(a);
      }
    }

    const newMessage = await Message.create({
      content: content ?? "",
      sender: senderId,
      conversationId: conversation._id,
      attachments: attachmentsV2.map((a) => a.url as string),
      attachmentsV2,
      replyTo: replyTo || undefined,
    });

    // Keep the conversation's denormalized message list current and bump
    // updatedAt. Sending a message also un-hides / un-deletes the conversation
    // for both participants (it just became active again). We must ALSO clear
    // each participant's per-user `deletedAt` cutoff — otherwise the conversation
    // resurfaces in the list but reads still filter out all history before the
    // old cutoff, producing a "ghost" empty conversation.
    await Conversation.findByIdAndUpdate(conversation._id, {
      $push: { messages: newMessage._id },
      $pull: {
        hiddenFor: { $in: [senderId, receiverId] },
        deletedFor: { $in: [senderId, receiverId] },
      },
      $unset: {
        [`deletedAt.${senderId}`]: "",
        [`deletedAt.${receiverId}`]: "",
      },
    });

    const populatedMessage = await Message.findById(newMessage._id)
      .populate({
        path: "sender",
        select: "name profilePic email about",
      })
      .populate({
        path: "replyTo",
        populate: { path: "sender", select: "name profilePic email" },
      });

    if (io) {
      // Open chat (participants currently in the conversation room).
      io.to(conversation._id.toString()).emit(
        "dm:new-message",
        populatedMessage
      );
      // Sidebar/list update for everyone — even with the chat closed.
      emitConversationActivity(io, participants, {
        conversationId: conversation._id.toString(),
        type: "new",
        senderId: senderId.toString(),
        messageId: newMessage._id.toString(),
        lastMessage: populatedMessage,
      });
    }

    // Every OTHER notification type in this app (calls, mentions, group-add,
    // moderation) creates a Notification, which is what actually triggers a
    // browser push (see notificationController.ts's createNotification ->
    // sendPushToUser) — an ordinary DM never did, so the socket emits above
    // were the ONLY delivery path: zero notification reached a backgrounded
    // tab or a closed app, even though the whole push pipeline (VAPID,
    // service worker, subscription) was already fully working for
    // everything else. A DM is inherently addressed directly at the
    // recipient — unlike a channel message, there's no "not a mention" case
    // — so this only respects "none" (fully opted out) and this specific
    // conversation being muted, not the "mentions"-only level (which exists
    // to suppress channel noise, not 1:1 messages).
    //
    // Deliberately OUTSIDE the `if (io)` block above: app.ts's io-attaching
    // middleware swallows a "Socket.IO instance not initialized yet" error
    // into a silent `c.set("io", undefined)` during the brief startup
    // window (and unconditionally in test runs) — nesting push delivery
    // inside that same `if (io)` meant a request landing in that window
    // still saved the message and returned 201, but silently skipped the
    // recipient's notification entirely, reproducing the exact "invisible
    // from the sender's point of view" failure this was meant to fix.
    // Notification creation (and the push it triggers) has no real
    // dependency on the realtime layer being up; only the optional
    // in-app-toast socket emit does.
    try {
      const level = receiver.settings?.notifications?.level || "all";
      const isMuted = (receiver.settings?.mutedConversations || []).some(
        (id) => id?.toString() === conversation._id.toString()
      );
      if (level !== "none" && !isMuted) {
        const senderName = sender.name || "Someone";
        const snippet = content
          ? String(content).slice(0, 140)
          : hasAttachments
            ? "📎 Sent an attachment"
            : "";
        const notification = await createNotification({
          recipient: receiverId,
          sender: senderId,
          type: "dm_message",
          title: senderName,
          message: snippet,
          metadata: { conversationId: conversation._id.toString(), messageId: newMessage._id.toString() },
          actionUrl: `${process.env.FRONTEND_URL || "http://localhost:3000"}/community/me?conversation=${conversation._id.toString()}`,
        });
        if (notification && io) sendNotificationViaSocket(io, receiverId, notification);
      }
    } catch (err) {
      console.error("Failed to create DM message notification:", err);
    }

    await invalidateAfterDM(conversation._id.toString(), senderId);
    return c.json(populatedMessage ?? newMessage, 201);
  } catch (error) {
    console.error("Error creating DM:", error);
    return c.json({ error: "Failed to create DM" }, 500);
  }
};
/**
 * Finds the existing conversation with `receiverId`, restoring it (unhiding /
 * un-deleting) for the CALLING user only if they'd previously removed it —
 * mirrors unhideConversation's per-user model, so opening the chat from this
 * side never silently un-hides it for the other participant too.
 *
 * When no conversation exists yet, this deliberately does NOT create one:
 * createDm creates the row atomically with the first message, so the other
 * participant never sees an empty thread before anything is said. Callers
 * get `{ exists: false }` and fall back to lazy create-on-first-send.
 */
export const findOrRestoreDm = async (c: Context) => {
  const currentUserId = c.get("user").id;
  const { receiverId } = await c.req.json().catch(() => ({}));
  const io = c.get("io") as Server | undefined;

  if (
    !receiverId ||
    !mongoose.Types.ObjectId.isValid(receiverId) ||
    !mongoose.Types.ObjectId.isValid(currentUserId)
  ) {
    return c.json({ error: "Invalid ID format" }, 400);
  }
  if (receiverId === currentUserId) {
    return c.json({ error: "Cannot start a conversation with yourself" }, 400);
  }

  try {
    const me = await User.findById(currentUserId).select(
      "friends blockedUsers"
    );
    if (!me) return c.json({ error: "User not found" }, 404);

    const other = await User.findById(receiverId).select("blockedUsers");
    if (!other) return c.json({ error: "Receiver not found" }, 404);

    if (other.blockedUsers?.some((u) => u.toString() === currentUserId)) {
      return c.json({ error: "You cannot message this user" }, 403);
    }
    if (me.blockedUsers?.some((u) => u.toString() === receiverId)) {
      return c.json(
        { error: "You have blocked this user. Unblock them to send messages." },
        403
      );
    }

    const isFriend = me.friends?.some((f) => f.toString() === receiverId);
    if (!isFriend) {
      return c.json(
        { error: "You can only message friends. Send a friend request first." },
        403
      );
    }

    const participants = [currentUserId, receiverId].sort();
    const conversation = await Conversation.findOne({
      participants: { $all: participants },
    });

    if (!conversation) {
      return c.json({ exists: false }, 200);
    }

    const wasHiddenOrDeleted = !!(
      conversation.hiddenFor?.some((u) => u?.toString() === currentUserId) ||
      conversation.deletedFor?.some((u) => u?.toString() === currentUserId) ||
      conversation.deletedAt?.get(currentUserId.toString())
    );

    if (wasHiddenOrDeleted) {
      conversation.hiddenFor = (conversation.hiddenFor ?? []).filter(
        (u) => u?.toString() !== currentUserId
      );
      conversation.deletedFor = (conversation.deletedFor ?? []).filter(
        (u) => u?.toString() !== currentUserId
      );
      conversation.deletedAt?.delete(currentUserId.toString());
      await conversation.save();
    }

    const populated = await Conversation.findById(conversation._id).populate({
      path: "participants",
      select: "name email profilePic lastSeen settings",
      match: { _id: { $ne: currentUserId } },
    });
    if (!populated) return c.json({ error: "Conversation not found" }, 404);

    const formatted = await formatSingleConversationForUser(
      populated,
      currentUserId
    );

    if (wasHiddenOrDeleted) {
      if (io) {
        io.to(currentUserId.toString()).emit("conversation:restored", {
          conversationId: conversation._id.toString(),
        });
      }
      await invalidateAfterDM(conversation._id.toString(), currentUserId);
    }

    return c.json({ exists: true, conversation: formatted }, 200);
  } catch (error) {
    console.error("Error finding/restoring DM:", error);
    return c.json({ error: "Failed to open conversation" }, 500);
  }
};

export const getDm = async (c: Context) => {
  const { conversationId } = c.req.param();
  const user = c.get("user");

  if (!mongoose.Types.ObjectId.isValid(conversationId))
    return c.json({ error: "Invalid ID format" }, 400);

  const limitRaw = parseInt(c.req.query("limit") || "50", 10);
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(limitRaw, 1), 100)
    : 50;
  const cursor = c.req.query("cursor");
  if (cursor && !mongoose.Types.ObjectId.isValid(cursor)) {
    return c.json({ error: "Invalid cursor" }, 400);
  }

  try {
    const conversation = await Conversation.findById(conversationId).select(
      "participants deletedAt"
    );
    if (!conversation) return c.json({ error: "Conversation not found" }, 404);

    const isParticipant = conversation.participants?.some(
      (p) => p?.toString() === user?.id?.toString()
    );
    if (!isParticipant) {
      return c.json(
        { error: "You are not a participant of this conversation" },
        403
      );
    }

    const deletedAt = conversation.deletedAt?.get(user?.id?.toString());

    const messageQuery: any = {
      conversationId,
      deletedFor: { $ne: user.id },
    };
    if (deletedAt) messageQuery.createdAt = { $gt: deletedAt };
    if (cursor) messageQuery._id = { $lt: cursor };

    const page = await Message.find(messageQuery)
      .populate({
        path: "sender",
        select: "name profilePic email about",
      })
      .populate({
        path: "replyTo",
        populate: { path: "sender", select: "name profilePic email" },
      })
      .sort({ _id: -1 })
      .limit(limit + 1);

    const hasMore = page.length > limit;
    const trimmed = hasMore ? page.slice(0, limit) : page;
    const nextCursor = hasMore ? trimmed[trimmed.length - 1]._id : null;

    return c.json(
      { messages: trimmed.reverse(), nextCursor, hasMore },
      200
    );
  } catch (error) {
    console.error("Error fetching DM:", error);
    return c.json({ error: "Failed to fetch DM" }, 500);
  }
};
export const editMessage = async (c: Context) => {
  const { conversationId } = c.req.param();
  const { content, messageId } = await c.req.json();
  const userId = c.get("user").id;

  const io = c.get("io") as Server | undefined;

  if (!content) {
    return c.json({ error: "Content is required" }, 400);
  }
  if (
    !mongoose.Types.ObjectId.isValid(messageId) ||
    !mongoose.Types.ObjectId.isValid(conversationId)
  ) {
    return c.json({ error: "Invalid ID format" }, 400);
  }

  try {
    const updatedMessage = await Message.findOneAndUpdate(
      { _id: messageId, sender: userId },
      { content, edited: true },
      { new: true }
    )
      .populate({ path: "sender", select: "name profilePic email about" })
      .populate({
        path: "replyTo",
        populate: { path: "sender", select: "name profilePic email" },
      });

    if (!updatedMessage) {
      return c.json(
        { error: "Message not found or you don't have permission to edit it." },
        404
      );
    }

    if (io) {
      io.to(conversationId).emit("messageUpdated", updatedMessage);

      const conversation = await Conversation.findById(conversationId).select(
        "participants"
      );
      emitConversationActivity(io, conversation?.participants ?? [], {
        conversationId,
        type: "edit",
        messageId: messageId.toString(),
        lastMessage: updatedMessage,
      });
    }

    await invalidateAfterDM(conversationId, userId);
    return c.json(updatedMessage, 200);
  } catch (error) {
    console.error("Error editing message:", error);
    return c.json({ error: "Failed to edit message" }, 500);
  }
};
export const deleteMessage = async (c: Context) => {
  const { conversationId } = c.req.param();
  const { messageId, deleteType } = await c.req.json();
  const userId = c.get("user").id;
  if (
    !mongoose.Types.ObjectId.isValid(messageId) ||
    !mongoose.Types.ObjectId.isValid(conversationId)
  )
    return c.json({ error: "Invalid ID format" }, 400);
  const io = c.get("io") as Server | undefined;
  try {
    const message = await Message.findById(messageId);
    if (!message) {
      return c.json({ error: "Message not found" }, 404);
    }

    if (
      deleteType === "for-everyone" &&
      message.sender.toString() !== userId.toString()
    ) {
      return c.json({ error: "Only the sender can delete for everyone" }, 403);
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

      if (io) {
        io.to(conversationId).emit("messageDeleted", {
          messageId,
          type: "for-everyone",
        });

        const conversation = await Conversation.findById(conversationId).select(
          "participants"
        );
        emitConversationActivity(io, conversation?.participants ?? [], {
          conversationId,
          type: "delete",
          messageId: messageId.toString(),
        });
      }

      // Only for "for-everyone" — a "for-me" hide is per-user (deletedFor)
      // and must not remove the message from search for the other
      // participant. Best-effort — the Mongo update already committed
      // either way.
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

      if (io) {
        io.to(userId).emit("messageDeletedForMe", {
          messageId,
          type: "for-me",
        });
        // Only the acting user's preview can change for a "for-me" delete.
        emitConversationActivity(io, [userId], {
          conversationId,
          type: "delete",
          messageId: messageId.toString(),
        });
      }
    }

    await invalidateAfterDM(conversationId, userId);
    return c.json({ message: "Message deleted successfully" }, 200);
  } catch (error) {
    console.error("Error deleting message:", error);
    return c.json({ error: "Failed to delete message" }, 500);
  }
};
export const deleteDm = async (c: Context) => {
  const { conversationId } = c.req.param();
  const userId = c.get("user").id;
  const io = c.get("io") as Server | undefined;
  if (!mongoose.Types.ObjectId.isValid(conversationId))
    return c.json({ error: "Invalid ID format" }, 400);
  try {
    const deletedConversation = await Conversation.findOneAndUpdate(
      {
        _id: conversationId,
        participants: { $in: [userId] },
      },
      { $pull: { participants: userId } },
      { new: true }
    );
    if (!deletedConversation) {
      return c.json(
        { error: "Conversation not found or user is not a participant." },
        404
      );
    }
    if (!deletedConversation.participants.length) {
      await Message.deleteMany({ conversationId });
      await Conversation.findByIdAndDelete(conversationId);

      // Best-effort — the Mongo deletes have already committed either way;
      // a failure here only means this conversation's messages keep
      // surfacing through search/the assistant a while longer.
      if (isChatServiceEnabled()) {
        void forwardDeleteContent("conversation", conversationId);
      }
    } else {
      if (io) {
        io.to(conversationId).emit("conversationUpdated", deletedConversation);
      }
    }
    await invalidateAfterDM(conversationId, userId);
    return c.json({ message: "DM deleted successfully" }, 200);
  } catch (error) {
    console.error("Error deleting DM:", error);
    return c.json({ error: "Failed to delete DM" }, 500);
  }
};

export const hideConversation = async (c: Context) => {
  const { conversationId } = c.req.param();
  const user = c.get("user");
  const io = c.get("io") as Server | undefined;

  if (!mongoose.Types.ObjectId.isValid(conversationId))
    return c.json({ error: "Invalid ID format" }, 400);

  try {
    const conversation = await Conversation.findById(conversationId);
    if (!conversation) {
      return c.json({ error: "Conversation not found" }, 404);
    }

    const isParticipant = conversation.participants?.some(
      (p) => p?.toString() === user?.id?.toString()
    );

    if (!isParticipant) {
      return c.json(
        { error: "You are not a participant of this conversation" },
        403
      );
    }

    if (!conversation.hiddenFor) {
      conversation.hiddenFor = [];
    }

    conversation.hiddenFor = conversation.hiddenFor.filter(
      (u) => u !== null && u !== undefined
    );

    const alreadyHidden = conversation.hiddenFor.some(
      (u) => u && u.toString() === user.id?.toString()
    );

    if (!alreadyHidden) {
      conversation.hiddenFor.push(new mongoose.Types.ObjectId(user.id));
      await conversation.save();
    }

    // Sync removal to all of THIS user's other tabs/devices. Scoped to the
    // acting user's personal room only — hiding is per-user, the other
    // participant must not be affected. Reuses the existing event the frontend
    // already handles (useDirectMessages onRemoved).
    if (io) {
      io.to(user.id.toString()).emit("conversation:removed", {
        conversationId,
      });
    }

    return c.json({ message: "Conversation hidden successfully" }, 200);
  } catch (error) {
    console.error("Error hiding conversation:", error);
    return c.json({ error: "Failed to hide conversation" }, 500);
  }
};

export const unhideConversation = async (c: Context) => {
  const { conversationId } = c.req.param();
  const user = c.get("user");
  const io = c.get("io") as Server | undefined;

  if (!mongoose.Types.ObjectId.isValid(conversationId))
    return c.json({ error: "Invalid ID format" }, 400);

  try {
    const conversation = await Conversation.findById(conversationId);
    if (!conversation) {
      return c.json({ error: "Conversation not found" }, 404);
    }

    const isParticipant = conversation.participants?.some(
      (p) => p?.toString() === user?.id?.toString()
    );

    if (!isParticipant) {
      return c.json(
        { error: "You are not a participant of this conversation" },
        403
      );
    }

    if (conversation.hiddenFor) {
      conversation.hiddenFor = conversation.hiddenFor.filter(
        (u) => u && u.toString() !== user.id?.toString()
      );
      await conversation.save();
    }

    // Tell this user's other tabs/devices to pull the conversation back into
    // the list. Scoped to the acting user's personal room only.
    if (io) {
      io.to(user.id.toString()).emit("conversation:restored", {
        conversationId,
      });
    }

    return c.json({ message: "Conversation unhidden successfully" }, 200);
  } catch (error) {
    console.error("Error unhiding conversation:", error);
    return c.json({ error: "Failed to unhide conversation" }, 500);
  }
};

export const getHiddenConversations = async (c: Context) => {
  const user = c.get("user");
  const userId = user.id;

  if (!mongoose.Types.ObjectId.isValid(userId))
    return c.json({ error: "Invalid user ID" }, 400);

  try {
    const userObjectId = new mongoose.Types.ObjectId(userId);
    const conversations = (await Conversation.find({
      participants: { $in: [userObjectId] },
      hiddenFor: { $in: [userObjectId] },
    })
      .populate({
        path: "participants",
        select: "name email profilePic lastSeen",
        match: { _id: { $ne: userId } },
      })
      .sort({ updatedAt: -1 })
      .lean()) as any[];

    const formatted = conversations.map((conv) => ({
      _id: conv._id,
      participants: conv.participants,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
    }));

    return c.json({ conversations: formatted }, 200);
  } catch (error) {
    console.error("Error fetching hidden conversations:", error);
    return c.json({ error: "Failed to fetch hidden conversations" }, 500);
  }
};

export const deleteConversationForUser = async (c: Context) => {
  const { conversationId } = c.req.param();
  const user = c.get("user");
  const io = c.get("io") as Server | undefined;

  if (!mongoose.Types.ObjectId.isValid(conversationId))
    return c.json({ error: "Invalid ID format" }, 400);

  try {
    const conversation = await Conversation.findById(conversationId);
    if (!conversation) {
      return c.json({ error: "Conversation not found" }, 404);
    }

    const isParticipant = conversation.participants?.some((p) => {
      return p?.toString() === user?.id?.toString();
    });

    if (!isParticipant) {
      return c.json(
        { error: "You are not a participant of this conversation" },
        403
      );
    }

    if (!conversation.deletedFor) {
      conversation.deletedFor = [];
    }

    conversation.deletedFor = conversation.deletedFor.filter(
      (u) => u !== null && u !== undefined
    );

    const alreadyDeleted = conversation.deletedFor.some(
      (u) => u && u?.toString() === user?.id?.toString()
    );

    if (!alreadyDeleted) {
      conversation.deletedFor.push(new mongoose.Types.ObjectId(user.id));

      if (!conversation.deletedAt) {
        conversation.deletedAt = new Map();
      }
      conversation.deletedAt.set(user?.id?.toString(), new Date());

      await conversation.save();
    }

    // Per-user delete: sync removal to this user's other tabs/devices only.
    if (io) {
      io.to(user.id.toString()).emit("conversation:removed", {
        conversationId,
      });
    }

    return c.json({ message: "Conversation deleted successfully" }, 200);
  } catch (error) {
    console.error("Error deleting conversation:", error);
    return c.json({ error: "Failed to delete conversation" }, 500);
  }
};

/**
 * "Clear chat" — wipe the message history for THIS user only while keeping the
 * conversation in their list (composer stays usable, empty state shown). Unlike
 * deleteConversationForUser this does NOT add to `deletedFor`, so the row stays
 * visible; it only sets the per-user `deletedAt` cutoff so reads filter out all
 * prior messages. Per-user + reversible-on-new-message, reuses existing schema.
 */
export const clearConversation = async (c: Context) => {
  const { conversationId } = c.req.param();
  const user = c.get("user");
  const io = c.get("io") as Server | undefined;

  if (!mongoose.Types.ObjectId.isValid(conversationId))
    return c.json({ error: "Invalid ID format" }, 400);

  try {
    const conversation = await Conversation.findById(conversationId);
    if (!conversation) {
      return c.json({ error: "Conversation not found" }, 404);
    }

    const isParticipant = conversation.participants?.some(
      (p) => p?.toString() === user?.id?.toString()
    );
    if (!isParticipant) {
      return c.json(
        { error: "You are not a participant of this conversation" },
        403
      );
    }

    if (!conversation.deletedAt) conversation.deletedAt = new Map();
    conversation.deletedAt.set(user?.id?.toString(), new Date());
    await conversation.save();

    // Empty the open thread on every device of this user (the chat listens for
    // this and resets its messages; the conversation row stays in the list).
    if (io) {
      io.to(user.id.toString()).emit("conversation:cleared", {
        conversationId,
      });
    }

    return c.json({ message: "Conversation cleared successfully" }, 200);
  } catch (error) {
    console.error("Error clearing conversation:", error);
    return c.json({ error: "Failed to clear conversation" }, 500);
  }
};

export const blockUser = async (c: Context) => {
  const { userId } = c.req.param();
  const currentUser = c.get("user");
  const io = c.get("io") as Server | undefined;

  if (!mongoose.Types.ObjectId.isValid(userId))
    return c.json({ error: "Invalid ID format" }, 400);

  if (userId === currentUser.id) {
    return c.json({ error: "You cannot block yourself" }, 400);
  }

  try {
    const userToBlock = await User.findById(userId).select(
      "name email profilePic about"
    );
    if (!userToBlock) {
      return c.json({ error: "User not found" }, 404);
    }

    const user = await User.findById(currentUser.id);
    if (!user) {
      return c.json({ error: "Current user not found" }, 404);
    }

    user.blockedUsers ??= [];

    const alreadyBlocked = user.blockedUsers.some(
      (u) => u?.toString() === userId.toString()
    );

    if (alreadyBlocked) {
      return c.json({ message: "User is already blocked" }, 200);
    }

    user.blockedUsers.push(mongoose.Types.ObjectId.createFromHexString(userId));
    await user.save();

    // What happens to the conversation is the blocker's choice.
    // keep = leave it visible · hide = hide for blocker · delete = remove for blocker.
    const body = (await c.req.json().catch(() => ({}))) as {
      conversationAction?: "keep" | "hide" | "delete";
    };
    const conversationAction = (
      ["keep", "hide", "delete"].includes(body.conversationAction ?? "")
        ? body.conversationAction
        : "hide"
    ) as "keep" | "hide" | "delete";

    const blockerId = mongoose.Types.ObjectId.createFromHexString(
      currentUser.id
    );
    const affectedConversationIds: string[] = [];

    if (conversationAction !== "keep") {
      const conversations = await Conversation.find({
        participants: { $all: [currentUser.id, userId] },
      });

      for (const conversation of conversations) {
        if (conversationAction === "hide") {
          conversation.hiddenFor = (conversation.hiddenFor ?? []).filter(
            (u) => u !== null && u !== undefined
          );
          if (
            !conversation.hiddenFor.some((u) => u?.toString() === currentUser.id)
          ) {
            conversation.hiddenFor.push(blockerId);
          }
        } else {
          // delete (per-user)
          conversation.deletedFor = (conversation.deletedFor ?? []).filter(
            (u) => u !== null && u !== undefined
          );
          if (
            !conversation.deletedFor.some(
              (u) => u?.toString() === currentUser.id
            )
          ) {
            conversation.deletedFor.push(blockerId);
          }
          if (!conversation.deletedAt) conversation.deletedAt = new Map();
          conversation.deletedAt.set(currentUser.id, new Date());
        }
        await conversation.save();
        affectedConversationIds.push(conversation._id.toString());
      }
    }

    if (io) {
      io.to(currentUser.id).emit("user:blocked", {
        blockedBy: currentUser.id,
        blockedUser: userId,
      });
      // Remove the conversation from the blocker's list on every device.
      for (const convId of affectedConversationIds) {
        io.to(currentUser.id).emit("conversation:removed", {
          conversationId: convId,
        });
      }
    }

    // Blocking changes what this pair may see of each other in cached
    // follow/profile responses (areBlocked gates those reads).
    await invalidateAfterFollowChange(currentUser.id, userId);

    return c.json(
      {
        message: "User blocked successfully",
        conversationAction,
        conversationIds: affectedConversationIds,
        blockedUser: {
          _id: userToBlock._id,
          name: userToBlock.name,
          email: userToBlock.email,
          profilePic: userToBlock.profilePic,
          about: userToBlock.about,
        },
      },
      200
    );
  } catch (error) {
    console.error("Error blocking user:", error);
    return c.json({ error: "Failed to block user" }, 500);
  }
};

export const unblockUser = async (c: Context) => {
  const { userId } = c.req.param();
  const currentUser = c.get("user");
  const io = c.get("io") as Server | undefined;

  if (!mongoose.Types.ObjectId.isValid(userId))
    return c.json({ error: "Invalid ID format" }, 400);

  try {
    const userToUnblock = await User.findById(userId).select(
      "name email profilePic about"
    );
    if (!userToUnblock) {
      return c.json({ error: "User not found" }, 404);
    }

    const user = await User.findById(currentUser.id);
    if (!user) {
      return c.json({ error: "User not found" }, 404);
    }

    if (!user.blockedUsers || user.blockedUsers.length === 0) {
      return c.json({ message: "User is not blocked" }, 200);
    }

    const isBlocked = user.blockedUsers.some(
      (u) => u.toString() === userId.toString()
    );

    if (!isBlocked) {
      return c.json({ message: "User is not blocked" }, 200);
    }

    user.blockedUsers = user.blockedUsers.filter(
      (u) => u.toString() !== userId.toString()
    );
    await user.save();

    const conversations = await Conversation.find({
      participants: { $all: [currentUser.id, userId] },
    });

    // Fully reverse whatever the block did to the conversation: un-hide AND
    // un-delete (block could have used "delete"), and clear the per-user
    // deletedAt cutoff so prior history is visible again. Symmetric with block.
    const restoredConversationIds: string[] = [];
    for (const conversation of conversations) {
      let changed = false;
      if (conversation.hiddenFor?.some((u) => u?.toString() === currentUser.id)) {
        conversation.hiddenFor = conversation.hiddenFor.filter(
          (u) => u?.toString() !== currentUser.id
        );
        changed = true;
      }
      if (
        conversation.deletedFor?.some((u) => u?.toString() === currentUser.id)
      ) {
        conversation.deletedFor = conversation.deletedFor.filter(
          (u) => u?.toString() !== currentUser.id
        );
        changed = true;
      }
      if (conversation.deletedAt?.has(currentUser.id)) {
        conversation.deletedAt.delete(currentUser.id);
        changed = true;
      }
      if (changed) {
        await conversation.save();
        restoredConversationIds.push(conversation._id.toString());
      }
    }

    if (io) {
      io.to(currentUser.id).emit("user:unblocked", {
        unblockedBy: currentUser.id,
        unblockedUser: userId,
      });
      // Bring the conversation back on every device of the unblocker.
      for (const convId of restoredConversationIds) {
        io.to(currentUser.id).emit("conversation:restored", {
          conversationId: convId,
        });
      }
    }

    // Symmetric with blockUser: cached follow/profile reads between the pair
    // are gated on the block relationship that just changed.
    await invalidateAfterFollowChange(currentUser.id, userId);

    return c.json(
      {
        message: "User unblocked successfully",
        unblockedUser: {
          _id: userToUnblock._id,
          name: userToUnblock.name,
          email: userToUnblock.email,
          profilePic: userToUnblock.profilePic,
          about: userToUnblock.about,
        },
      },
      200
    );
  } catch (error) {
    console.error("Error unblocking user:", error);
    return c.json({ error: "Failed to unblock user" }, 500);
  }
};

export const getBlockedUsers = async (c: Context) => {
  const currentUser = c.get("user");

  try {
    const user = await User.findById(currentUser.id).populate(
      "blockedUsers",
      "name email profilePic about lastSeen"
    );

    if (!user) {
      return c.json({ error: "User not found" }, 404);
    }

    const blockedUsers = (user.blockedUsers || []).map((blockedUser: any) => ({
      _id: blockedUser._id,
      name: blockedUser.name,
      email: blockedUser.email,
      profilePic: blockedUser.profilePic,
      about: blockedUser.about,
      lastSeen: blockedUser.lastSeen,
    }));

    return c.json(
      {
        blockedUsers,
        count: blockedUsers.length,
      },
      200
    );
  } catch (error) {
    console.error("Error fetching blocked users:", error);
    return c.json({ error: "Failed to fetch blocked users" }, 500);
  }
};

/**
 * Marks a conversation as read for the current user up to its latest message.
 * Upserts a ConversationReadStatus row (the source of truth for unread counts)
 * and notifies the user's OTHER devices so unread badges clear everywhere.
 */
export const markConversationRead = async (c: Context) => {
  const { conversationId } = c.req.param();
  const userId = c.get("user").id;
  const io = c.get("io") as Server | undefined;

  if (!mongoose.Types.ObjectId.isValid(conversationId))
    return c.json({ error: "Invalid ID format" }, 400);

  try {
    const conversation = await Conversation.findById(conversationId).select(
      "participants"
    );
    if (!conversation) {
      return c.json({ error: "Conversation not found" }, 404);
    }

    const isParticipant = conversation.participants?.some(
      (p) => p?.toString() === userId.toString()
    );
    if (!isParticipant) {
      return c.json(
        { error: "You are not a participant of this conversation" },
        403
      );
    }

    const latestMessage = await Message.findOne({ conversationId })
      .sort({ createdAt: -1 })
      .select("_id");

    await ConversationReadStatus.findOneAndUpdate(
      { user: userId, conversation: conversationId },
      {
        lastReadMessage: latestMessage?._id,
        lastReadAt: new Date(),
      },
      { upsert: true, new: true }
    );

    const now = new Date();

    if (io) {
      // Sync read state across this user's devices (the personal room).
      io.to(userId.toString()).emit("conversation:read", {
        conversationId,
        userId: userId.toString(),
      });

      // Notify OTHER participants that this user has seen the conversation.
      const otherIds = conversation.participants?.filter(
        (p) => p?.toString() !== userId.toString()
      ) ?? [];
      for (const otherId of otherIds) {
        io.to(otherId.toString()).emit("message:seen", {
          conversationId,
          seenAt: now.toISOString(),
        });
      }
    }

    return c.json({ message: "Conversation marked as read" }, 200);
  } catch (error) {
    console.error("Error marking conversation as read:", error);
    return c.json({ error: "Failed to mark conversation as read" }, 500);
  }
};

/**
 * Marks the conversation as delivered for the current user and notifies
 * other participants so their sent-message ticks advance to "delivered".
 */
export const markConversationDelivered = async (c: Context) => {
  const { conversationId } = c.req.param();
  const userId = c.get("user").id;
  const io = c.get("io") as Server | undefined;

  if (!mongoose.Types.ObjectId.isValid(conversationId))
    return c.json({ error: "Invalid ID format" }, 400);

  try {
    const conversation = await Conversation.findById(conversationId).select(
      "participants"
    );
    if (!conversation) return c.json({ error: "Conversation not found" }, 404);

    const isParticipant = conversation.participants?.some(
      (p) => p?.toString() === userId.toString()
    );
    if (!isParticipant)
      return c.json({ error: "Not a participant" }, 403);

    const latestMessage = await Message.findOne({ conversationId })
      .sort({ createdAt: -1 })
      .select("_id");

    const now = new Date();
    await ConversationReadStatus.findOneAndUpdate(
      { user: userId, conversation: conversationId },
      { lastDeliveredMessage: latestMessage?._id, lastDeliveredAt: now },
      { upsert: true, new: true }
    );

    if (io) {
      const otherIds = conversation.participants?.filter(
        (p) => p?.toString() !== userId.toString()
      ) ?? [];
      for (const otherId of otherIds) {
        io.to(otherId.toString()).emit("message:delivered", {
          conversationId,
          deliveredAt: now.toISOString(),
        });
      }
    }

    return c.json({ message: "Conversation marked as delivered" }, 200);
  } catch (error) {
    console.error("Error marking conversation as delivered:", error);
    return c.json({ error: "Failed to mark as delivered" }, 500);
  }
};

/**
 * Returns the OTHER participant's delivery + read status for this conversation.
 * The sender calls this on mount to hydrate tick display without waiting for a
 * socket event.
 */
export const getConvStatus = async (c: Context) => {
  const { conversationId } = c.req.param();
  const userId = c.get("user").id;

  if (!mongoose.Types.ObjectId.isValid(conversationId))
    return c.json({ error: "Invalid ID format" }, 400);

  try {
    const conversation = await Conversation.findById(conversationId).select(
      "participants"
    );
    if (!conversation) return c.json({ error: "Not found" }, 404);

    const otherParticipant = conversation.participants?.find(
      (p) => p?.toString() !== userId.toString()
    );
    if (!otherParticipant)
      return c.json({ lastDeliveredAt: null, lastSeenAt: null });

    const status = await ConversationReadStatus.findOne({
      user: otherParticipant,
      conversation: conversationId,
    }).select("lastDeliveredAt lastReadAt");

    return c.json({
      lastDeliveredAt: status?.lastDeliveredAt?.toISOString() ?? null,
      lastSeenAt: status?.lastReadAt?.toISOString() ?? null,
    });
  } catch (error) {
    console.error("Error fetching conv status:", error);
    return c.json({ error: "Failed to fetch status" }, 500);
  }
};

/**
 * Files shared in a conversation — flattened from message attachments.
 * Replaces the dead GET /conversation/:id/files the profile panel used to call.
 */
export const getConversationFiles = async (c: Context) => {
  const { conversationId } = c.req.param();
  const userId = c.get("user").id;

  if (!mongoose.Types.ObjectId.isValid(conversationId))
    return c.json({ error: "Invalid ID format" }, 400);

  try {
    const conversation = await Conversation.findById(conversationId).select(
      "participants deletedAt"
    );
    if (!conversation) return c.json({ error: "Conversation not found" }, 404);

    const isParticipant = conversation.participants?.some(
      (p) => p?.toString() === userId.toString()
    );
    if (!isParticipant) {
      return c.json(
        { error: "You are not a participant of this conversation" },
        403
      );
    }

    const deletedAt = conversation.deletedAt?.get(userId.toString());
    const query: Record<string, unknown> = {
      conversationId,
      deletedFor: { $ne: userId },
      deletedForEveryone: { $ne: true },
      attachmentsV2: { $exists: true, $ne: [] },
    };
    if (deletedAt) query.createdAt = { $gt: deletedAt };

    const messages = await Message.find(query)
      .sort({ createdAt: -1 })
      .select("attachmentsV2 sender createdAt")
      .populate({ path: "sender", select: "name" })
      .limit(200);

    const files: Array<Record<string, unknown>> = [];
    for (const msg of messages) {
      for (const att of msg.attachmentsV2 ?? []) {
        files.push({
          _id: `${msg._id}-${files.length}`,
          fileName: att.fileName || att.type,
          fileUrl: att.url,
          fileType: att.mimeType || att.type,
          fileSize: att.fileSize || 0,
          uploadedAt: (msg as any).createdAt,
          uploadedBy: msg.sender,
        });
      }
    }

    return c.json({ files, count: files.length }, 200);
  } catch (error) {
    console.error("Error fetching conversation files:", error);
    return c.json({ error: "Failed to fetch conversation files" }, 500);
  }
};

/** Whether the current user has muted this conversation. */
export const getConversationMuteStatus = async (c: Context) => {
  const { conversationId } = c.req.param();
  const userId = c.get("user").id;

  if (!mongoose.Types.ObjectId.isValid(conversationId))
    return c.json({ error: "Invalid ID format" }, 400);

  try {
    const user = await User.findById(userId).select(
      "settings.mutedConversations"
    );
    const isMuted = !!user?.settings?.mutedConversations?.some(
      (id) => id?.toString() === conversationId
    );
    return c.json({ isMuted }, 200);
  } catch (error) {
    console.error("Error fetching mute status:", error);
    return c.json({ error: "Failed to fetch mute status" }, 500);
  }
};

/** Mute/unmute a conversation for the current user (persisted per-user). */
export const setConversationMute = async (c: Context) => {
  const { conversationId } = c.req.param();
  const userId = c.get("user").id;
  const { mute } = (await c.req.json().catch(() => ({}))) as {
    mute?: boolean;
  };

  if (!mongoose.Types.ObjectId.isValid(conversationId))
    return c.json({ error: "Invalid ID format" }, 400);

  try {
    const convObjId = new mongoose.Types.ObjectId(conversationId);
    await User.findByIdAndUpdate(
      userId,
      mute
        ? { $addToSet: { "settings.mutedConversations": convObjId } }
        : { $pull: { "settings.mutedConversations": convObjId } }
    );
    return c.json({ success: true, isMuted: !!mute }, 200);
  } catch (error) {
    console.error("Error updating mute status:", error);
    return c.json({ error: "Failed to update mute status" }, 500);
  }
};

// Shared with chatThemeController.ts (which also validates group/community
// themes) — moved out to backend/src/constants/chatThemes.ts so both accept
// the exact same id set, including the legacy ids this route's existing
// callers may still submit.

/**
 * Per-viewer conversation theme (bubble/background reskin) — lives on THIS
 * user's own document, not the shared Conversation, so it's never visible to
 * or shared with the other participant.
 */
export const getConversationTheme = async (c: Context) => {
  const { conversationId } = c.req.param();
  const userId = c.get("user").id;

  if (!mongoose.Types.ObjectId.isValid(conversationId))
    return c.json({ error: "Invalid ID format" }, 400);

  try {
    const user = await User.findById(userId).select(
      "settings.conversationThemes"
    );
    const theme =
      user?.settings?.conversationThemes?.get(conversationId) ?? null;
    return c.json({ theme }, 200);
  } catch (error) {
    console.error("Error fetching conversation theme:", error);
    return c.json({ error: "Failed to fetch conversation theme" }, 500);
  }
};

/** Set (or clear, via theme: null/"default") this viewer's theme for a conversation. */
export const setConversationTheme = async (c: Context) => {
  const { conversationId } = c.req.param();
  const userId = c.get("user").id;
  const io = c.get("io") as Server | undefined;
  const { theme } = (await c.req.json().catch(() => ({}))) as {
    theme?: string | null;
  };

  if (!mongoose.Types.ObjectId.isValid(conversationId))
    return c.json({ error: "Invalid ID format" }, 400);

  try {
    const conversation = await Conversation.findById(conversationId).select(
      "participants"
    );
    if (!conversation) return c.json({ error: "Conversation not found" }, 404);
    const isParticipant = conversation.participants?.some(
      (p) => p?.toString() === userId.toString()
    );
    if (!isParticipant) {
      return c.json(
        { error: "You are not a participant of this conversation" },
        403
      );
    }

    const clearing = theme === null || theme === undefined || theme === "default";
    if (clearing) {
      await User.findByIdAndUpdate(userId, {
        $unset: { [`settings.conversationThemes.${conversationId}`]: "" },
      });
    } else {
      if (typeof theme !== "string" || !isValidChatTheme(theme)) {
        return c.json({ error: "Invalid theme" }, 400);
      }
      await User.findByIdAndUpdate(userId, {
        $set: { [`settings.conversationThemes.${conversationId}`]: theme },
      });
    }

    const resolvedTheme = clearing ? null : (theme as string);

    // Private to the viewer — sync to this user's OTHER tabs/devices only,
    // never to the other participant (who has their own independent choice).
    if (io) {
      io.to(userId.toString()).emit("conversation:themeChanged", {
        conversationId,
        theme: resolvedTheme,
      });
    }

    // GET .../theme/:conversationId is cached per-viewer (not in the app.ts
    // skip list) — without this, the write above wouldn't be visible until
    // the cache entry naturally expired.
    await invalidateAfterDM(conversationId, userId);

    return c.json({ success: true, theme: resolvedTheme }, 200);
  } catch (error) {
    console.error("Error setting conversation theme:", error);
    return c.json({ error: "Failed to set conversation theme" }, 500);
  }
};

export const toggleReaction = async (c: Context) => {
  const { messageId } = c.req.param();
  const { emoji, channelId } = await c.req.json();
  const userId = c.get("user").id;
  const io = c.get("io") as Server | undefined;
  if (
    !mongoose.Types.ObjectId.isValid(messageId) ||
    !mongoose.Types.ObjectId.isValid(channelId)
  )
    return c.json({ error: "Invalid ID format" }, 400);
  try {
    const message = await Message.findById(messageId);
    if (!message) return c.json({ error: "Message not found" }, 404);

    const userIdString = userId.toString();
    const userObjectId = new (mongoose.Types.ObjectId as any)(userIdString);

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

    if (io) {
      io.to(channelId).emit("reactionUpdated", {
        messageId: message._id,
        reactions: message.reactions,
      });
    }

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
