import mongoose from "mongoose";
import { Context } from "hono";
import User from "../models/User.ts";
import DiscordServer from "../models/DiscordServer.ts";
import { Server } from "socket.io";

export const getAllUsers = async (c: Context) => {
  try {
    const users = await User.find();
    if (users.length === 0) {
      return c.json({ message: "No users found" }, 404);
    }
    return c.json({ users }, 200);
  } catch (error) {
    console.error("Error fetching users:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const getUser = async (c: Context) => {
  const { id } = c.req.param();

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return c.json({ error: "Invalid user ID format" }, 400);
  }

  try {
    const user = await User.findById(id);
    if (!user) {
      return c.json({ message: "No user found" }, 404);
    }
    return c.json({ user }, 200);
  } catch (error) {
    console.error("Error fetching user:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const editUser = async (c: Context) => {
  const { id } = c.req.param();
  const body = await c.req.json();
  const { name, profilePic, userId, editorId } = body;

  if (
    !mongoose.Types.ObjectId.isValid(id) ||
    !mongoose.Types.ObjectId.isValid(userId) ||
    !mongoose.Types.ObjectId.isValid(editorId)
  ) {
    return c.json({ error: "Invalid ID format" }, 400);
  }

  try {
    const user = await User.findById(id);
    if (!user) {
      return c.json({ message: "No such user exists" }, 404);
    }
    const canEdit = await User.findOne({
      _id: editorId,
    });
    if (!canEdit) {
      return c.json({ error: "Permission denied" }, 403);
    }
    if (name) user.name = name;
    await user.save();
    if (profilePic) user.profilePic = profilePic;
    await user.save();

    return c.json({ message: "User updated successfully", user }, 200);
  } catch (error) {
    console.error("Error updating user:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};
export const deleteUser = async (c: Context) => {
  const { id, deleteId, userId } = c.req.param();

  if (
    !mongoose.Types.ObjectId.isValid(id) ||
    !mongoose.Types.ObjectId.isValid(userId) ||
    !mongoose.Types.ObjectId.isValid(deleteId)
  ) {
    return c.json({ error: "Invalid ID format " }, 400);
  }

  try {
    const canDelete = await DiscordServer.findOne({
      _id: id,
      members: {
        $elemMatch: {
          $or: [{ user: userId }, { user: deleteId, roles: "owner" }],
        },
      },
    });
    if (!canDelete) {
      return c.json({ error: "Permission denied" }, 403);
    }

    const deletedUser = await User.findByIdAndDelete(id);

    if (!deletedUser) {
      return c.json({ error: "User not found" }, 404);
    }

    return c.json({ message: "User deleted successfully" }, 200);
  } catch (error) {
    console.error("Error deleting user:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const joinServer = async (c: Context) => {
  const user = c.get("user");
  const id = user.id;
  const { id: serverId } = c.req.param();

  if (
    !mongoose.Types.ObjectId.isValid(id) ||
    !mongoose.Types.ObjectId.isValid(serverId)
  ) {
    return c.json({ error: "Invalid user ID or server ID format" }, 400);
  }

  const serverExists = await DiscordServer.findById(serverId);

  if (!serverExists) {
    return c.json({ error: "Server not found" }, 404);
  }

  try {
    const io: Server = c.get("io");
    if (!io) {
      return c.json({ error: "Socket.IO instance not available" }, 500);
    }
    const updatedUser = await User.findByIdAndUpdate(
      id,
      { $addToSet: { servers: serverId } },
      { new: true }
    );
    const updatedServer = await DiscordServer.findByIdAndUpdate(serverId, {
      $addToSet: { members: { user: id, roles: ["member"] } },
    });
    if (!updatedUser) {
      return c.json({ error: "User not found" }, 404);
    }
    io.to(serverId).emit("userJoined", updatedUser);
    return c.json(
      { message: "Joined server successfully", server: updatedServer },
      200
    );
  } catch (error) {
    console.error("Error joining server:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const leaveServer = async (c: Context) => {
  const user = c.get("user");
  const id = user.id;
  const { id: serverId } = c.req.param();

  if (
    !mongoose.Types.ObjectId.isValid(id) ||
    !mongoose.Types.ObjectId.isValid(serverId)
  ) {
    return c.json({ error: "Invalid user ID or server ID format" }, 400);
  }

  const serverExists = await DiscordServer.findById(serverId);

  if (!serverExists) {
    return c.json({ error: "Server not found" }, 404);
  }

  try {
    const io: Server = c.get("io");
    if (!io) {
      return c.json({ error: "Socket.IO instance not available" }, 500);
    }
    const updatedUser = await User.findByIdAndUpdate(
      id,
      { $pull: { servers: serverId } },
      { new: true }
    );
    if (!updatedUser) return c.json({ error: "User not found" }, 404);
    await DiscordServer.findByIdAndUpdate(serverId, {
      $pull: { members: { user: id } },
    });
    io.to(serverId).emit("userLeft", { userId: id, serverId: serverId });
    return c.json(
      { message: "Left server successfully", user: updatedUser },
      200
    );
  } catch (error) {
    console.error("Error leaving server:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const userServers = async (c: Context) => {
  const { id } = c.get("user");

  const page = parseInt(c.req.query("page") || "1", 10);
  const limit = parseInt(c.req.query("limit") || "10", 10);
  const skip = (page - 1) * limit;

  try {
    const totalServers = await DiscordServer.countDocuments({
      members: { $elemMatch: { user: id } },
    });

    const servers = await DiscordServer.find({
      members: { $elemMatch: { user: id } },
    })
      .skip(skip)
      .limit(limit);

    if (servers.length === 0 && totalServers === 0) {
      return c.json({
        servers: [],
        totalPages: 0,
        currentPage: page,
      });
    }
    return c.json({
      servers,
      totalPages: Math.ceil(totalServers / limit),
      currentPage: page,
    });
  } catch (error) {
    console.error("Error fetching user servers:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const getUserConversations = async (c: Context) => {
  const { id } = c.get("user");

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return c.json({ error: "Invalid user ID format" }, 400);
  }

  try {
    const Conversation = (await import("../models/Conversation.ts")).default;
    const Message = (await import("../models/Message.ts")).default;

    const conversations = await Conversation.find({
      participants: { $in: [id] },
    })
      .populate({
        path: "participants",
        select: "name email profilePic lastSeen",
        match: { _id: { $ne: id } },
      })
      .populate({
        path: "messages",
        options: {
          sort: { createdAt: -1 },
          limit: 1,
        },
        populate: {
          path: "sender",
          select: "name",
        },
      })
      .sort({ updatedAt: -1 });

    interface PopulatedMessage {
      _id: mongoose.Types.ObjectId;
      content: string;
      sender: { _id: mongoose.Types.ObjectId; name: string };
      createdAt: Date;
      edited?: boolean;
    }

    const formattedConversations = conversations.map((conv) => {
      function isPopulatedMessage(msg: any): msg is PopulatedMessage {
        return (
          msg &&
          typeof msg === "object" &&
          "content" in msg &&
          "sender" in msg &&
          "createdAt" in msg
        );
      }

      const lastMsgDoc =
        Array.isArray(conv.messages) &&
        conv.messages.length > 0 &&
        isPopulatedMessage(conv.messages[0])
          ? conv.messages[0]
          : null;

      const lastMessage = lastMsgDoc
        ? {
            _id: lastMsgDoc._id,
            content: lastMsgDoc.content,
            sender: lastMsgDoc.sender,
            createdAt: lastMsgDoc.createdAt,
            edited: lastMsgDoc.edited || false,
          }
        : null;

      return {
        _id: conv._id,
        participants: conv.participants,
        lastMessage,
        unreadCount: 0,
        createdAt: conv.createdAt,
        updatedAt: conv.updatedAt,
      };
    });

    return c.json({ conversations: formattedConversations }, 200);
  } catch (error) {
    console.error("Error fetching user conversations:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};
