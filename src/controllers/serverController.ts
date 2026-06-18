import { Context } from "hono";
import DiscordServer from "../models/DiscordServer.ts";
import Category from "../models/Category.ts";
import mongoose from "mongoose";
import Channel from "../models/Channel.ts";
import Message from "../models/Message.ts";
import Thread from "../models/Thread.ts";
import ChannelReadStatus from "../models/ChannelReadStatus.ts";
import Notification from "../models/Notification.ts";
import User from "../models/User.ts";
import { Server } from "socket.io";
import { uploadOnCloudinary } from "../lib/cloudinary.ts";
import { nanoid } from "nanoid";
import Invite from "../models/Invite.ts";
import { checkPermission } from "../lib/permissionHelper.ts";
import { Buffer } from "node:buffer";
import {
  createNotification,
  sendNotificationViaSocket,
} from "./notificationController.ts";
import AuditLog from "../models/AuditLog.ts";
import { invalidateAfterServerUpdate } from "../lib/cacheInvalidation.ts";
import ServerMember from "../models/ServerMember.ts";

export const searchServers = async (c: Context) => {
  const query = c.req.query("q") || "";
  const limit = Number.parseInt(c.req.query("limit") || "20", 10);
  const skip = Number.parseInt(c.req.query("skip") || "0", 10);
  if (!query) {
    return c.json({ error: "Query required" }, 400);
  }
  try {
    const filter = { name: { $regex: query, $options: "i" } };
    const total = await DiscordServer.countDocuments(filter);
    const servers = await DiscordServer.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();
    return c.json({ servers, total, limit, skip }, 200);
  } catch (error) {
    console.error("Error in searchServers:", error);
    return c.json({ error: "Search failed" }, 500);
  }
};
export const getAuditLogs = async (c: Context) => {
  const { serverId } = c.req.param();
  if (!mongoose.Types.ObjectId.isValid(serverId)) {
    return c.json({ error: "Invalid server ID format" }, 400);
  }
  const logs = await AuditLog.find({ server: serverId })
    .sort({ createdAt: -1 })
    .lean();
  return c.json({ logs }, 200);
};
export const kickUser = async (c: Context) => {
  const { serverId, userId } = c.req.param();
  const modUser = c.get("user");
  if (
    !mongoose.Types.ObjectId.isValid(serverId) ||
    !mongoose.Types.ObjectId.isValid(userId)
  ) {
    return c.json({ error: "Invalid ID format" }, 400);
  }
  const server = await DiscordServer.findById(serverId);
  if (!server) return c.json({ error: "Server not found" }, 404);
  const isMod =
    server.owner.toString() === modUser.id ||
    !!(await ServerMember.exists({ server: serverId, user: modUser.id, roles: "mod" }));
  if (!isMod) return c.json({ error: "Permission denied" }, 403);
  await DiscordServer.findByIdAndUpdate(serverId, { $pull: { members: { user: userId } } });
  await ServerMember.deleteOne({ server: serverId, user: userId });
  await AuditLog.create({
    server: server._id,
    action: "kick",
    performedBy: modUser.id,
    targetUser: userId,
    details: `User ${userId} kicked by ${modUser.id}`,
  });
  const io = c.get("io") as Server | undefined;
  if (io) {
    io.to(serverId).emit("moderation:kick", { userId, by: modUser.id });
  }
  return c.json({ message: "User kicked", userId }, 200);
};
interface UserPayload {
  id: string;
  email: string;
}

export const createServer = async (
  c: Context<{ Variables: { user: UserPayload } }>
) => {
  const user = c.get("user");
  const body = await c.req.formData();
  const serverName = body.get("name") as string;
  const imageFile = body.get("imageFile") as File;
  const description = body.get("description") as string;
  const serverType = body.get("serverType") as string;

  if (!serverName) {
    return c.json({ error: "Server name is required" }, 400);
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    let imageUrl = "";
    if (imageFile && imageFile.size > 0) {
      const arrayBuffer = await imageFile.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const cloudinaryResponse = await uploadOnCloudinary(buffer, {
        folder: "server_icons",
      });
      if (!cloudinaryResponse) {
        throw new Error("Failed to upload image");
      }
      imageUrl = cloudinaryResponse.secure_url;
    }

    const newServer = new DiscordServer({
      name: serverName,
      description,
      imageUrl,
      owner: user.id,
      visibility: serverType,
      members: [{ user: user.id, roles: ["owner"] }],
    });
    await newServer.save({ session });
    await ServerMember.findOneAndUpdate(
      { server: newServer._id, user: user.id },
      { $set: { roles: ["owner"] } },
      { upsert: true, session }
    );

    const [notesCategory, socialCategory, doubtsCategory] =
      await Category.create(
        [
          { name: "Notes", server: newServer._id },
          { name: "Social Zone", server: newServer._id },
          { name: "Doubts", server: newServer._id },
        ],
        { session, ordered: true }
      );

    const [notesChannel, socialChannel, doubtsChannel] = await Channel.create(
      [
        {
          name: "notes",
          type: "Text",
          category: notesCategory._id,
          server: newServer._id,
        },
        {
          name: "social-zone",
          type: "Text",
          category: socialCategory._id,
          server: newServer._id,
        },
        {
          name: "doubts",
          type: "Text",
          category: doubtsCategory._id,
          server: newServer._id,
        },
      ],
      { session, ordered: true }
    );

    await Promise.all([
      Category.findByIdAndUpdate(
        notesCategory._id,
        { $push: { channels: notesChannel._id } },
        { session }
      ),
      Category.findByIdAndUpdate(
        socialCategory._id,
        { $push: { channels: socialChannel._id } },
        { session }
      ),
      Category.findByIdAndUpdate(
        doubtsCategory._id,
        { $push: { channels: doubtsChannel._id } },
        { session }
      ),
    ]);

    newServer.categories = [
      notesCategory._id,
      socialCategory._id,
      doubtsCategory._id,
    ];
    newServer.channels = [
      notesChannel._id,
      socialChannel._id,
      doubtsChannel._id,
    ];
    await newServer.save({ session });

    await User.findByIdAndUpdate(
      user.id,
      { $addToSet: { servers: newServer._id } },
      { session }
    );

    const populatedServer = await DiscordServer.findById(newServer._id)
      .populate({
        path: "categories",
        populate: {
          path: "channels",
          model: "Channel",
        },
      })
      .session(session);

    await session.commitTransaction();

    return c.json(
      { message: "Server created successfully", server: populatedServer },
      201
    );
  } catch (error) {
    await session.abortTransaction();
    console.error("Error creating server:", error);
    return c.json({ error: "Internal server error" }, 500);
  } finally {
    session.endSession();
  }
};

export const getServerById = async (c: Context) => {
  const { id: serverId } = c.req.param();

  try {
    if (!mongoose.Types.ObjectId.isValid(serverId)) {
      return c.json({ error: "Invalid server id" }, 400);
    }

    const [server, serverMembers] = await Promise.all([
      DiscordServer.findById(serverId)
        .populate({ path: "owner", select: "name profilePic" })
        .populate({
          path: "categories",
          populate: { path: "channels", model: "Channel" },
        })
        .lean(),
      ServerMember.find({ server: serverId })
        .populate("user", "name profilePic")
        .lean(),
    ]);

    if (!server) {
      return c.json({ message: "Server not found" }, 404);
    }

    return c.json({ server: { ...server, members: serverMembers } }, 200);
  } catch (error) {
    console.error("Error fetching server details:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const editServer = async (
  c: Context<{ Variables: { user: UserPayload } }>
) => {
  const { serverId } = c.req.param();
  const user = c.get("user");

  const permServer = await DiscordServer.findById(serverId).lean();
  if (!permServer) return c.json({ error: "Server not found" }, 404);
  const isOwner = permServer.owner?.toString() === user.id;
  const hasRole = !!(await ServerMember.exists({
    server: serverId,
    user: user.id,
    roles: { $in: ["owner", "admin", "edit server"] },
  }));
  if (!isOwner && !hasRole) {
    return c.json({ error: "Permission denied" }, 403);
  }

  try {
    const body = await c.req.formData();
    const newName = body.get("name") as string;
    const imageFile = body.get("imageFile") as File;
    const description = body.get("description") as string;
    const serverType = body.get("serverType") as string as
      | "public"
      | "private"
      | undefined;
    const updates: {
      name?: string;
      imageUrl?: string;
      description?: string;
      visibility?: "public" | "private";
    } = {};

    if (newName) updates.name = newName;

    if (imageFile && imageFile.size > 0) {
      const arrayBuffer = await imageFile.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const cloudinaryResponse = await uploadOnCloudinary(buffer, {
        folder: "server_icons",
      });
      if (!cloudinaryResponse)
        return c.json({ error: "Failed to upload image" }, 500);
      updates.imageUrl = cloudinaryResponse.secure_url;
    }

    if (description !== undefined) updates.description = description;
    if (serverType === "public" || serverType === "private") {
      updates.visibility = serverType;
    }

    if (Object.keys(updates).length === 0) {
      return c.json({ error: "No update data provided" }, 400);
    }

    const updatedServer = await DiscordServer.findByIdAndUpdate(
      serverId,
      { $set: updates },
      { new: true }
    );

    await AuditLog.create({
      server: serverId,
      action: "server_update",
      performedBy: user.id,
      details: `Server updated: ${Object.keys(updates).join(", ")}`,
    });

    const io = (c as any).get("io") as Server | undefined;
    if (io) {
      io.to(serverId.toString()).emit("server:updated", {
        serverId,
        updates,
      });
    }

    await invalidateAfterServerUpdate(serverId);
    return c.json(
      { message: "Server updated successfully", server: updatedServer },
      200
    );
  } catch (error) {
    console.error("Error updating server:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const deleteServer = async (
  c: Context<{ Variables: { user: UserPayload } }>
) => {
  const { serverId } = c.req.param();
  const user = c.get("user");

  const server = await DiscordServer.findById(serverId);
  if (!server) return c.json({ error: "Server not found" }, 404);
  if (server.owner.toString() !== user.id) {
    return c.json(
      { error: "Only the server owner can delete the server" },
      403
    );
  }

  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const channelIds = await Channel.find({ server: serverId })
      .select("_id")
      .session(session);
    const channelIdList = channelIds.map((c: any) => c._id);

    await Promise.all([
      Message.deleteMany({ server: serverId }, { session }),
      Thread.deleteMany({ server: serverId }, { session }),
      channelIdList.length
        ? ChannelReadStatus.deleteMany(
            { channel: { $in: channelIdList } },
            { session }
          )
        : Promise.resolve(),
      Invite.deleteMany({ server: serverId }, { session }),
      AuditLog.deleteMany({ server: serverId }, { session }),
      Notification.deleteMany({ "metadata.serverId": serverId }, { session }),
    ]);

    await Promise.all([
      Channel.deleteMany({ server: serverId }, { session }),
      Category.deleteMany({ server: serverId }, { session }),
    ]);

    await User.updateMany(
      { servers: serverId },
      { $pull: { servers: serverId } },
      { session }
    );

    await DiscordServer.findByIdAndDelete(serverId, { session });

    await session.commitTransaction();

    const io = (c as any).get("io") as Server | undefined;
    if (io) {
      io.to(serverId.toString()).emit("server:deleted", { serverId });
    }

    return c.json({ message: "Server deleted successfully" }, 200);
  } catch (error) {
    await session.abortTransaction();
    console.error("Error deleting server:", error);
    return c.json({ error: "Internal server error" }, 500);
  } finally {
    session.endSession();
  }
};

export const createInvite = async (
  c: Context<{ Variables: { user: UserPayload } }>
) => {
  const { serverId } = c.req.param();
  const user = c.get("user");

  if (!(await checkPermission(serverId, user.id, "create invite"))) {
    return c.json({ error: "Permission denied" }, 403);
  }

  try {
    const code = nanoid(10);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    const newInvite = await Invite.create({
      code,
      server: serverId,
      createdBy: user.id,
      expiresAt,
    });

    const populatedInvite = await Invite.findById(newInvite._id)
      .populate("createdBy", "name profilePic")
      .lean();

    const inviteLink = `${
      process.env.FRONTEND_URL || "http://localhost:3000"
    }/invite/${code}`;

    return c.json({ inviteLink, invite: populatedInvite }, 201);
  } catch (error) {
    console.error("Error creating invite:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const getServerInvites = async (
  c: Context<{ Variables: { user: UserPayload } }>
) => {
  const { serverId } = c.req.param();
  const user = c.get("user");

  if (!mongoose.Types.ObjectId.isValid(serverId)) {
    return c.json({ error: "Invalid server ID format" }, 400);
  }

  try {
    const server = await DiscordServer.findById(serverId).lean();
    if (!server) {
      return c.json({ error: "Server not found" }, 404);
    }

    const isOwner = server.owner.toString() === user.id;
    const isMember =
      !isOwner &&
      !!(await ServerMember.exists({ server: serverId, user: user.id }));

    if (!isOwner && !isMember) {
      return c.json({ error: "Permission denied" }, 403);
    }

    const invites = await Invite.find({
      server: serverId,
      expiresAt: { $gt: new Date() },
    })
      .populate("createdBy", "name profilePic")
      .sort({ createdAt: -1 })
      .lean();

    return c.json({ invites }, 200);
  } catch (error) {
    console.error("Error fetching invites:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const deleteInvite = async (
  c: Context<{ Variables: { user: UserPayload } }>
) => {
  const { inviteId } = c.req.param();
  const user = c.get("user");

  if (!mongoose.Types.ObjectId.isValid(inviteId)) {
    return c.json({ error: "Invalid invite ID format" }, 400);
  }

  try {
    const invite = await Invite.findById(inviteId).lean();
    if (!invite) {
      return c.json({ error: "Invite not found" }, 404);
    }

    const server = await DiscordServer.findById(invite.server).lean();
    if (!server) {
      return c.json({ error: "Server not found" }, 404);
    }

    const isCreator = invite.createdBy.toString() === user.id;
    const isOwner = server.owner.toString() === user.id;
    const isAdmin =
      !isCreator &&
      !isOwner &&
      !!(await ServerMember.exists({
        server: invite.server,
        user: user.id,
        roles: { $in: ["admin", "owner"] },
      }));

    if (!isCreator && !isOwner && !isAdmin) {
      return c.json({ error: "Permission denied" }, 403);
    }

    await Invite.findByIdAndDelete(inviteId);

    return c.json({ message: "Invite deleted successfully" }, 200);
  } catch (error) {
    console.error("Error deleting invite:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const acceptInvite = async (
  c: Context<{ Variables: { user: UserPayload } }>
) => {
  const { inviteCode } = c.req.param();
  const user = c.get("user");

  try {
    const invite = await Invite.findOne({ code: inviteCode });
    if (!invite) return c.json({ error: "Invalid invite code" }, 404);
    if (invite.expiresAt && invite.expiresAt < new Date()) {
      return c.json({ error: "This invite has expired" }, 400);
    }

    const serverId = invite.server;
    const alreadyMember = await ServerMember.exists({ server: serverId, user: user.id });
    if (alreadyMember) {
      const existingServer = await DiscordServer.findById(serverId);
      return c.json({
        message: "You are already a member of this server",
        server: existingServer,
      });
    }

    const updatedServer = await DiscordServer.findByIdAndUpdate(
      serverId,
      { $addToSet: { members: { user: user.id, roles: ["member"] } } },
      { new: true }
    );
    await ServerMember.findOneAndUpdate(
      { server: serverId, user: user.id },
      { $set: { roles: ["member"] } },
      { upsert: true }
    );
    await User.findByIdAndUpdate(user.id, { $addToSet: { servers: serverId } });

    return c.json({
      message: "Joined server successfully!",
      server: updatedServer,
    });
  } catch (error) {
    console.error("Error accepting invite:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const getAllServers = async (c: Context) => {
  try {
    const page = parseInt(c.req.query("page") || "1", 10);
    const limit = parseInt(c.req.query("limit") || "10", 10);
    const skip = (page - 1) * limit;

    const totalServers = await DiscordServer.countDocuments();

    const servers = await DiscordServer.find()
      .populate("owner", "name profilePic")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    if (servers.length === 0 && totalServers === 0) {
      return c.json({ message: "No servers found" }, 404);
    }

    return c.json(
      {
        servers,
        totalPages: Math.ceil(totalServers / limit),
        currentPage: page,
      },
      200
    );
  } catch (error) {
    console.error("Error fetching servers: ", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const getUnreadCounts = async (c: Context) => {
  const { serverId } = c.req.param();
  const user = c.get("user");
  if (
    !mongoose.Types.ObjectId.isValid(serverId) ||
    !mongoose.Types.ObjectId.isValid(user?.id)
  ) {
    return c.json({ error: "Invalid ID format" }, 400);
  }
  try {
    const channels = await Channel.find({ server: serverId }).select("_id");
    const channelIds = channels.map((c: any) => c._id);
    if (channelIds.length === 0) return c.json({ counts: {} }, 200);

    const readStatuses = await ChannelReadStatus.find({
      user: user.id,
      channel: { $in: channelIds },
    }).select("channel lastReadAt lastReadMessage");

    const statusByChannel = new Map<string, { lastReadAt?: Date }>();
    for (const rs of readStatuses) {
      statusByChannel.set(String(rs.channel), { lastReadAt: rs.lastReadAt });
    }

    const counts: Record<string, number> = {};
    for (const chId of channelIds) {
      counts[String(chId)] = 0;
    }

    const perChannelFilters = channelIds
      .map((id: any) => {
        const lastReadAt = statusByChannel.get(String(id))?.lastReadAt;
        return lastReadAt ? { channel: id, createdAt: { $gt: lastReadAt } } : null;
      })
      .filter((f): f is NonNullable<typeof f> => f !== null);

    if (perChannelFilters.length > 0) {
      const rows = await Message.aggregate([
        { $match: { $or: perChannelFilters } },
        { $group: { _id: "$channel", count: { $sum: 1 } } },
      ]);
      for (const row of rows) {
        counts[String(row._id)] = row.count;
      }
    }

    return c.json({ counts }, 200);
  } catch (error) {
    console.error("Error computing unread counts:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const editMemberRole = async (c: Context) => {
  const { serverId } = c.req.param();
  const body = await c.req.json();
  const { users, roles } = body;
  if (!mongoose.Types.ObjectId.isValid(serverId))
    return c.json({ error: "Invalid server ID format" }, 400);
  if (!users || !roles || !Array.isArray(users) || !Array.isArray(roles)) {
    return c.json(
      { error: "Request must include 'users' and 'roles' arrays." },
      400
    );
  }
  users.forEach((user) => {
    if (!mongoose.Types.ObjectId.isValid(user))
      return c.json({ error: "Invalid user ID format" }, 400);
  });

  try {
    const result = await DiscordServer.updateOne(
      { _id: serverId },
      {
        $set: { "members.$[elem].roles": roles },
      },
      {
        arrayFilters: [{ "elem.user": { $in: users } }],
      }
    );
    await ServerMember.updateMany(
      { server: serverId, user: { $in: users } },
      { $set: { roles } }
    );

    if (result.modifiedCount === 0) {
      return c.json(
        {
          message:
            "No roles were updated. Check if server and user IDs are correct.",
        },
        404
      );
    }

    const io = c.get("io") as Server | undefined;
    if (io) {
      io.to(serverId.toString()).emit("server:updated", {
        serverId,
        updates: { rolesChanged: true },
      });
    }

    return c.json(
      {
        message: `Successfully updated roles for ${result.modifiedCount} members.`,
      },
      200
    );
  } catch (error) {
    console.error("Error setting roles:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};
export const addMember = async (c: Context) => {
  const { serverId } = c.req.param();
  const body = await c.req.json();
  const { userId, role, newMemberId } = body;
  if (
    !mongoose.Types.ObjectId.isValid(serverId) ||
    !mongoose.Types.ObjectId.isValid(userId) ||
    !mongoose.Types.ObjectId.isValid(newMemberId)
  )
    return c.json(
      { error: "Invalid server or user ID format or member ID format" },
      400
    );
  try {
    const newMemberUser = await User.findById(newMemberId);
    if (!newMemberUser) {
      return c.json({ error: "User to be added does not exist." }, 404);
    }
    const [hasPermission, alreadyMember, server] = await Promise.all([
      ServerMember.exists({ server: serverId, user: userId, roles: "add member" }),
      ServerMember.exists({ server: serverId, user: newMemberId }),
      DiscordServer.findById(serverId),
    ]);
    if (!server) {
      return c.json({ error: "Server not found" }, 404);
    }
    if (!hasPermission || alreadyMember) {
      return c.json(
        {
          error:
            "Server not found, user is already a member, or you do not have permission to add members.",
        },
        403
      );
    }

    await DiscordServer.findByIdAndUpdate(serverId, {
      $push: { members: { user: newMemberId, roles: role } },
    });
    await ServerMember.findOneAndUpdate(
      { server: serverId, user: newMemberId },
      { $set: { roles: Array.isArray(role) ? role : role ? [role] : ["member"] } },
      { upsert: true }
    );

    await User.findByIdAndUpdate(newMemberId, {
      $addToSet: { servers: serverId },
    });

    await invalidateAfterServerUpdate(serverId);
    return c.json({ message: "Member added successfully", server }, 200);
  } catch (error) {
    console.error("Error adding member:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};
export const removeMember = async (c: Context) => {
  const { serverId } = c.req.param();
  const { userId, memberToRemoveId } = await c.req.json();

  if (
    !mongoose.Types.ObjectId.isValid(userId) ||
    !mongoose.Types.ObjectId.isValid(serverId) ||
    !mongoose.Types.ObjectId.isValid(memberToRemoveId)
  ) {
    return c.json({ error: "Invalid user, server, or member ID format" }, 400);
  }

  try {
    const hasPermission = await ServerMember.exists({
      server: serverId,
      user: userId,
      roles: "remove member",
    });
    if (!hasPermission) {
      return c.json(
        {
          error:
            "Action failed: Server not found, member not found, or you lack permission.",
        },
        403
      );
    }

    const updatedServer = await DiscordServer.findOneAndUpdate(
      { _id: serverId },
      { $pull: { members: { user: memberToRemoveId } } },
      { new: true }
    );
    if (!updatedServer) {
      return c.json({ error: "Server not found" }, 404);
    }

    await ServerMember.deleteOne({ server: serverId, user: memberToRemoveId });

    await User.findByIdAndUpdate(memberToRemoveId, {
      $pull: { servers: serverId },
    });

    await invalidateAfterServerUpdate(serverId);
    return c.json(
      { message: "Member removed successfully", server: updatedServer },
      200
    );
  } catch (error) {
    console.error("Error removing member:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const banMember = async (c: Context) => {
  const { serverId } = c.req.param();
  const { userId, reason, userToBanId } = await c.req.json();
  const io: Server = c.get("io");
  if (
    !mongoose.Types.ObjectId.isValid(serverId) ||
    !mongoose.Types.ObjectId.isValid(userId) ||
    !mongoose.Types.ObjectId.isValid(userToBanId)
  ) {
    return c.json({ error: "Invalid ID format" }, 400);
  }
  if (!reason) return c.json({ error: "Reason is required" }, 400);
  try {
    const [hasPermission, userToBanExists, userAlreadyBanned] = await Promise.all([
      ServerMember.exists({ server: serverId, user: userId, roles: "ban member" }),
      User.findById(userToBanId).lean(),
      ServerMember.exists({ server: serverId, user: userToBanId, "banned.isBanned": true }),
    ]);
    if (!hasPermission)
      return c.json(
        { error: "You do not have permission to ban members." },
        403
      );
    if (!userToBanExists) return c.json({ error: "User does not exist" }, 404);
    if (userAlreadyBanned)
      return c.json({ error: "User is already banned" }, 400);

    const updatedServer = await DiscordServer.findOneAndUpdate(
      {
        _id: serverId,
        "members.user": userToBanId,
      },
      {
        $set: {
          "members.$.banned": {
            isBanned: true,
            reason: reason,
            bannedBy: userId,
          },
        },
      },
      { new: true }
    );
    if (!updatedServer) return c.json({ error: "Server not found" }, 404);

    await ServerMember.updateOne(
      { server: serverId, user: userToBanId },
      { $set: { banned: { isBanned: true, reason, bannedBy: userId } } }
    );

    await User.findOneAndUpdate(
      {
        _id: userToBanId,
      },
      {
        $pull: {
          servers: serverId,
        },
      }
    );
    io.to(serverId.toString()).emit("memberBanned", { userToBanId, serverId });
    await invalidateAfterServerUpdate(serverId);
    return c.json({ message: "Member banned successfully" }, 200);
  } catch (error) {
    console.error("Error banning member:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const unBanMember = async (c: Context) => {
  const { serverId } = c.req.param();
  const { userId, userToUnbanId } = await c.req.json();
  if (
    !mongoose.Types.ObjectId.isValid(serverId) ||
    !mongoose.Types.ObjectId.isValid(userId) ||
    !mongoose.Types.ObjectId.isValid(userToUnbanId)
  )
    return c.json({ error: "Invalid ID format" }, 400);

  try {
    const [hasPermission, userExists, userBanned] = await Promise.all([
      ServerMember.exists({ server: serverId, user: userId, roles: "unban member" }),
      User.findById(userToUnbanId).lean(),
      ServerMember.exists({ server: serverId, user: userToUnbanId, "banned.isBanned": true }),
    ]);
    if (!hasPermission)
      return c.json(
        { error: "You do not have permission to unban members." },
        403
      );
    if (!userExists) return c.json({ error: "User does not exist" }, 404);
    if (!userBanned) return c.json({ error: "User is not banned" }, 400);
    await DiscordServer.findOneAndUpdate(
      {
        _id: serverId,
        "members.user": userToUnbanId,
      },
      { $unset: { "members.$.banned": "" } }
    );
    await ServerMember.updateOne(
      { server: serverId, user: userToUnbanId },
      { $unset: { banned: "" } }
    );
    return c.json({ message: "User unbanned successfully" }, 200);
  } catch (error) {
    console.error("Error unbanning member:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const muteMember = async (c: Context) => {
  const { serverId } = c.req.param();
  const { userId, reason, userToMuteId, duration } = await c.req.json();
  const io: Server = c.get("io");

  if (
    !mongoose.Types.ObjectId.isValid(serverId) ||
    !mongoose.Types.ObjectId.isValid(userId) ||
    !mongoose.Types.ObjectId.isValid(userToMuteId)
  )
    return c.json({ error: "Invalid ID format" }, 400);
  if (!reason) return c.json({ error: "Reason is required" }, 400);
  if (!duration || typeof duration !== "number")
    return c.json({ error: "Duration (in ms) is required" }, 400);

  try {
    const [hasPermission, memberToMute, userAlreadyMuted] = await Promise.all([
      ServerMember.exists({ server: serverId, user: userId, roles: "mute member" }),
      ServerMember.exists({ server: serverId, user: userToMuteId }),
      ServerMember.exists({ server: serverId, user: userToMuteId, "muted.isMuted": true }),
    ]);
    if (!hasPermission) {
      return c.json(
        { error: "You do not have permission to mute members." },
        403
      );
    }
    if (!memberToMute) {
      return c.json({ error: "User is not a member of this server." }, 404);
    }
    if (userAlreadyMuted) {
      return c.json({ error: "User is already muted." }, 400);
    }
    const expiresAt = new Date(Date.now() + duration);

    await DiscordServer.findOneAndUpdate(
      { _id: serverId, "members.user": userToMuteId },
      {
        $set: {
          "members.$.muted": {
            isMuted: true,
            reason: reason,
            mutedBy: userId,
            expiresAt: expiresAt,
          },
        },
      },
      { new: true }
    );
    await ServerMember.updateOne(
      { server: serverId, user: userToMuteId },
      { $set: { muted: { isMuted: true, reason, mutedBy: userId, expiresAt } } }
    );

    io.to(serverId.toString()).emit("memberMuted", {
      userToMuteId,
      serverId,
      expiresAt,
    });
    return c.json({ message: "Member muted successfully" }, 200);
  } catch (error) {
    console.error("Error muting member:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};
export const unmuteMember = async (c: Context) => {
  const { serverId } = c.req.param();
  const { userId, userToUnmuteId } = await c.req.json();
  if (
    !mongoose.Types.ObjectId.isValid(serverId) ||
    !mongoose.Types.ObjectId.isValid(userId) ||
    !mongoose.Types.ObjectId.isValid(userToUnmuteId)
  )
    return c.json({ error: "Invalid ID format" }, 400);

  try {
    const hasPermission = await ServerMember.exists({
      server: serverId,
      user: userId,
      roles: "unmute member",
    });
    if (!hasPermission)
      return c.json(
        { error: "Action failed. Check if the user exists and is muted." },
        403
      );

    const updatedServer = await DiscordServer.findOneAndUpdate(
      { _id: serverId, "members.user": userToUnmuteId },
      {
        $unset: { "members.$[elem].muted": "" },
      },
      {
        arrayFilters: [{ "elem.user": new mongoose.Types.ObjectId(userToUnmuteId) }],
        new: true,
      }
    );
    if (!updatedServer)
      return c.json({ error: "Server not found" }, 404);

    await ServerMember.updateOne(
      { server: serverId, user: userToUnmuteId },
      { $unset: { muted: "" } }
    );
    return c.json({ message: "Member unmuted successfully" }, 200);
  } catch (error) {
    console.error("Error unmuting member:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const requestJoinServer = async (
  c: Context<{ Variables: { user: UserPayload } }>
) => {
  const { serverId } = c.req.param();
  const user = c.get("user");

  if (!mongoose.Types.ObjectId.isValid(serverId)) {
    return c.json({ error: "Invalid server ID format" }, 400);
  }

  try {
    const server = await DiscordServer.findById(serverId);
    if (!server) {
      return c.json({ error: "Server not found" }, 404);
    }

    if (server.visibility === "public") {
      return c.json(
        {
          error:
            "This is a public server. You can join directly without a request.",
        },
        400
      );
    }

    const isMember = await ServerMember.exists({ server: serverId, user: user.id });
    if (isMember) {
      return c.json({ error: "You are already a member of this server" }, 400);
    }

    server.joinRequests ??= [];

    const existingRequest = server.joinRequests.find(
      (req: any) => req.user.toString() === user.id && req.status === "pending"
    );
    if (existingRequest) {
      return c.json(
        {
          message: "Join request already sent",
          alreadyRequested: true,
        },
        200
      );
    }

    await DiscordServer.findByIdAndUpdate(serverId, {
      $push: {
        joinRequests: {
          user: user.id,
          requestedAt: new Date(),
          status: "pending",
        },
      },
    });

    const requestUser = await User.findById(user.id).select("name profilePic");

    const notification = await createNotification({
      recipient: server.owner.toString(),
      sender: user.id,
      type: "join_request",
      title: "New Join Request",
      message: `${requestUser?.name || "A user"} wants to join ${server.name}`,
      metadata: {
        serverId: server._id,
        serverName: server.name,
        requestUserId: user.id,
      },
      actionUrl: `/community/${server._id}?openSettings=join-requests`,
    });

    const io = c.get("io" as any) as Server | undefined;
    if (io && notification) {
      sendNotificationViaSocket(io, server.owner.toString(), notification);
      io.to(server.owner.toString()).emit("joinRequest", {
        serverId,
        userId: user.id,
        userName: requestUser?.name,
      });
    }

    return c.json({ message: "Join request sent successfully" }, 200);
  } catch (error) {
    console.error("Error requesting to join server:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const getJoinRequests = async (
  c: Context<{ Variables: { user: UserPayload } }>
) => {
  const { serverId } = c.req.param();
  const user = c.get("user");

  if (!mongoose.Types.ObjectId.isValid(serverId)) {
    return c.json({ error: "Invalid server ID format" }, 400);
  }

  try {
    const server = await DiscordServer.findById(serverId)
      .populate({
        path: "joinRequests.user",
        select: "name email profilePic",
      })
      .lean();

    if (!server) {
      return c.json({ error: "Server not found" }, 404);
    }

    const isOwner = server.owner.toString() === user.id;
    const isAdmin =
      !isOwner &&
      !!(await ServerMember.exists({
        server: serverId,
        user: user.id,
        roles: { $in: ["admin", "owner"] },
      }));

    if (!isOwner && !isAdmin) {
      return c.json({ error: "Permission denied" }, 403);
    }

    const pendingRequests =
      server.joinRequests?.filter((req: any) => req.status === "pending") || [];

    return c.json({ joinRequests: pendingRequests }, 200);
  } catch (error) {
    console.error("Error fetching join requests:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const approveJoinRequest = async (
  c: Context<{ Variables: { user: UserPayload } }>
) => {
  const { serverId } = c.req.param();
  const { requestUserId } = await c.req.json();
  const user = c.get("user");

  if (
    !mongoose.Types.ObjectId.isValid(serverId) ||
    !mongoose.Types.ObjectId.isValid(requestUserId)
  ) {
    return c.json({ error: "Invalid ID format" }, 400);
  }

  try {
    const server = await DiscordServer.findById(serverId);
    if (!server) {
      return c.json({ error: "Server not found" }, 404);
    }

    const isOwner = server.owner.toString() === user.id;
    const isAdmin =
      !isOwner &&
      !!(await ServerMember.exists({
        server: serverId,
        user: user.id,
        roles: { $in: ["admin", "owner"] },
      }));

    if (!isOwner && !isAdmin) {
      return c.json({ error: "Permission denied" }, 403);
    }

    const requestUser = await User.findById(requestUserId).select(
      "name email profilePic"
    );

    await DiscordServer.findOneAndUpdate(
      { _id: serverId, "joinRequests.user": requestUserId },
      {
        $pull: { joinRequests: { user: requestUserId } },
        $push: { members: { user: requestUserId, roles: ["member"] } },
      }
    );
    await ServerMember.findOneAndUpdate(
      { server: serverId, user: requestUserId },
      { $set: { roles: ["member"] } },
      { upsert: true }
    );

    await User.findByIdAndUpdate(requestUserId, {
      $addToSet: { servers: serverId },
    });

    const userNotification = await createNotification({
      recipient: requestUserId,
      sender: user.id,
      type: "join_approved",
      title: "Join Request Approved",
      message: `Your request to join ${server.name} has been approved!`,
      metadata: {
        serverId: server._id,
        serverName: server.name,
        approvedBy: user.id,
      },
      actionUrl: `/community/${server._id}`,
    });

    if (
      server.owner.toString() !== user.id &&
      server.owner.toString() !== requestUserId
    ) {
      await createNotification({
        recipient: server.owner.toString(),
        sender: requestUserId,
        type: "member_joined",
        title: "New Member Joined",
        message: `${requestUser?.name || "A user"} joined ${server.name}`,
        metadata: {
          serverId: server._id,
          serverName: server.name,
          newMemberId: requestUserId,
        },
        actionUrl: `/community/${server._id}`,
      });
    }

    const io = c.get("io" as any) as Server | undefined;
    if (io) {
      if (userNotification) {
        sendNotificationViaSocket(io, requestUserId, userNotification);
      }

      io.to(requestUserId).emit("joinRequestApproved", {
        serverId,
        serverName: server.name,
      });

      io.to(serverId.toString()).emit("serverUpdated", {
        serverId,
        updateType: "newMember",
        userId: requestUserId,
        username: requestUser?.name || "New member",
      });

      io.to(serverId.toString()).emit("memberJoined", {
        userId: requestUserId,
        username: requestUser?.name || "New member",
      });
    }

    return c.json(
      {
        message: "Join request approved successfully",
        newMember: {
          userId: requestUserId,
          username: requestUser?.name,
        },
      },
      200
    );
  } catch (error) {
    console.error("Error approving join request:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const rejectJoinRequest = async (
  c: Context<{ Variables: { user: UserPayload } }>
) => {
  const { serverId } = c.req.param();
  const { requestUserId } = await c.req.json();
  const user = c.get("user");

  if (
    !mongoose.Types.ObjectId.isValid(serverId) ||
    !mongoose.Types.ObjectId.isValid(requestUserId)
  ) {
    return c.json({ error: "Invalid ID format" }, 400);
  }

  try {
    const server = await DiscordServer.findById(serverId);
    if (!server) {
      return c.json({ error: "Server not found" }, 404);
    }

    const isOwner = server.owner.toString() === user.id;
    const isAdmin =
      !isOwner &&
      !!(await ServerMember.exists({
        server: serverId,
        user: user.id,
        roles: { $in: ["admin", "owner"] },
      }));

    if (!isOwner && !isAdmin) {
      return c.json({ error: "Permission denied" }, 403);
    }

    await DiscordServer.findOneAndUpdate(
      { _id: serverId, "joinRequests.user": requestUserId },
      {
        $set: { "joinRequests.$.status": "rejected" },
      }
    );

    const notification = await createNotification({
      recipient: requestUserId,
      sender: user.id,
      type: "join_rejected",
      title: "Join Request Declined",
      message: `Your request to join ${server.name} was declined.`,
      metadata: {
        serverId: server._id,
        serverName: server.name,
        rejectedBy: user.id,
      },
    });

    const io = c.get("io" as any) as Server | undefined;
    if (io) {
      if (notification) {
        sendNotificationViaSocket(io, requestUserId, notification);
      }
      io.to(requestUserId).emit("joinRequestRejected", {
        serverId,
        serverName: server.name,
      });
    }

    return c.json({ message: "Join request rejected successfully" }, 200);
  } catch (error) {
    console.error("Error rejecting join request:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const cancelJoinRequest = async (
  c: Context<{ Variables: { user: UserPayload } }>
) => {
  const { serverId } = c.req.param();
  const user = c.get("user");

  if (!mongoose.Types.ObjectId.isValid(serverId)) {
    return c.json({ error: "Invalid server ID format" }, 400);
  }

  try {
    const server = await DiscordServer.findById(serverId);
    if (!server) {
      return c.json({ error: "Server not found" }, 404);
    }

    const joinRequestIndex = server.joinRequests?.findIndex(
      (req: any) => req.user.toString() === user.id && req.status === "pending"
    );

    if (joinRequestIndex === -1 || joinRequestIndex === undefined) {
      return c.json({ error: "No pending join request found" }, 404);
    }

    const updatedJoinRequests = server?.joinRequests?.filter(
      (req: any) =>
        !(req.user.toString() === user.id && req.status === "pending")
    );

    server.joinRequests = updatedJoinRequests;
    await server.save();

    const notification = await createNotification({
      recipient: server.owner.toString(),
      sender: user.id,
      type: "join_request",
      title: "Join Request Cancelled",
      message: `A user cancelled their join request for ${server.name}`,
      metadata: {
        serverId: server._id,
        serverName: server.name,
        cancelledBy: user.id,
      },
    });

    const io = c.get("io" as any) as Server | undefined;
    if (io) {
      if (notification) {
        sendNotificationViaSocket(io, server.owner.toString(), notification);
      }
      io.to(server.owner.toString()).emit("joinRequestCancelled", {
        serverId,
        userId: user.id,
      });
    }

    return c.json({ message: "Join request cancelled successfully" }, 200);
  } catch (error) {
    console.error("Error cancelling join request:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};
