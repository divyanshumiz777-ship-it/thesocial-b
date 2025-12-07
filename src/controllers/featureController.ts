import { Context } from "hono";
import mongoose from "mongoose";
import Message from "../models/Message.ts";
import User from "../models/User.ts";
import { Server } from "socket.io";

export const togglePinMessage = async (c: Context) => {
  const { messageId } = c.req.param();
  const user = c.get("user");
  const io = c.get("io") as Server | undefined;

  if (!mongoose.Types.ObjectId.isValid(messageId)) {
    return c.json({ error: "Invalid message ID format" }, 400);
  }

  try {
    const message = await Message.findById(messageId);
    if (!message) {
      return c.json({ error: "Message not found" }, 404);
    }

    message.pinned = !message.pinned;

    if (message.pinned) {
      message.pinnedBy = user._id;
      message.pinnedAt = new Date();
    } else {
      message.pinnedBy = undefined;
      message.pinnedAt = undefined;
    }

    await message.save();

    if (io) {
      const roomId =
        message.conversationId?.toString() || message.channel?.toString();
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
      200
    );
  } catch (error) {
    console.error("Error toggling pin message:", error);
    return c.json({ error: "Failed to toggle pin message" }, 500);
  }
};

export const getPinnedMessages = async (c: Context) => {
  const { channelId, conversationId } = c.req.query();

  if (!channelId && !conversationId) {
    return c.json({ error: "Channel ID or Conversation ID is required" }, 400);
  }

  try {
    let query: any = { pinned: true };

    if (channelId && mongoose.Types.ObjectId.isValid(channelId)) {
      query.channel = channelId;
    } else if (
      conversationId &&
      mongoose.Types.ObjectId.isValid(conversationId)
    ) {
      query.conversationId = conversationId;
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
    if (!message) {
      return c.json({ error: "Message not found" }, 404);
    }

    const alreadyRead = message.readBy?.some(
      (r) => r.user.toString() === user._id.toString()
    );

    if (!alreadyRead) {
      if (!message.readBy) {
        message.readBy = [];
      }

      message.readBy.push({
        user: user._id,
        readAt: new Date(),
      });

      await message.save();

      if (io && message.sender) {
        io.to(message.sender.toString()).emit("message:read", {
          messageId: message._id,
          readBy: {
            user: {
              _id: user._id,
              name: user.name,
              profilePic: user.profilePic,
            },
            readAt: new Date(),
          },
        });
      }
    }

    return c.json(
      {
        message: "Message marked as read",
        readBy: message.readBy,
      },
      200
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
    const validIds = messageIds.filter((id) =>
      mongoose.Types.ObjectId.isValid(id)
    );

    const messages = await Message.find({ _id: { $in: validIds } });

    const readReceipt = {
      user: user._id,
      readAt: new Date(),
    };

    for (const message of messages) {
      const alreadyRead = message.readBy?.some(
        (r) => r.user.toString() === user._id.toString()
      );

      if (!alreadyRead) {
        if (!message.readBy) {
          message.readBy = [];
        }
        message.readBy.push(readReceipt);
        await message.save();

        if (io && message.sender) {
          io.to(message.sender.toString()).emit("message:read", {
            messageId: message._id,
            readBy: {
              user: {
                _id: user._id,
                name: user.name,
                profilePic: user.profilePic,
              },
              readAt: readReceipt.readAt,
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
      200
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
    const userDoc = await User.findById(user._id);
    if (!userDoc) {
      return c.json({ error: "User not found" }, 404);
    }

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
        userId: user._id,
        customStatus: userDoc.customStatus,
      });
    }

    return c.json(
      {
        message: "Custom status updated successfully",
        customStatus: userDoc.customStatus,
      },
      200
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
    const userDoc = await User.findById(user._id);
    if (!userDoc) {
      return c.json({ error: "User not found" }, 404);
    }

    userDoc.customStatus = undefined;
    await userDoc.save();

    if (io) {
      io.emit("user:status-updated", {
        userId: user._id,
        customStatus: null,
      });
    }

    return c.json(
      {
        message: "Custom status cleared successfully",
      },
      200
    );
  } catch (error) {
    console.error("Error clearing custom status:", error);
    return c.json({ error: "Failed to clear custom status" }, 500);
  }
};
