import { Context } from "hono";
import DiscordServer from "../models/DiscordServer.ts";
import Category from "../models/Category.ts";
import mongoose from "mongoose";
import Channel from "../models/Channel.ts";
import User from "../models/User.ts";
import { Server } from "socket.io";
import { uploadOnCloudinary } from "../lib/cloudinary.ts";
import { nanoid } from "nanoid";
import Invite from "../models/Invite.ts";
import { checkPermission } from "../lib/permissionHelper.ts";
import { Buffer } from "node:buffer";

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
      serverType,
      members: [{ user: user.id, roles: ["owner"] }],
    });
    await newServer.save({ session });

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

export const searchServers = async (c: Context) => {
  const searchTerm = c.req.query("q");

  if (!searchTerm || searchTerm.trim() === "") {
    return c.json({ servers: [] }, 200);
  }

  try {
    const searchWords = searchTerm.trim().split(/\s+/);
    const regexConditions = searchWords.map((word) => ({
      name: new RegExp(word, "i"),
    }));
    const servers = await DiscordServer.find({ $and: regexConditions })
      .limit(20)
      .populate({ path: "owner", select: "name profilePic" });

    return c.json({ servers }, 200);
  } catch (error) {
    console.error("Error searching servers:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const getServerById = async (c: Context) => {
  const { id: serverId } = c.req.param();

  try {
    const server = await DiscordServer.findById(serverId)
      .populate({
        path: "owner",
        select: "name profilePic",
      })
      .populate({
        path: "members.user",
        select: "name profilePic",
      })
      .populate({
        path: "categories",
        populate: {
          path: "channels",
          model: "Channel",
        },
      });

    if (!server) {
      return c.json({ message: "Server not found" }, 404);
    }

    // This permission check can now be simplified
    // const isMember = server.members.some(
    //   (member: any) => member.user._id.toString() === user.id
    // );

    // if (!isMember && server.owner._id.toString() !== user.id) {
    //   return c.json({ error: "Access denied" }, 403);
    // }

    return c.json({ server }, 200);
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

  if (!(await checkPermission(serverId, user.id, "edit server"))) {
    return c.json({ error: "Permission denied" }, 403);
  }

  try {
    const body = await c.req.formData();
    const newName = body.get("name") as string;
    const imageFile = body.get("imageFile") as File;
    const updates: { name?: string; imageUrl?: string } = {};

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

    if (Object.keys(updates).length === 0) {
      return c.json({ error: "No update data provided" }, 400);
    }

    const updatedServer = await DiscordServer.findByIdAndUpdate(
      serverId,
      { $set: updates },
      { new: true }
    );

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

    await Channel.deleteMany({ server: serverId }, { session });
    await Category.deleteMany({ server: serverId }, { session });
    await Invite.deleteMany({ server: serverId }, { session });
    await User.updateMany(
      { servers: serverId },
      { $pull: { servers: serverId } },
      { session }
    );
    await DiscordServer.findByIdAndDelete(serverId, { session });

    await session.commitTransaction();
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
    const newInvite = await Invite.create({
      code,
      server: serverId,
      createdBy: user.id,
    });
    const inviteLink = `${
      process.env.FRONTEND_URL || "http://localhost:3000"
    }/invite/${code}`;

    return c.json({ inviteLink, invite: newInvite }, 201);
  } catch (error) {
    console.error("Error creating invite:", error);
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
    const isAlreadyMember = await DiscordServer.findOne({
      _id: serverId,
      "members.user": user.id,
    });
    if (isAlreadyMember) {
      return c.json({
        message: "You are already a member of this server",
        server: isAlreadyMember,
      });
    }

    const updatedServer = await DiscordServer.findByIdAndUpdate(
      serverId,
      { $addToSet: { members: { user: user.id, roles: ["member"] } } }, // Assign a default role
      { new: true }
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

    if (result.modifiedCount === 0) {
      return c.json(
        {
          message:
            "No roles were updated. Check if server and user IDs are correct.",
        },
        404
      );
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
    const server = await DiscordServer.findOne({
      _id: serverId,
      "members.user": { $ne: newMemberId },
      members: {
        $elemMatch: { user: userId, roles: "add member" },
      },
    });
    if (!server) {
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

    await User.findByIdAndUpdate(newMemberId, {
      $addToSet: { servers: serverId },
    });

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
    const updatedServer = await DiscordServer.findOneAndUpdate(
      {
        _id: serverId,
        members: {
          $elemMatch: { user: userId, roles: "remove member" },
        },
      },
      {
        $pull: { members: { user: memberToRemoveId } },
      },
      { new: true }
    );

    if (!updatedServer) {
      return c.json(
        {
          error:
            "Action failed: Server not found, member not found, or you lack permission.",
        },
        403
      );
    }

    await User.findByIdAndUpdate(memberToRemoveId, {
      $pull: { servers: serverId },
    });

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
    const hasPermission = await DiscordServer.findOne({
      _id: serverId,
      members: {
        $elemMatch: { user: userId, roles: { $in: ["ban member"] } },
      },
    });
    if (!hasPermission)
      return c.json(
        { error: "You do not have permission to ban members." },
        403
      );

    const userToBanExists = await User.findById(userToBanId);
    if (!userToBanExists) return c.json({ error: "User does not exist" }, 404);

    const userAlreadyBanned = await DiscordServer.findOne({
      _id: serverId,
      members: {
        $elemMatch: { user: userToBanId, "banned.isBanned": true },
      },
    });
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
    const hasPermission = await DiscordServer.findOne({
      _id: serverId,
      members: { $elemMatch: { user: userId, roles: "unban member" } },
    });
    if (!hasPermission)
      return c.json(
        { error: "You do not have permission to unban members." },
        403
      );
    const userExists = await User.findById(userToUnbanId);
    if (!userExists) return c.json({ error: "User does not exist" }, 404);
    const userBanned = await DiscordServer.findOne({
      _id: serverId,
      members: {
        $elemMatch: { user: userToUnbanId, "banned.isBanned": true },
      },
    });

    if (!userBanned) return c.json({ error: "User is not banned" }, 400);
    await DiscordServer.findOneAndUpdate(
      {
        _id: serverId,
        "members.user": userToUnbanId,
      },
      { $unset: { "members.$.banned": "" } }
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
    const hasPermission = await DiscordServer.findOne({
      _id: serverId,
      members: { $elemMatch: { user: userId, roles: "mute member" } },
    });
    if (!hasPermission) {
      return c.json(
        { error: "You do not have permission to mute members." },
        403
      );
    }

    const memberToMute = await DiscordServer.findOne({
      _id: serverId,
      "members.user": userToMuteId,
    });
    if (!memberToMute) {
      return c.json({ error: "User is not a member of this server." }, 404);
    }

    const userAlreadyMuted = await DiscordServer.findOne({
      _id: serverId,
      "members.user": userToMuteId,
      "members.muted.isMuted": true,
    });
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
    const updatedServer = await DiscordServer.findOneAndUpdate(
      {
        _id: serverId,
        members: { $elemMatch: { user: userId, roles: "unmute member" } },
      },
      {
        $unset: {
          "members.[elem].muted": "",
        },
      },
      {
        arrayFilters: [{ "elem.user": userToUnmuteId }],
        new: true,
      }
    );
    if (!updatedServer)
      return c.json(
        { error: "Action failed. Check if the user exists and is muted." },
        403
      );

    return c.json({ message: "Member unmuted successfully" }, 200);
  } catch (error) {
    console.error("Error unmuting member:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};
