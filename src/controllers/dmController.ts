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

    const receiver = await User.findById(receiverId);
    if (!receiver) {
      return c.json({ error: "Receiver not found" }, 404);
    }

    console.log("Checking if sender is blocked by receiver:");
    console.log("Receiver blockedUsers:", receiver.blockedUsers);
    console.log("SenderId to check:", senderId);

    if (receiver.blockedUsers?.some((u) => u.toString() === senderId)) {
      console.log("❌ BLOCKED: Sender is in receiver's blocked list");
      return c.json({ error: "You cannot send messages to this user" }, 403);
    }
    console.log("✅ NOT BLOCKED: Sender is not in receiver's blocked list");

    if (sender.blockedUsers?.some((u) => u.toString() === receiverId)) {
      console.log("❌ BLOCKED: Receiver is in sender's blocked list");
      return c.json(
        { error: "You have blocked this user. Unblock them to send messages." },
        403
      );
    }
    console.log("✅ NOT BLOCKED: Receiver is not in sender's blocked list");

    const isFriend = sender.friends?.includes(
      mongoose.Types.ObjectId.createFromHexString(receiverId)
    );

    console.log("Checking friend status:");
    console.log("Sender friends:", sender.friends);
    console.log("Receiver ID to check:", receiverId);
    console.log("Is friend?", isFriend);

    if (!isFriend) {
      console.log("❌ NOT FRIENDS: Cannot send message");
      return c.json(
        { error: "You can only message friends. Send a friend request first." },
        403
      );
    }
    console.log("✅ FRIENDS: Can send message");

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
      $pull: {
        hiddenFor: { $in: [senderId, receiverId] },
        deletedFor: { $in: [senderId, receiverId] },
      },
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
  const user = c.get("user");

  const page = parseInt(c.req.query("page") || "1");
  const limit = parseInt(c.req.query("limit") || "50");
  const skip = (page - 1) * limit;

  if (!mongoose.Types.ObjectId.isValid(conversationId))
    return c.json({ error: "Invalid ID format" }, 400);

  try {
    const conversation = await Conversation.findById(conversationId);
    if (!conversation) return c.json({ error: "Conversation not found" }, 404);

    const deletedAt = conversation.deletedAt?.get(user?.id?.toString());

    let messageQuery: any = { _id: { $in: conversation.messages } };

    if (deletedAt) {
      messageQuery.createdAt = { $gt: deletedAt };
    }

    const messages = await mongoose
      .model("Message")
      .find(messageQuery)
      .populate({
        path: "sender",
        select: "name profilePic email about",
      })
      .sort({ createdAt: -1 })
      .limit(limit)
      .skip(skip);

    return c.json(messages.reverse(), 200);
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

      await Conversation.findByIdAndUpdate(conversationId, {
        $pull: { messages: messageId },
      });

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

export const hideConversation = async (c: Context) => {
  const { conversationId } = c.req.param();
  const user = c.get("user");
  console.log(user);

  if (!mongoose.Types.ObjectId.isValid(conversationId))
    return c.json({ error: "Invalid ID format" }, 400);

  try {
    const conversation = await Conversation.findById(conversationId);
    if (!conversation) {
      return c.json({ error: "Conversation not found" }, 404);
    }

    console.log(conversation.participants);
    const isParticipant = conversation.participants?.some((p) => {
      console.log(p);
      return p?.toString() === user?.id?.toString();
    });

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
      (u) => u && u.toString() === user._id?.toString()
    );

    if (!alreadyHidden) {
      conversation.hiddenFor.push(user._id);
      await conversation.save();
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
        (u) => u && u.toString() !== user._id?.toString()
      );
      await conversation.save();
    }

    return c.json({ message: "Conversation unhidden successfully" }, 200);
  } catch (error) {
    console.error("Error unhiding conversation:", error);
    return c.json({ error: "Failed to unhide conversation" }, 500);
  }
};

export const deleteConversationForUser = async (c: Context) => {
  const { conversationId } = c.req.param();
  const user = c.get("user");
  console.log(user);

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
      conversation.deletedFor.push(user._id);

      if (!conversation.deletedAt) {
        conversation.deletedAt = new Map();
      }
      conversation.deletedAt.set(user?.id?.toString(), new Date());

      await conversation.save();
    }

    return c.json({ message: "Conversation deleted successfully" }, 200);
  } catch (error) {
    console.error("Error deleting conversation:", error);
    return c.json({ error: "Failed to delete conversation" }, 500);
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

    const conversations = await Conversation.find({
      participants: { $all: [currentUser.id, userId] },
    });

    for (const conversation of conversations) {
      if (!conversation.hiddenFor) {
        conversation.hiddenFor = [];
      }
      if (
        !conversation.hiddenFor.some((u) => u?.toString() === currentUser.id)
      ) {
        conversation.hiddenFor.push(
          mongoose.Types.ObjectId.createFromHexString(currentUser.id)
        );
        await conversation.save();
      }
    }

    if (io) {
      io.emit("user:blocked", {
        blockedBy: currentUser.id,
        blockedUser: userId,
      });
    }

    return c.json(
      {
        message: "User blocked successfully",
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

    for (const conversation of conversations) {
      if (conversation.hiddenFor) {
        conversation.hiddenFor = conversation.hiddenFor.filter(
          (u) => u?.toString() !== currentUser.id
        );
        await conversation.save();
      }
    }

    if (io) {
      io.emit("user:unblocked", {
        unblockedBy: currentUser.id,
        unblockedUser: userId,
      });
    }

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
