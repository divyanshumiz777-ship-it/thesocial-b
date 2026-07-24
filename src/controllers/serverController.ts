import { Context } from "hono";
import DiscordServer from "../models/DiscordServer.ts";
import Category from "../models/Category.ts";
import mongoose from "mongoose";
import Channel from "../models/Channel.ts";
import logger from "../lib/logger.ts";
import Message from "../models/Message.ts";
import Thread from "../models/Thread.ts";
import ChannelReadStatus from "../models/ChannelReadStatus.ts";
import Notification from "../models/Notification.ts";
import User from "../models/User.ts";
import VoiceSession from "../models/VoiceSession.ts";
import VoiceSessionTranscript from "../models/VoiceSessionTranscript.ts";
import { forwardDeleteContent, isChatServiceEnabled } from "../lib/chatServiceClient.ts";
import { fireWebhooksForEvent } from "../lib/webhookEvents.ts";
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
  const viewerId = c.get("user")?.id as string | undefined;
  const query = c.req.query("q") || "";
  const limit = Number.parseInt(c.req.query("limit") || "20", 10);
  const skip = Number.parseInt(c.req.query("skip") || "0", 10);
  // "active" (onlineCount desc) powers the /discover directory's Trending
  // tab; "new" (updatedAt desc, the pre-existing behavior) is the default
  // for both the sidebar live-search and Discover's Recent tab.
  const sortBy: Record<string, 1 | -1> =
    c.req.query("sort") === "active" ? { onlineCount: -1 } : { updatedAt: -1 };
  try {
    // Private/invite-only servers, and any server whose owner opted out of
    // search via Privacy Settings, must never surface here — this endpoint
    // used to return every server regardless of visibility, leaking private
    // servers' name/description/owner/member-count to anyone who could guess
    // a search term.
    // An empty query matches every public/searchable server — this is what
    // lets /discover browse the full directory, not just query-driven search.
    const filter = {
      ...(query ? { name: { $regex: query, $options: "i" } } : {}),
      visibility: "public",
      "privacy.showInSearch": { $ne: false },
    };
    const total = await DiscordServer.countDocuments(filter);
    const docs = await DiscordServer.find(filter)
      .sort(sortBy)
      .skip(skip)
      .limit(limit)
      .select(
        "name description imageUrl visibility members channels onlineCount owner createdAt"
      )
      .populate({ path: "owner", select: "name profilePic" })
      .lean();

    // Curated result cards — rich enough to render without an icon-only list,
    // and without leaking the full member roster / ban / mute subdocs.
    const servers = docs.map((s: any) => ({
      _id: s._id,
      name: s.name,
      description: s.description ?? "",
      imageUrl: s.imageUrl ?? "",
      visibility: s.visibility,
      memberCount: Array.isArray(s.members) ? s.members.length : 0,
      channelCount: Array.isArray(s.channels) ? s.channels.length : 0,
      onlineCount: s.onlineCount ?? 0,
      isMember: Array.isArray(s.members)
        ? s.members.some((m: any) => m.user?.toString() === viewerId)
        : false,
      owner: s.owner
        ? {
            _id: s.owner._id,
            name: s.owner.name,
            profilePic: s.owner.profilePic ?? "",
          }
        : null,
      createdAt: s.createdAt,
    }));

    return c.json({ servers, total, limit, skip }, 200);
  } catch (error) {
    console.error("Error in searchServers:", error);
    return c.json({ error: "Search failed" }, 500);
  }
};
export const getAuditLogs = async (c: Context) => {
  const { serverId } = c.req.param();
  const user = c.get("user");
  if (!mongoose.Types.ObjectId.isValid(serverId)) {
    return c.json({ error: "Invalid server ID format" }, 400);
  }
  const server = await DiscordServer.findById(serverId).select("owner").lean();
  if (!server) return c.json({ error: "Server not found" }, 404);
  const isOwner = server.owner.toString() === user.id;
  const isAdmin =
    !isOwner &&
    !!(await ServerMember.exists({
      server: serverId,
      user: user.id,
      roles: { $in: ["owner", "admin", "mod"] },
    }));
  if (!isOwner && !isAdmin) {
    return c.json({ error: "Permission denied" }, 403);
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
  await invalidateAfterServerUpdate(serverId);
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
  let committed = false;

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

    // Sequential, not Promise.all — a single session/transaction only
    // supports one in-flight operation at a time; running these concurrently
    // on the shared `session` intermittently throws "Given transaction
    // number N ... does not match any in-progress transactions" (same class
    // of bug fixed in deleteServer below).
    await Category.findByIdAndUpdate(
      notesCategory._id,
      { $push: { channels: notesChannel._id } },
      { session }
    );
    await Category.findByIdAndUpdate(
      socialCategory._id,
      { $push: { channels: socialChannel._id } },
      { session }
    );
    await Category.findByIdAndUpdate(
      doubtsCategory._id,
      { $push: { channels: doubtsChannel._id } },
      { session }
    );

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

    await session.commitTransaction();
    committed = true;

    // Populate AFTER commit. A read issued inside the transaction inherits the
    // connection's primaryPreferred read preference, which MongoDB rejects
    // ("Read preference in a transaction must be primary"). Outside the
    // transaction the same read is fine.
    let populatedServer;
    try {
      populatedServer = await DiscordServer.findById(newServer._id).populate({
        path: "categories",
        populate: {
          path: "channels",
          model: "Channel",
        },
      });
    } catch {
      // Creation already succeeded; fall back to the unpopulated document.
      populatedServer = newServer;
    }

    return c.json(
      { message: "Server created successfully", server: populatedServer },
      201
    );
  } catch (error) {
    if (!committed) await session.abortTransaction();
    console.error("Error creating server:", error);
    return c.json({ error: "Internal server error" }, 500);
  } finally {
    session.endSession();
  }
};

export const getServerById = async (c: Context) => {
  const { id: serverId } = c.req.param();
  const viewer = c.get("user");

  try {
    if (!mongoose.Types.ObjectId.isValid(serverId)) {
      return c.json({ error: "Invalid server id" }, 400);
    }

    logger.debug({ serverId }, "getServerById: querying server");

    const [server, serverMembersRaw, viewerBlocked, blockedByOthers] =
      await Promise.all([
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
        User.findById(viewer?.id).select("blockedUsers").lean(),
        // Both directions, matching the block-enforcement convention used by
        // searchUsers/getAllUsers: a blocked relationship hides you from each
        // other everywhere, including shared community member lists.
        User.find({ blockedUsers: viewer?.id }, "_id").lean(),
      ]);

    if (!server) {
      logger.warn({ serverId }, "getServerById: server not found");
      return c.json({ message: "Server not found" }, 404);
    }

    const hiddenUserIds = new Set<string>([
      ...(viewerBlocked?.blockedUsers ?? []).map((u) => u.toString()),
      ...blockedByOthers.map((u) => u._id.toString()),
    ]);
    const serverMembers = serverMembersRaw.filter(
      (m: any) => !hiddenUserIds.has(m.user?._id?.toString())
    );

    const cats = (server.categories as unknown) as Array<{ _id: unknown; name?: string; channels: unknown[] }>;
    logger.debug(
      {
        serverId,
        categoriesCount: cats?.length ?? 0,
        categories: cats?.map((cat) => ({
          catId: String(cat._id),
          name: cat.name,
          channelsCount: Array.isArray(cat.channels) ? cat.channels.length : "not-array",
          channelIds: Array.isArray(cat.channels)
            ? cat.channels.map((ch: any) => String(ch._id ?? ch))
            : [],
        })),
        membersCount: serverMembers.length,
      },
      "getServerById: populated server — sending to frontend"
    );

    return c.json({ server: { ...server, members: serverMembers } }, 200);
  } catch (error) {
    logger.error({ serverId, error: String(error) }, "getServerById: internal error");
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
    const privacyShowInSearch = body.get("privacy.showInSearch") as string | null;
    const privacyAllowMemberDMs = body.get("privacy.allowMemberDMs") as string | null;
    const privacyAllowFriendRequests = body.get("privacy.allowFriendRequests") as string | null;

    const updates: Record<string, unknown> = {};

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
    if (privacyShowInSearch !== null && privacyShowInSearch !== "") {
      updates["privacy.showInSearch"] = privacyShowInSearch === "true";
    }
    if (privacyAllowMemberDMs !== null && privacyAllowMemberDMs !== "") {
      updates["privacy.allowMemberDMs"] = privacyAllowMemberDMs === "true";
    }
    if (privacyAllowFriendRequests !== null && privacyAllowFriendRequests !== "") {
      updates["privacy.allowFriendRequests"] = privacyAllowFriendRequests === "true";
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

  // Read BEFORE the transaction starts — a read issued inside it inherits the
  // connection's primaryPreferred read preference, which MongoDB rejects
  // ("Read preference in a transaction must be primary"), the same
  // constraint documented in createServer above. These are just gathering
  // ids to cascade-delete by, so reading them outside the transaction is fine.
  const channelIds = await Channel.find({ server: serverId }).select("_id");
  const channelIdList = channelIds.map((c: any) => c._id);

  const voiceSessionIds = await VoiceSession.find({ server: serverId }).distinct(
    "_id"
  );

  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    // Sequential, not Promise.all — a single MongoDB session/transaction can
    // only have ONE in-flight operation at a time. Firing several
    // deleteMany() calls that share the same `session` concurrently races on
    // the transaction's internal txn-number tracking and fails with
    // "does not match any in-progress transactions" (this used to make
    // deleting a server fail unconditionally, every time).
    await Message.deleteMany({ server: serverId }, { session });
    await Thread.deleteMany({ server: serverId }, { session });
    if (channelIdList.length) {
      await ChannelReadStatus.deleteMany(
        { channel: { $in: channelIdList } },
        { session }
      );
    }
    await Invite.deleteMany({ server: serverId }, { session });
    await AuditLog.deleteMany({ server: serverId }, { session });
    await Notification.deleteMany({ "metadata.serverId": serverId }, { session });
    if (voiceSessionIds.length) {
      await VoiceSessionTranscript.deleteMany(
        { session: { $in: voiceSessionIds } },
        { session }
      );
    }
    await VoiceSession.deleteMany({ server: serverId }, { session });

    await Channel.deleteMany({ server: serverId }, { session });
    await Category.deleteMany({ server: serverId }, { session });

    await User.updateMany(
      { servers: serverId },
      { $pull: { servers: serverId } },
      { session }
    );

    await DiscordServer.findByIdAndDelete(serverId, { session });

    await session.commitTransaction();

    // Fire-and-forget: the transaction above has already committed — a
    // failure here only means this server's entire indexed content (its own
    // summary, channels, messages, voice-session recaps) keeps surfacing
    // through search/the assistant a while longer, never a reason to roll
    // back or delay the actual delete.
    if (isChatServiceEnabled()) {
      void forwardDeleteContent("server", serverId);
    }

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

    const io = c.get("io" as any) as Server | undefined;
    if (io) {
      io.to(serverId.toString()).emit("invites:updated", { serverId });
    }

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

    const io = c.get("io" as any) as Server | undefined;
    if (io) {
      io.to(invite.server.toString()).emit("invites:updated", {
        serverId: invite.server.toString(),
      });
    }

    return c.json({ message: "Invite deleted successfully" }, 200);
  } catch (error) {
    console.error("Error deleting invite:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

// Public, no-auth preview for a share/OG-tag page — app/invite/[code]/page.tsx
// used to immediately PUT accept-invite on mount, so a logged-out visitor
// (or a link-preview crawler) got a silent failure or a spinner with zero
// idea what server they'd be joining. Deliberately separate from
// acceptInvite (which both validates AND mutates by joining) — this only
// ever reads, and only exposes fields already safe to show anyone with the
// link (a DiscordServer's own settings/CreateServerModel.tsx already treats
// name/description/imageUrl/member count as non-sensitive).
export const getInvitePreview = async (c: Context) => {
  const { inviteCode } = c.req.param();
  try {
    const invite = await Invite.findOne({ code: inviteCode }).lean();
    if (!invite) {
      return c.json({ valid: false, reason: "This invite is invalid or has expired." }, 404);
    }
    const server = await DiscordServer.findById(invite.server)
      .select("name description imageUrl members")
      .lean();
    if (!server) {
      return c.json({ valid: false, reason: "This server no longer exists." }, 404);
    }
    return c.json({
      valid: true,
      server: {
        id: server._id,
        name: server.name,
        description: server.description,
        imageUrl: server.imageUrl,
        memberCount: server.members?.length ?? 0,
      },
    });
  } catch (error) {
    console.error("Error fetching invite preview:", error);
    return c.json({ valid: false, reason: "Something went wrong." }, 500);
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

    const newUser = await User.findById(user.id).select("name").lean();
    const io = c.get("io" as any) as Server | undefined;
    if (io) {
      io.to(serverId.toString()).emit("memberJoined", {
        userId: user.id,
        username: (newUser as any)?.name || "New member",
      });
      io.to(serverId.toString()).emit("serverUpdated", {
        serverId: serverId.toString(),
        updateType: "newMember",
        userId: user.id,
      });
    }

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

    // Same visibility/privacy rule as searchServers — a directory listing
    // must not include private servers just because no query was given.
    const filter = { visibility: "public", "privacy.showInSearch": { $ne: false } };
    const totalServers = await DiscordServer.countDocuments(filter);

    const servers = await DiscordServer.find(filter)
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
  const actor = c.get("user");
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
  for (const user of users) {
    if (!mongoose.Types.ObjectId.isValid(user))
      return c.json({ error: "Invalid user ID format" }, 400);
  }

  const server = await DiscordServer.findById(serverId).select("owner").lean();
  if (!server) return c.json({ error: "Server not found" }, 404);
  const isOwner = server.owner.toString() === actor.id;
  const isAdmin =
    !isOwner &&
    !!(await ServerMember.exists({
      server: serverId,
      user: actor.id,
      roles: { $in: ["owner", "admin"] },
    }));
  if (!isOwner && !isAdmin) {
    return c.json({ error: "Permission denied" }, 403);
  }
  // Only the actual server owner may grant/hold the "owner" role — otherwise
  // any admin could hand themselves (or anyone else) ownership through this
  // endpoint. The owner's own role is also fixed here: they always stay
  // "owner" and can't be demoted through this bulk-role editor (use a
  // dedicated ownership-transfer flow for that).
  if (roles.includes("owner") && !isOwner) {
    return c.json(
      { error: "Only the server owner can grant the owner role." },
      403
    );
  }
  if (users.includes(server.owner.toString()) && !roles.includes("owner")) {
    return c.json({ error: "The server owner's role can't be changed." }, 403);
  }

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
    await invalidateAfterServerUpdate(serverId);

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
  const actorId = c.get("user").id;
  const body = await c.req.json();
  const { role, newMemberId } = body;
  if (
    !mongoose.Types.ObjectId.isValid(serverId) ||
    !mongoose.Types.ObjectId.isValid(newMemberId)
  )
    return c.json(
      { error: "Invalid server or member ID format" },
      400
    );
  try {
    const newMemberUser = await User.findById(newMemberId);
    if (!newMemberUser) {
      return c.json({ error: "User to be added does not exist." }, 404);
    }
    const [hasPermission, alreadyMember, server] = await Promise.all([
      checkPermission(serverId, actorId, "add member"),
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
  const actorId = c.get("user").id;
  const { memberToRemoveId } = await c.req.json();

  if (
    !mongoose.Types.ObjectId.isValid(serverId) ||
    !mongoose.Types.ObjectId.isValid(memberToRemoveId)
  ) {
    return c.json({ error: "Invalid server or member ID format" }, 400);
  }

  try {
    const server = await DiscordServer.findById(serverId).select("owner").lean();
    if (!server) return c.json({ error: "Server not found" }, 404);
    if (server.owner.toString() === memberToRemoveId) {
      return c.json({ error: "The server owner can't be removed." }, 403);
    }

    const hasPermission = await checkPermission(serverId, actorId, "remove member");
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
  const actorId = c.get("user").id;
  const { reason, userToBanId } = await c.req.json();
  const io: Server = c.get("io");
  if (
    !mongoose.Types.ObjectId.isValid(serverId) ||
    !mongoose.Types.ObjectId.isValid(userToBanId)
  ) {
    return c.json({ error: "Invalid ID format" }, 400);
  }
  if (!reason) return c.json({ error: "Reason is required" }, 400);
  try {
    const server = await DiscordServer.findById(serverId).select("owner name").lean();
    if (!server) return c.json({ error: "Server not found" }, 404);
    if (server.owner.toString() === userToBanId) {
      return c.json({ error: "The server owner can't be banned." }, 403);
    }

    const [hasPermission, userToBanExists, userAlreadyBanned] = await Promise.all([
      checkPermission(serverId, actorId, "ban member"),
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
            bannedBy: actorId,
          },
        },
      },
      { new: true }
    );
    if (!updatedServer) return c.json({ error: "Server not found" }, 404);

    await ServerMember.updateOne(
      { server: serverId, user: userToBanId },
      { $set: { banned: { isBanned: true, reason, bannedBy: actorId } } }
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
    void fireWebhooksForEvent(serverId.toString(), "member_banned", { userId: userToBanId, reason }, io);
    await invalidateAfterServerUpdate(serverId);

    const banNotification = await createNotification({
      recipient: userToBanId,
      type: "banned",
      title: "You were banned from a server",
      message: `You were banned from "${server.name}". Reason: ${reason}. You can file an appeal if you believe this was a mistake.`,
      actionUrl: `/appeal?serverId=${serverId}&action=ban`,
      metadata: { serverId, serverName: server.name },
    });
    if (banNotification) sendNotificationViaSocket(io, userToBanId, banNotification);

    return c.json({ message: "Member banned successfully" }, 200);
  } catch (error) {
    console.error("Error banning member:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const unBanMember = async (c: Context) => {
  const { serverId } = c.req.param();
  const actorId = c.get("user").id;
  const { userToUnbanId } = await c.req.json();
  if (
    !mongoose.Types.ObjectId.isValid(serverId) ||
    !mongoose.Types.ObjectId.isValid(userToUnbanId)
  )
    return c.json({ error: "Invalid ID format" }, 400);

  try {
    const [hasPermission, userExists, userBanned] = await Promise.all([
      checkPermission(serverId, actorId, "unban member"),
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
    await invalidateAfterServerUpdate(serverId);
    return c.json({ message: "User unbanned successfully" }, 200);
  } catch (error) {
    console.error("Error unbanning member:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const muteMember = async (c: Context) => {
  const { serverId } = c.req.param();
  const actorId = c.get("user").id;
  const { reason, userToMuteId, duration } = await c.req.json();
  const io: Server = c.get("io");

  if (
    !mongoose.Types.ObjectId.isValid(serverId) ||
    !mongoose.Types.ObjectId.isValid(userToMuteId)
  )
    return c.json({ error: "Invalid ID format" }, 400);
  if (!reason) return c.json({ error: "Reason is required" }, 400);
  if (!duration || typeof duration !== "number")
    return c.json({ error: "Duration (in ms) is required" }, 400);

  try {
    const server = await DiscordServer.findById(serverId).select("owner name").lean();
    if (!server) return c.json({ error: "Server not found" }, 404);
    if (server.owner.toString() === userToMuteId) {
      return c.json({ error: "The server owner can't be muted." }, 403);
    }

    const [hasPermission, memberToMute, userAlreadyMuted] = await Promise.all([
      checkPermission(serverId, actorId, "mute member"),
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
            mutedBy: actorId,
            expiresAt: expiresAt,
          },
        },
      },
      { new: true }
    );
    await ServerMember.updateOne(
      { server: serverId, user: userToMuteId },
      { $set: { muted: { isMuted: true, reason, mutedBy: actorId, expiresAt } } }
    );
    await invalidateAfterServerUpdate(serverId);

    io.to(serverId.toString()).emit("memberMuted", {
      userToMuteId,
      serverId,
      expiresAt,
    });
    void fireWebhooksForEvent(serverId.toString(), "member_muted", { userId: userToMuteId, reason, expiresAt }, io);

    const muteNotification = await createNotification({
      recipient: userToMuteId,
      type: "muted",
      title: "You were muted in a server",
      message: `You were muted in "${server.name}". Reason: ${reason}. You can file an appeal if you believe this was a mistake.`,
      actionUrl: `/appeal?serverId=${serverId}&action=mute`,
      metadata: { serverId, serverName: server.name, muteExpiresAt: expiresAt },
    });
    if (muteNotification) sendNotificationViaSocket(io, userToMuteId, muteNotification);

    return c.json({ message: "Member muted successfully" }, 200);
  } catch (error) {
    console.error("Error muting member:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};
export const unmuteMember = async (c: Context) => {
  const { serverId } = c.req.param();
  const actorId = c.get("user").id;
  const { userToUnmuteId } = await c.req.json();
  const io: Server = c.get("io");
  if (
    !mongoose.Types.ObjectId.isValid(serverId) ||
    !mongoose.Types.ObjectId.isValid(userToUnmuteId)
  )
    return c.json({ error: "Invalid ID format" }, 400);

  try {
    const hasPermission = await checkPermission(serverId, actorId, "unmute member");
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
    await invalidateAfterServerUpdate(serverId);
    io.to(serverId.toString()).emit("memberUnmuted", {
      userToUnmuteId,
      serverId,
    });
    return c.json({ message: "Member unmuted successfully" }, 200);
  } catch (error) {
    console.error("Error unmuting member:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

// Self-service join for a "public" visibility server — no invite code, no
// admin approval. This was previously MISSING entirely: requestJoinServer
// (below) has always rejected public servers with "you can join directly,"
// but no such direct-join endpoint existed until the discovery directory
// (frontend/app/discover) needed one to actually let a user join what they
// find there.
export const joinPublicServer = async (
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
    if (server.visibility !== "public") {
      return c.json(
        { error: "This server requires an invite or an approved join request." },
        403
      );
    }

    const existingMember = await ServerMember.findOne({
      server: serverId,
      user: user.id,
    }).lean();
    if (existingMember?.banned?.isBanned) {
      return c.json({ error: "You have been banned from this server." }, 403);
    }
    if (existingMember) {
      return c.json({ error: "You are already a member of this server" }, 400);
    }

    await DiscordServer.findByIdAndUpdate(serverId, {
      $push: { members: { user: user.id, roles: ["member"] } },
    });
    await ServerMember.findOneAndUpdate(
      { server: serverId, user: user.id },
      { $set: { roles: ["member"] } },
      { upsert: true },
    );
    await User.findByIdAndUpdate(user.id, { $addToSet: { servers: serverId } });

    await invalidateAfterServerUpdate(serverId);

    const io = c.get("io" as any) as Server | undefined;
    if (io) {
      void fireWebhooksForEvent(serverId.toString(), "member_joined", {
        userId: user.id,
        name: user.email,
      }, io);
      io.to(serverId.toString()).emit("serverUpdated", {
        serverId,
        updateType: "newMember",
        userId: user.id,
      });
      io.to(serverId.toString()).emit("memberJoined", { userId: user.id });
    }

    if (server.owner.toString() !== user.id) {
      const notification = await createNotification({
        recipient: server.owner.toString(),
        sender: user.id,
        type: "member_joined",
        title: "New Member Joined",
        message: `Someone joined ${server.name}`,
        metadata: { serverId: server._id, serverName: server.name, newMemberId: user.id },
        actionUrl: `/community/${server._id}`,
      });
      if (io && notification) sendNotificationViaSocket(io, server.owner.toString(), notification);
    }

    return c.json({ message: "Joined server successfully", serverId }, 200);
  } catch (error) {
    console.error("Error joining public server:", error);
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
            "This is a public server. Use the direct-join endpoint instead of requesting.",
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
    if (io) {
      if (notification) {
        sendNotificationViaSocket(io, server.owner.toString(), notification);
      }
      io.to(server.owner.toString()).emit("joinRequest", {
        serverId,
        userId: user.id,
        userName: requestUser?.name,
      });
      // Room-wide (not just the owner) so every currently-connected admin with
      // the Join Requests panel open — not only the owner — sees the new
      // pending request without a manual reopen.
      io.to(serverId.toString()).emit("joinRequests:updated", { serverId });
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

    // Without this, the approved user's OWN per-viewer cached snapshot of
    // getServerById (see cacheMiddleware.ts) keeps being served back to
    // them — membership is written correctly above, but their client (even
    // on a full page reload, which hits this same cached response) looks
    // like the request was never approved for up to the cache's TTL.
    await invalidateAfterServerUpdate(serverId);

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

      void fireWebhooksForEvent(serverId.toString(), "member_joined", {
        userId: requestUserId,
        name: requestUser?.name,
      }, io);

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
      io.to(serverId.toString()).emit("joinRequests:updated", { serverId });
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
    // getJoinRequests (an admin/owner-facing GET) is also cached per-viewer —
    // without this, the admin who just rejected still sees it pending.
    await invalidateAfterServerUpdate(serverId);

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
      io.to(serverId.toString()).emit("joinRequests:updated", { serverId });
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
    await invalidateAfterServerUpdate(serverId);

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
      io.to(serverId.toString()).emit("joinRequests:updated", { serverId });
    }

    return c.json({ message: "Join request cancelled successfully" }, 200);
  } catch (error) {
    console.error("Error cancelling join request:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};
