import { Context } from "hono";
import mongoose from "mongoose";
import Conversation from "../models/Conversation";
import Message from "../models/Message";
import { Server } from "socket.io";

export const createDm = async (c: Context) => {
  const { senderId, receiverId, content } = await c.req.json();
  const io: Server = c.get("io");

  if (!senderId || !receiverId || !content) {
    return c.json({ error: "Missing required fields" }, 400);
  }
  if (
    !mongoose.Types.ObjectId.isValid(senderId) ||
    !mongoose.Types.ObjectId.isValid(receiverId)
  ) {
    return c.json({ error: "Invalid ID format" }, 400);
  }

  try {
    const conversation = await Conversation.findOneAndUpdate(
      { participants: { $all: [senderId, receiverId] } },
      { $setOnInsert: { participants: [senderId, receiverId] } },
      { upsert: true, new: true }
    );

    const newMessage = await Message.create({
      content,
      sender: senderId,
      conversationId: conversation._id,
    });

    await Conversation.findByIdAndUpdate(conversation._id, {
      $push: { messages: newMessage._id },
    });

    io.to(conversation._id.toString()).emit("newMessage", newMessage);

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
  const io: Server = c.get("io");

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
      { _id: messageId, sender: user._id },
      { content, edited: true },
      { new: true }
    );

    if (!updatedMessage) {
      return c.json(
        { error: "Message not found or you don't have permission to edit it." },
        404
      );
    }

    io.to(conversationId).emit("messageUpdated", updatedMessage);

    return c.json(updatedMessage, 200);
  } catch (error) {
    console.error("Error editing message:", error);
    return c.json({ error: "Failed to edit message" }, 500);
  }
};
export const deleteMessage = async (c: Context) => {
  const { conversationId } = c.req.param();
  const { messageId, userId } = await c.req.json();
  if (
    !mongoose.Types.ObjectId.isValid(messageId) ||
    !mongoose.Types.ObjectId.isValid(conversationId) ||
    !mongoose.Types.ObjectId.isValid(userId)
  )
    return c.json({ error: "Invalid ID format" }, 400);
  const io: Server = c.get("io");
  try {
    const deletedMessage = await Message.findOneAndDelete({
      _id: messageId,
      sender: userId,
    });
    if (!deletedMessage) {
      return c.json({ error: "Message not found" }, 404);
    }
    await Conversation.findByIdAndUpdate(conversationId, {
      $pull: { messages: messageId },
    });
    io.to(conversationId).emit("messageDeleted", messageId);
  } catch (error) {
    console.error("Error deleting message:", error);
    return c.json({ error: "Failed to delete message" }, 500);
  }
};
export const deleteDm = async (c: Context) => {
  const { conversationId } = c.req.param();
  const { user } = await c.req.json();
  const io: Server = c.get("io");
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
      io.to(conversationId).emit("conversationUpdated", deletedConversation);
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
  const io: Server = c.get("io");
  if (
    !mongoose.Types.ObjectId.isValid(messageId) ||
    !mongoose.Types.ObjectId.isValid(channelId)
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

    io.to(channelId).emit("reactionUpdated", message);

    return c.json({ message: "Reaction updated successfully" }, 200);
  } catch (error) {
    console.error("Error adding reaction:", error);
    return c.json({ error: "Failed to add reaction" }, 500);
  }
};
