import { Context } from "hono";
import mongoose from "mongoose";
import Conversation from "../models/Conversation.ts";
import Message from "../models/Message.ts";
import User from "../models/User.ts";
import { Server } from "socket.io";

export const createDm = async (c: Context) => {
  const { senderId, receiverId, content, attachments } = await c.req.json();
  const io = c.get("io") as Server | undefined;

  if (
    !senderId ||
    !receiverId ||
    (!content && (!attachments || attachments.length === 0))
  ) {
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

    const isFriend = sender.friends?.includes(
      mongoose.Types.ObjectId.createFromHexString(receiverId)
    );

    if (!isFriend) {
      return c.json(
        { error: "You can only message friends. Send a friend request first." },
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

    const newMessage = await Message.create({
      content,
      sender: senderId,
      conversationId: conversation._id,
      attachmentsV2:
        attachments && Array.isArray(attachments) ? attachments : [],
    });

    await Conversation.findByIdAndUpdate(conversation._id, {
      $push: { messages: newMessage._id },
    });

    if (io) {
      io.to(conversation._id.toString()).emit("dm:new-message", newMessage);
    }

    return c.json(newMessage, 201);
  } catch (error) {
    console.error("Error creating DM:", error);
    return c.json({ error: "Failed to create DM" }, 500);
  }
};
export const getDm = async (c: Context) => {
  const { conversationId } = c.req.param();

  const page = parseInt(c.req.query("page") || "1");
  const limit = parseInt(c.req.query("limit") || "50");
  const skip = (page - 1) * limit;

  if (!mongoose.Types.ObjectId.isValid(conversationId))
    return c.json({ error: "Invalid ID format" }, 400);

  try {
    const conversation = await Conversation.findById(conversationId).populate({
      path: "messages",
      options: {
        sort: { createdAt: -1 },
        limit,
        skip,
      },
    });
    if (!conversation) return c.json({ error: "Conversation not found" }, 404);
    return c.json(conversation.messages.reverse(), 200);
  } catch (error) {
    console.error("Error fetching DM:", error);
    return c.json({ error: "Failed to fetch DM" }, 500);
  }
};
export const editMessage = async (c: Context) => {
  const { conversationId } = c.req.param();
  const { content, user, messageId } = await c.req.json();
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
    const userId = user._id || user.id;
    if (!userId) {
      return c.json({ error: "User ID is required" }, 400);
    }

    const updatedMessage = await Message.findOneAndUpdate(
      { _id: messageId, sender: userId },
      { content, edited: true },
      { new: true }
    );

    if (!updatedMessage) {
      return c.json(
        { error: "Message not found or you don't have permission to edit it." },
        404
      );
    }

    if (io) {
      io.to(conversationId).emit("messageUpdated", updatedMessage);
    }

    return c.json(updatedMessage, 200);
  } catch (error) {
    console.error("Error editing message:", error);
    return c.json({ error: "Failed to edit message" }, 500);
  }
};
export const deleteMessage = async (c: Context) => {
  const { conversationId } = c.req.param();
  const { messageId, userId, deleteType } = await c.req.json();
  if (
    !mongoose.Types.ObjectId.isValid(messageId) ||
    !mongoose.Types.ObjectId.isValid(conversationId) ||
    !mongoose.Types.ObjectId.isValid(userId)
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
      }
    }

    await Conversation.findByIdAndUpdate(conversationId, {
      $pull: { messages: messageId },
    });

    return c.json({ message: "Message deleted successfully" }, 200);
  } catch (error) {
    console.error("Error deleting message:", error);
    return c.json({ error: "Failed to delete message" }, 500);
  }
};
export const deleteDm = async (c: Context) => {
  const { conversationId } = c.req.param();
  const { user } = await c.req.json();
  const io = c.get("io") as Server | undefined;
  if (!mongoose.Types.ObjectId.isValid(conversationId))
    return c.json({ error: "Invalid ID format" }, 400);
  try {
    const deletedConversation = await Conversation.findOneAndUpdate(
      {
        _id: conversationId,
        participants: { $in: [user._id] },
      },
      { $pull: { participants: user._id } },
      { new: true }
    );
    if (!deletedConversation) {
      return c.json(
        { error: "Conversation not found or user is not a participant." },
        404
      );
    }
    if (!deletedConversation.participants.length) {
      await Message.deleteMany({
        _id: { $in: deletedConversation.messages },
      });
      await Conversation.findByIdAndDelete(conversationId);
    } else {
      if (io) {
        io.to(conversationId).emit("conversationUpdated", deletedConversation);
      }
    }
    return c.json({ message: "DM deleted successfully" }, 200);
  } catch (error) {
    console.error("Error deleting DM:", error);
    return c.json({ error: "Failed to delete DM" }, 500);
  }
};

export const toggleReaction = async (c: Context) => {
  const { messageId } = c.req.param();
  const { emoji, user, channelId } = await c.req.json();
  const io = c.get("io") as Server | undefined;
  if (
    !mongoose.Types.ObjectId.isValid(messageId) ||
    !mongoose.Types.ObjectId.isValid(channelId)
  )
    return c.json({ error: "Invalid ID format" }, 400);
  try {
    const message = await Message.findById(messageId);
    if (!message) return c.json({ error: "Message not found" }, 404);

    const userId = user._id || user.id;
    if (!userId) {
      return c.json({ error: "User ID is required" }, 400);
    }

    const reactionIndex = message.reactions.findIndex((r) => r.emoji === emoji);
    const userIdString = userId.toString();
    const userObjectId = new (mongoose.Types.ObjectId as any)(userIdString);

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
        reaction.users.push(userObjectId);
      }
    } else {
      message.reactions.push({ emoji, users: [userObjectId] });
    }
    await message.save();

    if (io) {
      io.to(channelId).emit("reactionUpdated", message);
    }

    return c.json({ message: "Reaction updated successfully" }, 200);
  } catch (error) {
    console.error("Error adding reaction:", error);
    return c.json({ error: "Failed to add reaction" }, 500);
  }
};
