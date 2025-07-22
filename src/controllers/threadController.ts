import { Context } from "hono";
import mongoose, { Types } from "mongoose";
import Thread from "../models/Thread";
import Channel from "../models/Channel";
import DiscordServer from "../models/DiscordServer";
import Message from "../models/Message";
import { Server } from "socket.io";

const hasPermission = async (
  c: Context,
  role: string,
  user: Types.ObjectId,
  serverId: Types.ObjectId
) => {
  const serverWithPermission = await DiscordServer.findOne({
    _id: serverId,
    members: {
      $elemMatch: {
        user: user,
        roles: role,
      },
    },
  });
  return serverWithPermission;
};

export const createThread = async (c: Context) => {
  const { channelId } = c.req.param();
  const body = await c.req.json();
  const { title, serverId, user } = body;
  const io: Server = c.get("io");

  if (
    !mongoose.Types.ObjectId.isValid(channelId) ||
    !mongoose.Types.ObjectId.isValid(serverId)
  ) {
    return c.json({ error: "Invalid ID format" }, 400);
  }

  if (!title) return c.json({ error: "Title is required" }, 400);

  try {
    const allowed = await hasPermission(c, "create threads", user, serverId);

    if (!allowed) {
      return c.json(
        {
          error:
            "You do not have permission to create a thread in this server.",
        },
        403
      );
    }

    const thread = await Thread.create({
      title,
      channel: channelId,
      server: serverId,
      creator: user._id,
    });
    await Channel.findByIdAndUpdate(channelId, {
      $push: { threads: thread._id },
    });
    io.to(channelId).emit("threadCreated", thread);
    return c.json({ message: "Thread created successfully", thread });
  } catch (error) {
    console.error("Error creating thread:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const getThreads = async (c: Context) => {
  const { channelId } = c.req.param();
  const { serverId, user } = await c.req.json();
  const page = parseInt(c.req.query("page") || "1");
  const limit = parseInt(c.req.query("limit") || "25");
  const skip = (page - 1) * limit;
  if (
    !mongoose.Types.ObjectId.isValid(channelId) ||
    !mongoose.Types.ObjectId.isValid(serverId)
  ) {
    return c.json({ error: "Invalid ID format" }, 400);
  }
  try {
    const allowed = await hasPermission(c, "view threads", user, serverId);
    if (!allowed)
      return c.json(
        { error: "You do not have permission to view threads in this server." },
        403
      );
    const channelExists = await Channel.findById(channelId);
    if (!channelExists) {
      return c.json({ error: "Channel not found" }, 404);
    }
    const threads = await Thread.find({ channel: channelId })
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(limit);

    return c.json({ threads });
  } catch (error) {
    console.error("Error fetching threads:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const updateThread = async (c: Context) => {
  const { threadId } = c.req.param();
  const body = await c.req.json();
  const { title, user, serverId } = body;
  const io: Server = c.get("io");

  if (
    !mongoose.Types.ObjectId.isValid(threadId) ||
    !mongoose.Types.ObjectId.isValid(serverId)
  ) {
    return c.json({ error: "Invalid thread ID format" }, 400);
  }

  if (!title) return c.json({ error: "Title is required" }, 400);

  try {
    const allowed = await hasPermission(c, "update threads", user, serverId);
    const threadCreator = await Thread.findOne({
      _id: threadId,
      creator: user,
    });

    if (!allowed && !threadCreator) {
      return c.json(
        {
          error:
            "You do not have permission to update a thread in this server.",
        },
        403
      );
    }

    const updatedThread = await Thread.findByIdAndUpdate(
      threadId,
      { title },
      { new: true }
    );
    if (!updatedThread) {
      return c.json({ error: "Thread not found" }, 404);
    }
    const channelIdString = updatedThread.channel.toString();
    if (!channelIdString) {
      return c.json({ error: "Invalid channel ID" }, 400);
    }
    io.to(channelIdString).emit("threadUpdated", updatedThread);
    return c.json({
      message: "Thread updated successfully",
      thread: updatedThread,
    });
  } catch (error) {
    console.error("Error updating thread:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const deleteThread = async (c: Context) => {
  const { threadId } = c.req.param();
  const { user, serverId } = await c.req.json();
  const io: Server = c.get("io");

  if (
    !mongoose.Types.ObjectId.isValid(threadId) ||
    !mongoose.Types.ObjectId.isValid(serverId)
  ) {
    return c.json({ error: "Invalid ID format" }, 400);
  }

  try {
    const allowed = await hasPermission(c, "delete threads", user, serverId);
    const threadCreator = await Thread.findOne({
      _id: threadId,
      creator: user,
    });

    if (!allowed && !threadCreator) {
      return c.json(
        {
          error: "You do not have permission to delete threads in this server.",
        },
        403
      );
    }

    const deletedThread = await Thread.findByIdAndDelete(threadId);

    if (!deletedThread) {
      return c.json({ error: "Thread not found" }, 404);
    }

    const channelId = deletedThread.channel;

    await Channel.findByIdAndUpdate(channelId, {
      $pull: { threads: threadId },
    });

    const channelIdString = channelId.toString();
    if (!channelIdString) return c.json({ error: "Invalid channel ID" }, 400);
    io.to(channelIdString).emit("threadDeleted", threadId);

    return c.json({ message: "Thread deleted successfully" });
  } catch (error) {
    console.error("Error deleting thread:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const createMessage = async (c: Context) => {
  const { threadId } = c.req.param();
  const { content, senderId, channelId, serverId } = await c.req.json();
  const io: Server = c.get("io");
  if (
    !mongoose.Types.ObjectId.isValid(threadId) ||
    !mongoose.Types.ObjectId.isValid(senderId) ||
    !mongoose.Types.ObjectId.isValid(channelId)
  )
    return c.json({ error: "Invalid ID format" }, 400);
  if (!content) return c.json({ error: "Content is required" }, 400);
  try {
    const canUserSendMessages = await DiscordServer.findOne({
      _id: serverId,
      members: {
        $elemMatch: { user: senderId, roles: "send messages" },
      },
    });
    if (!canUserSendMessages)
      return c.json(
        { error: "You do not have permission to send messages" },
        403
      );
    const newMessage = await Message.create({
      content,
      sender: senderId,
      thread: threadId,
      channel: channelId,
    });
    await Thread.findByIdAndUpdate(threadId, {
      $push: { messages: newMessage._id },
      $addToSet: { senders: senderId },
    });
    io.to(channelId).emit("message", newMessage);
    return c.json({
      message: "Message created successfully",
      msg: newMessage,
    });
  } catch (error) {
    console.error("Error creating message:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const getMessages = async (c: Context) => {
  const { threadId } = c.req.param();
  const { serverId, user, channelId } = await c.req.json();
  const page = parseInt(c.req.query("page") || "1");
  const limit = parseInt(c.req.query("limit") || "25");
  const skip = (page - 1) * limit;
  if (
    !mongoose.Types.ObjectId.isValid(threadId) ||
    !mongoose.Types.ObjectId.isValid(serverId)
  )
    return c.json({ error: "Invalid ID format" }, 400);
  try {
    const userInServer = await DiscordServer.findOne({
      _id: serverId,
      members: {
        $elemMatch: { user: user, roles: "view messages" },
      },
    });
    if (!userInServer)
      return c.json({ error: "You do not have permission to view messages" });
    const allowed = await hasPermission(c, "view messages", user, serverId);
    if (!allowed) {
      return c.json(
        {
          error: "You do not have permission to view messages in this server.",
        },
        403
      );
    }
    const channelExists = await Channel.findById(channelId);
    if (!channelExists) {
      return c.json({ error: "Channel not found" }, 404);
    }
    const messages = await Message.find({ thread: threadId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("sender");
    return c.json({ messages });
  } catch (error) {
    console.error("Error fetching messages:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const deleteMessage = async (c: Context) => {
  const { messageId } = c.req.param();
  const { user, serverId, threadId } = await c.req.json();
  const io: Server = c.get("io");
  if (!mongoose.Types.ObjectId.isValid(messageId))
    return c.json({ error: "Invalid message ID format" }, 400);
  try {
    const allowed = await hasPermission(c, "delete messages", user, serverId);
    const messageCreator = await Message.findOne({
      _id: messageId,
      sender: user,
    });

    if (!allowed && !messageCreator) {
      return c.json(
        {
          error:
            "You do not have permission to delete messages in this server.",
        },
        403
      );
    }
    const deletedMessage = await Message.findByIdAndDelete(messageId);
    if (!deletedMessage) {
      return c.json({ error: "Message not found" }, 404);
    }
    const channelId = deletedMessage.channel?.toString();
    if (!channelId) {
      return c.json({ error: "Invalid channel ID" }, 400);
    }
    io.to(channelId).emit("messageDeleted", messageId);
    await Thread.findByIdAndUpdate(threadId, {
      $pull: { messages: messageId },
    });
    return c.json({ message: "Message deleted successfully" }, 200);
  } catch (error) {
    console.error("Error deleting message:", error);
    return c.json({ error: "Failed to delete message" }, 500);
  }
};

export const updateMessage = async (c: Context) => {
  const { messageId } = c.req.param();
  const { content, user, serverId } = await c.req.json();
  const io: Server = c.get("io");
  if (
    !mongoose.Types.ObjectId.isValid(messageId) ||
    !mongoose.Types.ObjectId.isValid(serverId)
  ) {
    return c.json({ error: "Invalid ID format" }, 400);
  }
  if (!content) {
    return c.json({ error: "Invalid message ID format" }, 400);
  }
  try {
    const allowed = await hasPermission(c, "update messages", user, serverId);
    const msgCreator = await Message.findOne({
      _id: messageId,
      sender: user,
    });

    if (!allowed && !msgCreator) {
      return c.json(
        {
          error:
            "You do not have permission to update messages in this server.",
        },
        403
      );
    }
    const updatedMessage = await Message.findByIdAndUpdate(
      messageId,
      { content },
      { new: true }
    );
    if (!updatedMessage) return c.json({ error: "Message not found" }, 404);
    const channelIdString = updatedMessage.channel?.toString();
    if (!channelIdString) {
      return c.json({ error: "Invalid channel ID" }, 400);
    }
    io.to(channelIdString).emit("messageUpdated", updatedMessage);
    return c.json({ message: "Message updated successfully" }, 200);
  } catch (error) {
    console.error("Error updating message", error);
    return c.json({ error: "Failed to update message" }, 500);
  }
};

export const toggleReaction = async (c: Context) => {
  const { messageId } = c.req.param();
  const { emoji, user, conversationId, serverId } = await c.req.json();
  if (
    !mongoose.Types.ObjectId.isValid(messageId) ||
    !mongoose.Types.ObjectId.isValid(conversationId)
  )
    return c.json({ error: "Invalid ID format" }, 400);

  try {
    const isMember = await DiscordServer.findOne({
      _id: serverId,
      members: {
        $elemMatch: { user: user, roles: "add reactions" },
      },
    });
    if (!isMember) {
      return c.json(
        { error: "You do not have permission to add reactions" },
        403
      );
    }
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
    return c.json({ message: "Reaction updated successfully" }, 200);
  } catch (error) {
    console.error("Error adding reaction:", error);
    return c.json({ error: "Failed to add reaction" }, 500);
  }
};
