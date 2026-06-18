export const getUserSettings = async (c: Context) => {
  const { id } = c.get("user");
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return c.json({ error: "Invalid user ID format" }, 400);
  }
  try {
    const user = await User.findById(id).select("settings");
    if (!user) {
      return c.json({ error: "User not found" }, 404);
    }
    return c.json({ settings: user.settings }, 200);
  } catch (error) {
    console.error("Error fetching user settings:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const updateUserSettings = async (c: Context) => {
  const { id } = c.get("user");
  const body = await c.req.json();
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return c.json({ error: "Invalid user ID format" }, 400);
  }
  try {
    const allowedFields = [
      "privacy",
      "notifications",
      "theme",
      "language",
      "connectedAccounts",
      "mutedServers",
    ];
    const update: any = {};
    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        if (field === "theme" && typeof body[field] === "string") {
          update[`settings.${field}`] = body[field].replace(
            /[^a-zA-Z0-9_-]/g,
            ""
          );
        } else if (field === "language" && typeof body[field] === "string") {
          update[`settings.${field}`] = body[field].replace(/[^a-zA-Z-]/g, "");
        } else if (
          field === "connectedAccounts" &&
          Array.isArray(body[field])
        ) {
          update[`settings.${field}`] = body[field].map((acc: any) => ({
            provider: String(acc.provider).replace(/[^a-zA-Z0-9_-]/g, ""),
            accountId: String(acc.accountId).replace(/[^a-zA-Z0-9_-]/g, ""),
          }));
        } else if (field === "mutedServers" && Array.isArray(body[field])) {
          const cleaned = body[field].filter((id: any) =>
            mongoose.Types.ObjectId.isValid(String(id))
          );
          update[`settings.${field}`] = cleaned;
        } else if (
          field === "notifications" &&
          typeof body[field] === "object"
        ) {
          const notif = body[field] || {};
          const nUpdate: any = {};
          if (typeof notif.email === "boolean") nUpdate.email = notif.email;
          if (typeof notif.push === "boolean") nUpdate.push = notif.push;
          if (["all", "mentions", "none"].includes(notif.level))
            nUpdate.level = notif.level;
          update["settings.notifications"] = {
            ...(update["settings.notifications"] || {}),
            ...nUpdate,
          };
        } else {
          update[`settings.${field}`] = body[field];
        }
      }
    }
    const user = await User.findByIdAndUpdate(
      id,
      { $set: update },
      { new: true }
    ).select("settings");
    if (!user) {
      return c.json({ error: "User not found" }, 404);
    }
    await invalidateAfterUserUpdate(id);
    return c.json({ settings: user.settings }, 200);
  } catch (error) {
    console.error("Error updating user settings:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};
import mongoose from "mongoose";
import { Context } from "hono";
import User from "../models/User.ts";
import DiscordServer from "../models/DiscordServer.ts";
import { Server } from "socket.io";
import {
  createNotification,
  sendNotificationViaSocket,
} from "./notificationController.ts";
import { getIoInstance } from "../config/socket.ts";
import { invalidateAfterUserUpdate } from "../lib/cacheInvalidation.ts";
import ServerMember from "../models/ServerMember.ts";

export const getAllUsers = async (c: Context) => {
  try {
    const auth = c.get("user");
    const authId = auth?.id;
    const users = await User.find();
    if (users.length === 0) {
      return c.json({ message: "No users found" }, 404);
    }
    if (authId && mongoose.Types.ObjectId.isValid(authId)) {
      const me = await User.findById(authId).select("friends");
      const friendSet = new Set((me?.friends || []).map(String));
      const enriched = users.map((u) => ({
        _id: u._id,
        name: u.name,
        email: u.email,
        profilePic: u.profilePic,
        lastSeen: u.lastSeen,
        isFriend: friendSet.has(String(u._id)),
      }));
      return c.json({ users: enriched }, 200);
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

export const listFriends = async (c: Context) => {
  const { id } = c.get("user");
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return c.json({ error: "Invalid user ID format" }, 400);
  }
  try {
    const me = await User.findById(id).populate({
      path: "friends",
      select: "name email profilePic lastSeen",
    });
    const friends = Array.isArray(me?.friends) ? (me.friends as any) : [];
    return c.json({ friends }, 200);
  } catch (error) {
    console.error("Error listing friends:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const addFriend = async (c: Context) => {
  const { id } = c.get("user");
  const { friendId } = await c.req.json();
  if (
    !mongoose.Types.ObjectId.isValid(id) ||
    !mongoose.Types.ObjectId.isValid(friendId)
  ) {
    return c.json({ error: "Invalid ID format" }, 400);
  }
  if (id === friendId) {
    return c.json({ error: "Cannot add yourself as friend" }, 400);
  }
  try {
    const [me, friend] = await Promise.all([
      User.findByIdAndUpdate(
        id,
        { $addToSet: { friends: friendId } },
        { new: true }
      ).select("friends name"),
      User.findByIdAndUpdate(
        friendId,
        { $addToSet: { friends: id } },
        { new: true }
      ).select("friends name"),
    ]);
    if (!me || !friend) return c.json({ error: "User not found" }, 404);

    const notification = await createNotification({
      recipient: friendId,
      sender: id,
      type: "friend_accepted",
      title: "New Friend",
      message: `${me.name} added you as a friend`,
      metadata: {
        friendId: id,
        friendName: me.name,
      },
      actionUrl: `/community/me/friends`,
    });

    const io = c.get("io" as any) as Server | undefined;
    if (io && notification) {
      sendNotificationViaSocket(io, friendId, notification);
    }

    return c.json({ message: "Friend added" }, 200);
  } catch (error) {
    console.error("Error adding friend:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const removeFriend = async (c: Context) => {
  const { id } = c.get("user");
  const { friendId } = await c.req.json();
  if (
    !mongoose.Types.ObjectId.isValid(id) ||
    !mongoose.Types.ObjectId.isValid(friendId)
  ) {
    return c.json({ error: "Invalid ID format" }, 400);
  }
  try {
    await Promise.all([
      User.findByIdAndUpdate(id, { $pull: { friends: friendId } }),
      User.findByIdAndUpdate(friendId, { $pull: { friends: id } }),
    ]);
    return c.json({ message: "Friend removed" }, 200);
  } catch (error) {
    console.error("Error removing friend:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const editUser = async (c: Context) => {
  const { id } = c.req.param();
  const body = await c.req.json();
  const { name, profilePic } = body;
  const editorId = c.get("user").id;

  if (
    !mongoose.Types.ObjectId.isValid(id) ||
    !mongoose.Types.ObjectId.isValid(editorId)
  ) {
    return c.json({ error: "Invalid ID format" }, 400);
  }

  if (id !== editorId) {
    return c.json({ error: "Permission denied" }, 403);
  }

  try {
    const user = await User.findById(id);
    if (!user) {
      return c.json({ message: "No such user exists" }, 404);
    }
    if (name) user.name = name;
    await user.save();
    if (profilePic) user.profilePic = profilePic;
    await user.save();

    await invalidateAfterUserUpdate(id);
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

export const updateLastSeen = async (c: Context) => {
  const { id } = c.get("user");

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return c.json({ error: "Invalid user ID format" }, 400);
  }

  try {
    const updatedUser = await User.findByIdAndUpdate(
      id,
      { lastSeen: new Date() },
      { new: true }
    ).select("lastSeen");

    if (!updatedUser) {
      return c.json({ error: "User not found" }, 404);
    }

    return c.json(
      { message: "Last seen updated", lastSeen: updatedUser.lastSeen },
      200
    );
  } catch (error) {
    console.error("Error updating last seen:", error);
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
    await ServerMember.findOneAndUpdate(
      { server: serverId, user: id },
      { $set: { roles: ["member"] } },
      { upsert: true }
    );
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
    await ServerMember.deleteOne({ server: serverId, user: id });
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
  const limit = parseInt(c.req.query("limit") || "50", 10);
  const skip = (page - 1) * limit;

  try {
    const query = {
      $or: [{ owner: id }, { members: { $elemMatch: { user: id } } }],
    };

    const totalServers = await DiscordServer.countDocuments(query);

    const servers = await DiscordServer.find(query)
      .populate("owner", "name email profilePic")
      .populate({
        path: "members.user",
        select: "name email profilePic lastSeen",
      })
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    if (servers.length === 0 && totalServers === 0) {
      return c.json({
        servers: [],
        totalPages: 0,
        currentPage: page,
        totalServers: 0,
      });
    }

    return c.json({
      servers,
      totalPages: Math.ceil(totalServers / limit),
      currentPage: page,
      totalServers,
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

    const conversations = await Conversation.find({
      participants: { $in: [id] },
      $or: [{ hiddenFor: { $exists: false } }, { hiddenFor: { $nin: [id] } }],
      $and: [
        {
          $or: [
            { deletedFor: { $exists: false } },
            { deletedFor: { $nin: [id] } },
          ],
        },
      ],
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

      const deletedAt = conv.deletedAt?.get(id.toString());
      const shouldShowLastMessage =
        !deletedAt ||
        (lastMsgDoc && new Date(lastMsgDoc.createdAt) > deletedAt);

      const lastMessage =
        lastMsgDoc && shouldShowLastMessage
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

export const updateProfile = async (c: Context) => {
  const { id } = c.req.param();
  const { id: userId } = c.get("user");

  if (
    !mongoose.Types.ObjectId.isValid(id) ||
    !mongoose.Types.ObjectId.isValid(userId)
  ) {
    return c.json({ error: "Invalid ID format" }, 400);
  }

  if (id !== userId) {
    return c.json({ error: "You can only update your own profile" }, 403);
  }

  try {
    const body = await c.req.parseBody();
    const { name, about } = body;
    let profilePic = body.profilePic as File | undefined;

    const user = await User.findById(id);
    if (!user) {
      return c.json({ error: "User not found" }, 404);
    }

    if (name && typeof name === "string") {
      user.name = name.trim().substring(0, 50);
    }

    if (about !== undefined) {
      if (typeof about === "string") {
        // @ts-ignore - about field exists but not in type
        user.about = about.trim().substring(0, 190);
      }
    }

    if (profilePic && profilePic.size > 0) {
      const { uploadOnCloudinary } = await import("../lib/cloudinary.ts");
      const arrayBuffer = await profilePic.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      const cloudinaryResponse = await uploadOnCloudinary(buffer, {
        folder: "profile_pics",
      });

      if (cloudinaryResponse) {
        user.profilePic = cloudinaryResponse.secure_url;
      }
    }

    await user.save();

    const io = getIoInstance();
    if (io) {
      io.emit("user:profile-changed", {
        userId: String(user._id),
        name: user.name,
        profilePic: user.profilePic,
        // @ts-ignore
        about: user.about,
        timestamp: Date.now(),
      });
      console.log("Profile update broadcasted via socket:", {
        userId: String(user._id),
        name: user.name,
      });
    }

    await invalidateAfterUserUpdate(id);
    return c.json(
      {
        message: "Profile updated successfully",
        user: {
          _id: user._id,
          name: user.name,
          email: user.email,
          profilePic: user.profilePic,
          // @ts-ignore
          about: user.about,
        },
      },
      200
    );
  } catch (error) {
    console.error("Error updating profile:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};
