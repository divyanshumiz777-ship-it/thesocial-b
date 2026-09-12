/**
 * featureController.ts — BACKEND FIX
 *
 * Critical bug: authMiddleware sets c.set("user", payload) where payload is
 * the JWT: { id, email, iat, exp }. So user.id is the user's ID and user._id
 * is UNDEFINED. The original file used user._id throughout, meaning:
 *   - readBy pushed { user: undefined }
 *   - alreadyRead check compared undefined.toString() → throws or never matches
 *   - pinnedBy set to undefined
 *   - custom status emitted { userId: undefined }
 *
 * This file fixes all occurrences. Where name/profilePic are needed for the
 * socket emit payload, we load them from User.
 */

import { Context } from "hono";
import mongoose from "mongoose";
import Message from "../models/Message.ts";
import User from "../models/User.ts";
import Conversation from "../models/Conversation.ts";
import Group from "../models/Group.ts";
import ServerMember from "../models/ServerMember.ts";
import { Server } from "socket.io";

// Shared by every generic, message-id-scoped endpoint in this file
// (pin/unpin, list-pinned, mark-read, mark-read-bulk) — none of them checked
// room membership at all before this pass: any authenticated user who
// knew/guessed a messageId, or a groupId/conversationId for the list
// endpoint, could act on a room they had nothing to do with (pin/unpin
// someone else's private message, or forge a read receipt on a DM/group DM
// they were never part of — the sender would then see a stranger's name
// show up as having read it). Mirrors the SAME authorization model each room
// type already enforces elsewhere in this codebase, rather than inventing a
// new, stricter policy: a DM conversation and a group DM are private
// (isParticipant is checked everywhere else in
// dmController.ts/groupDmController.ts, for both reads and writes), so this
// requires it here too; a server channel is NOT privacy-gated anywhere else
// in this codebase (getMessagesByChannelId has no membership check at all —
// only auth + block-list filtering — and createMessage only checks
// banned/muted, never requiring ServerMember to exist), so this mirrors THAT
// looser model instead of retrofitting a stricter one this app's channels
// have never actually had.
async function canAccessMessageRoom(
  message: { conversationId?: mongoose.Types.ObjectId; groupId?: mongoose.Types.ObjectId; server?: mongoose.Types.ObjectId },
  userId: string,
): Promise<boolean> {
  if (message.conversationId) {
    const conversation = await Conversation.findById(message.conversationId).select("participants").lean();
    if (!conversation) return false;
    return (conversation.participants ?? []).some((p: any) => p?.toString() === userId);
  }
  if (message.groupId) {
    const group = await Group.findById(message.groupId).select("participants owner").lean();
    if (!group) return false;
    return (
      group.owner?.toString() === userId ||
      (group.participants ?? []).some((p: any) => p?.toString() === userId)
    );
  }
  if (message.server) {
    const membership = await ServerMember.findOne(
      { server: message.server, user: userId },
      "banned muted",
    ).lean();
    if (membership?.banned?.isBanned) return false;
    if (
      membership?.muted?.isMuted &&
      (!membership.muted.expiresAt || membership.muted.expiresAt > new Date())
    ) {
      return false;
    }
    return true;
  }
  return false;
}

export const togglePinMessage = async (c: Context) => {
  const { messageId } = c.req.param();
  const user = c.get("user");
  const io = c.get("io") as Server | undefined;

  if (!mongoose.Types.ObjectId.isValid(messageId)) {
    return c.json({ error: "Invalid message ID format" }, 400);
  }

  try {
    const message = await Message.findById(messageId);
    if (!message) return c.json({ error: "Message not found" }, 404);

    if (!(await canAccessMessageRoom(message, user.id))) {
      return c.json({ error: "Not authorized to pin this message" }, 403);
    }

    message.pinned = !message.pinned;
    if (message.pinned) {
      message.pinnedBy = new mongoose.Types.ObjectId(user.id); // FIXED: user.id
      message.pinnedAt = new Date();
    } else {
      message.pinnedBy = undefined;
      message.pinnedAt = undefined;
    }
    await message.save();

    if (io) {
      // Group DM fallback added alongside this pass's group-DM pin support
      // (see contracts/groupDm.ts / mobile groupDmApi.ts) — previously this
      // resolved to undefined for a group message, so a pin toggle there
      // saved fine but never broadcast to the room at all.
      const roomId =
        message.conversationId?.toString() ??
        message.channel?.toString() ??
        message.groupId?.toString();
      if (roomId) {
        io.to(roomId).emit("message:pinned", {
          messageId: message._id,
          pinned: message.pinned,
          pinnedBy: message.pinnedBy,
          pinnedAt: message.pinnedAt,
        });
      }
    }

    return c.json(
      {
        message: message.pinned
          ? "Message pinned successfully"
          : "Message unpinned successfully",
        pinned: message.pinned,
        pinnedBy: message.pinnedBy,
        pinnedAt: message.pinnedAt,
      },
      200,
    );
  } catch (error) {
    console.error("Error toggling pin message:", error);
    return c.json({ error: "Failed to toggle pin message" }, 500);
  }
};

export const getPinnedMessages = async (c: Context) => {
  const { channelId, conversationId, groupId } = c.req.query();
  const user = c.get("user");

  if (!channelId && !conversationId && !groupId) {
    return c.json(
      { error: "Channel ID, Conversation ID, or Group ID is required" },
      400,
    );
  }

  try {
    let query: any = { pinned: true };
    // channelId gets no membership check here — same as
    // getMessagesByChannelId's own read path, which has never required one
    // (only auth + block-list filtering); see canAccessMessageRoom's comment
    // above for why conversation/group are gated but channel isn't.
    if (channelId && mongoose.Types.ObjectId.isValid(channelId)) {
      query.channel = channelId;
    } else if (
      conversationId &&
      mongoose.Types.ObjectId.isValid(conversationId)
    ) {
      const conversation = await Conversation.findById(conversationId).select("participants").lean();
      if (!conversation) return c.json({ error: "Conversation not found" }, 404);
      const isParticipant = (conversation.participants ?? []).some(
        (p: any) => p?.toString() === user.id,
      );
      if (!isParticipant) {
        return c.json({ error: "Not authorized to view this conversation's pins" }, 403);
      }
      query.conversationId = conversationId;
    } else if (groupId && mongoose.Types.ObjectId.isValid(groupId)) {
      const group = await Group.findById(groupId).select("participants owner").lean();
      if (!group) return c.json({ error: "Group not found" }, 404);
      const isMember =
        group.owner?.toString() === user.id ||
        (group.participants ?? []).some((p: any) => p?.toString() === user.id);
      if (!isMember) {
        return c.json({ error: "Not authorized to view this group's pins" }, 403);
      }
      query.groupId = groupId;
    } else {
      return c.json({ error: "Invalid ID format" }, 400);
    }

    const pinnedMessages = await Message.find(query)
      .populate("sender", "name profilePic email")
      .populate("pinnedBy", "name profilePic")
      .sort({ pinnedAt: -1 })
      .limit(50);

    return c.json({ pinnedMessages }, 200);
  } catch (error) {
    console.error("Error fetching pinned messages:", error);
    return c.json({ error: "Failed to fetch pinned messages" }, 500);
  }
};

export const markMessageAsRead = async (c: Context) => {
  const { messageId } = c.req.param();
  const user = c.get("user");
  const io = c.get("io") as Server | undefined;

  if (!mongoose.Types.ObjectId.isValid(messageId)) {
    return c.json({ error: "Invalid message ID format" }, 400);
  }

  try {
    const message = await Message.findById(messageId);
    if (!message) return c.json({ error: "Message not found" }, 404);

    const userId = user.id; // FIXED: was user._id

    if (!(await canAccessMessageRoom(message, userId))) {
      return c.json({ error: "Not authorized to mark this message read" }, 403);
    }

    const alreadyRead = message.readBy?.some(
      (r) => r.user.toString() === userId,
    );

    if (!alreadyRead) {
      if (!message.readBy) message.readBy = [];
      message.readBy.push({
        user: new mongoose.Types.ObjectId(userId),
        readAt: new Date(),
      });
      await message.save();

      // Emit to original message sender so they see the read receipt
      if (io && message.sender) {
        // Load name/profilePic for the receipt payload (JWT only has id/email)
        const readerDoc = await User.findById(userId).select("name profilePic");
        io.to(message.sender.toString()).emit("message:read", {
          messageId: message._id,
          readBy: {
            user: {
              _id: userId,
              name: readerDoc?.name ?? user.email,
              profilePic: readerDoc?.profilePic,
            },
            readAt: new Date(),
          },
        });
      }
    }

    return c.json(
      { message: "Message marked as read", readBy: message.readBy },
      200,
    );
  } catch (error) {
    console.error("Error marking message as read:", error);
    return c.json({ error: "Failed to mark message as read" }, 500);
  }
};

export const markMessagesAsRead = async (c: Context) => {
  const { messageIds } = await c.req.json();
  const user = c.get("user");
  const io = c.get("io") as Server | undefined;

  if (!Array.isArray(messageIds) || messageIds.length === 0) {
    return c.json({ error: "Message IDs array is required" }, 400);
  }

  try {
    const userId = user.id; // FIXED: was user._id
    const validIds = messageIds.filter((id) =>
      mongoose.Types.ObjectId.isValid(id),
    );
    const candidates = await Message.find({ _id: { $in: validIds } });
    // Silently drop any message this caller isn't authorized to touch,
    // rather than failing the whole batch over one bad id — a legitimate
    // client only ever batches ids from rooms it actually has access to, so
    // this only ever matters for a forged/mixed-in id, and dropping it
    // quietly avoids leaking whether that message exists at all.
    const authorizationChecks = await Promise.all(
      candidates.map((message) => canAccessMessageRoom(message, userId)),
    );
    const messages = candidates.filter((_, i) => authorizationChecks[i]);

    // Load reader info once
    const readerDoc = await User.findById(userId).select("name profilePic");
    const readAt = new Date();
    const readReceipt = {
      user: new mongoose.Types.ObjectId(userId),
      readAt,
    };

    for (const message of messages) {
      const alreadyRead = message.readBy?.some(
        (r) => r.user.toString() === userId,
      );
      if (!alreadyRead) {
        if (!message.readBy) message.readBy = [];
        message.readBy.push({ ...readReceipt });
        await message.save();

        if (io && message.sender) {
          io.to(message.sender.toString()).emit("message:read", {
            messageId: message._id,
            readBy: {
              user: {
                _id: userId,
                name: readerDoc?.name ?? user.email,
                profilePic: readerDoc?.profilePic,
              },
              readAt,
            },
          });
        }
      }
    }

    return c.json(
      {
        message: `${messages.length} messages marked as read`,
        count: messages.length,
      },
      200,
    );
  } catch (error) {
    console.error("Error marking messages as read:", error);
    return c.json({ error: "Failed to mark messages as read" }, 500);
  }
};

export const updateCustomStatus = async (c: Context) => {
  const user = c.get("user");
  const { text, emoji, expiresIn } = await c.req.json();
  const io = c.get("io") as Server | undefined;

  try {
    const userId = user.id; // FIXED: was user._id
    const userDoc = await User.findById(userId);
    if (!userDoc) return c.json({ error: "User not found" }, 404);

    let expiresAt: Date | undefined;
    if (expiresIn && expiresIn > 0) {
      expiresAt = new Date(Date.now() + expiresIn * 60 * 1000);
    }

    userDoc.customStatus = {
      text: text || undefined,
      emoji: emoji || undefined,
      expiresAt,
    };
    await userDoc.save();

    if (io) {
      io.emit("user:status-updated", {
        userId, // FIXED: was user._id (undefined)
        customStatus: userDoc.customStatus,
      });
    }

    return c.json(
      { message: "Custom status updated", customStatus: userDoc.customStatus },
      200,
    );
  } catch (error) {
    console.error("Error updating custom status:", error);
    return c.json({ error: "Failed to update custom status" }, 500);
  }
};

export const clearCustomStatus = async (c: Context) => {
  const user = c.get("user");
  const io = c.get("io") as Server | undefined;

  try {
    const userId = user.id; // FIXED: was user._id
    const userDoc = await User.findById(userId);
    if (!userDoc) return c.json({ error: "User not found" }, 404);

    userDoc.customStatus = undefined;
    await userDoc.save();

    if (io) {
      io.emit("user:status-updated", {
        userId, // FIXED: was user._id (undefined)
        customStatus: null,
      });
    }

    return c.json({ message: "Custom status cleared" }, 200);
  } catch (error) {
    console.error("Error clearing custom status:", error);
    return c.json({ error: "Failed to clear custom status" }, 500);
  }
};
