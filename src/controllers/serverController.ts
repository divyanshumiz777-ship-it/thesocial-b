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

export const createServer = async (c: Context) => {
  const body = await c.req.json();
  const { serverName, user } = body;

  if (!serverName || !user?._id) {
    return c.json({ error: "Server name and user ID are required" }, 400);
  }

  try {
    const newServer = new DiscordServer({
      name: serverName,
      owner: user._id,
      categories: [],
      channels: [],
      members: [user._id],
    });
    await newServer.save();

    const textCategoryDoc = await Category.create({
      name: "Text Channels",
      server: newServer._id,
    });
    const textCategoryId = new mongoose.Types.ObjectId(textCategoryDoc._id);

    const voiceCategoryDoc = await Category.create({
      name: "Voice Channels",
      server: newServer._id,
    });
    const voiceCategoryId = new mongoose.Types.ObjectId(voiceCategoryDoc._id);

    const generalTextChannel = await Channel.create({
      name: "general",
      type: "Text",
      category: textCategoryId,
      server: newServer._id,
    });

    const generalVoiceChannel = await Channel.create({
      name: "General",
      type: "Voice",
      category: voiceCategoryId,
      server: newServer._id,
    });

    newServer.categories = [textCategoryId, voiceCategoryId];
    newServer.channels = [generalTextChannel._id, generalVoiceChannel._id];
    await newServer.save();

    return c.json(
      { message: "Server created successfully", server: newServer },
      201
    );
  } catch (error) {
    console.error("Error creating server:", error);
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
export const getServer = async (c: Context) => {
  const { id } = c.req.param();
  try {
    const server = await DiscordServer.findById(id)
      .populate("members", "username avatar")
      .populate({
        path: "categories",
        populate: {
          path: "channels",
          model: "Channel",
        },
      });

    if (!server) return c.json({ message: "No such server exists" }, 404);
    return c.json({ server: server }, 200);
  } catch (error) {
    console.error("Error fetching server: ", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const editServer = async (c: Context) => {
  const { id } = c.req.param();
  const body = await c.req.json();
  const {
    name,
    category,
    channel,
    categoryType,
    channelCategoryId,
    user,
    profilePicFile,
  } = body;

  try {
    const hasPermission = await DiscordServer.findOne({
      _id: id,
      members: {
        $elemMatch: { user: user._id, roles: "edit server" },
      },
    });
    if (!hasPermission) {
      return c.json({ error: "Permission denied or server not found." }, 403);
    }

    if (name) {
      await DiscordServer.findByIdAndUpdate(id, { $set: { name } });
    }

    if (category) {
      const newCategory = await Category.create({ name, server: id });
      await DiscordServer.findByIdAndUpdate(id, {
        $push: { categories: newCategory._id },
      });
    }

    if (channel) {
      let assignedCategoryId = channelCategoryId;
      if (!assignedCategoryId) {
        const uncategorized = await Category.findOneAndUpdate(
          {
            name: "Uncategorized",
            server: id,
          },
          {
            $setOnInsert: { name: "Uncategorized", server: id },
          },
          {
            upsert: true,
            new: true,
          }
        );
      }
      const newChannel = await Channel.create({
        name: channel,
        type: categoryType,
        category: assignedCategoryId,
        server: id,
      });
      await DiscordServer.findByIdAndUpdate(id, {
        $push: { channels: newChannel._id },
      });
      await Category.findByIdAndUpdate(assignedCategoryId, {
        $push: { channels: newChannel._id },
      });
    }

    const updatedServer = await DiscordServer.findById(id);
    if (!updatedServer) return c.json({ error: "Server not found" }, 404);

    if (profilePicFile && profilePicFile.size > 0) {
      try {
        const arrayBuffer = await profilePicFile.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        const cloudinaryResponse = await uploadOnCloudinary(buffer, {
          folder: "profile_pics",
          resource_type: "image",
        });

        if (cloudinaryResponse) {
          updatedServer.profilePic = cloudinaryResponse.secure_url;
        }
      } catch (error) {
        console.error("Error uploading profile picture to Cloudinary:", error);
        return c.json({ error: "Failed to upload profile picture" }, 500);
      }
    }

    return c.json(
      { message: "Server updated successfully", server: updatedServer },
      200
    );
  } catch (error) {
    console.error("Error updating server: ", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};
export const deleteServer = async (c: Context) => {
  const { id } = c.req.param();
  const { user } = await c.req.json();
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return c.json({ error: "Invalid server ID format" }, 400);
  }
  try {
    const session = await mongoose.startSession();
    session.startTransaction();
    const hasPermission = await DiscordServer.findOne({
      _id: id,
      members: {
        $elemMatch: { user: user._id, roles: "delete server" },
      },
    });
    if (!hasPermission) {
      return c.json({ error: "Permission denied or server not found." }, 403);
    }

    const deletedServer = await DiscordServer.findByIdAndDelete(id, {
      session,
    });

    if (!deletedServer) return c.json({ error: "Server not found" }, 404);

    await Category.deleteMany({ server: id }, { session });
    await Channel.deleteMany({ server: id }, { session });

    await session.commitTransaction();
    session.endSession();

    return c.json({ message: "Server deleted successfully" }, 200);
  } catch (error) {
    console.error("Error deleting server: ", error);
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

export const createInvite = async (c: Context) => {
  const { serverId, user } = await c.req.json();
  const code = nanoid(10);
  if (!mongoose.Types.ObjectId.isValid(serverId)) {
    return c.json({ error: "Invalid server ID format" }, 400);
  }
  try {
    const hasPermission = await DiscordServer.findOne({
      _id: serverId,
      members: {
        $elemMatch: { user: user._id, roles: "create invite" },
      },
    });
    if (!hasPermission) {
      return c.json({ error: "Permission denied or server not found." }, 403);
    }
    const newInvite = await Invite.create({
      code,
      server: serverId,
      createdBy: user._id,
    });

    return c.json({
      inviteLink: `http://localhost:3000/invite/${code}`,
      newInvite,
    });
  } catch (error) {
    console.error("Error creating invite:", error);
    return c.json({ error: "Internal server error" });
  }
};
export const acceptInvite = async (c: Context) => {
  const { inviteCode } = c.req.param();
  const { user } = await c.req.json();

  try {
    const invite = await Invite.findOne({ code: inviteCode });

    if (!invite) {
      return c.json({ error: "Invalid invite code." }, 404);
    }
    if (invite.expiresAt && invite.expiresAt < new Date()) {
      return c.json({ error: "This invite has expired." }, 400);
    }

    const updatedServer = await DiscordServer.findByIdAndUpdate(
      invite.server,
      { $addToSet: { members: { user: user._id } } },
      { new: true }
    );

    await User.findByIdAndUpdate(user._id, {
      $addToSet: { servers: invite.server },
    });

    return c.json({
      message: "Joined server successfully!",
      server: updatedServer,
    });
  } catch (error) {
    console.error("Error in accepting invitation: ", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};
