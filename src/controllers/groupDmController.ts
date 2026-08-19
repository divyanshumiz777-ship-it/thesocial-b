import { Context, Hono } from "hono";
import { getIoInstance } from "../config/socket.ts";
import Group from "../models/Group.ts";
import Conversation from "../models/Conversation.ts";
import Message from "../models/Message.ts";
import User from "../models/User.ts";
import { verify } from "hono/jwt";
import mongoose from "mongoose";
import { uploadOnCloudinary } from "../lib/cloudinary.ts";
import { getCloudinaryResourceType } from "../lib/fileUpload.ts";
import CacheInvalidator from "../lib/cacheInvalidation.ts";
import { forwardDeleteContent, isChatServiceEnabled } from "../lib/chatServiceClient.ts";
import { createNotification, sendNotificationViaSocket } from "./notificationController.ts";
import { getActiveGroupCall } from "../lib/groupCallService.ts";

const groupDmController = new Hono();

/** Hard cap on group size — a cheap guard against runaway/abusive add-member calls. */
const MAX_GROUP_PARTICIPANTS = 100;

// See deleteGroupMessage — only gates a sender deleting their own message.
const DELETE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Normalize any of: a plain id string, a Mongoose ObjectId, or a populated
 * user object ({ _id, ... }) → its hex id string. Used both to compare
 * identities and to address a user's personal socket room.
 */
function idString(value: any): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (value._id) return value._id.toString();
  return typeof value.toString === "function" ? value.toString() : null;
}

/**
 * Emit a group event to each given user's PERSONAL room (room name === userId,
 * auto-joined and JWT-verified in server.ts). Personal-room delivery is what
 * reaches members who don't currently have the group open — a sidebar in
 * another tab, and crucially a just-removed member who is no longer in the
 * group room at all. Every frontend handler for these events is written to be
 * idempotent, so a member who is BOTH in the group room and their personal
 * room receiving the same event twice is harmless. We deliberately target
 * personal rooms rather than io.to(groupId) so the "you were kicked / the
 * group was deleted / you were added" cases actually reach the affected user.
 */
function notifyUsers(userIds: any[], event: string, payload: any): void {
  const io = getIoInstance();
  const seen = new Set<string>();
  for (const raw of userIds) {
    const id = idString(raw);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    io.to(id).emit(event, payload);
  }
}

/**
 * Permanent record of a membership change, rendered as a pill in the group
 * thread (same convention as a DM call-log entry — see Message.callInfo).
 * Reuses the exact same Message + "groupMessage" emit shape a normal group
 * message uses, so the group chat's existing live-update path renders it
 * with zero extra wiring — only the render branch needs to check systemInfo.
 */
async function createGroupSystemMessage(
  groupId: string,
  type: "member_added" | "member_removed" | "member_left",
  actorId: string,
  targets: { id: string; name: string }[]
): Promise<void> {
  const actor = await User.findById(actorId).select("name");
  const actorName = actor?.name || "Someone";
  const targetNames = targets.map((t) => t.name).join(", ");
  const content =
    type === "member_added"
      ? `${actorName} added ${targetNames}`
      : type === "member_removed"
        ? `${actorName} removed ${targetNames}`
        : `${actorName} left the group`;

  const message = new Message({
    sender: new mongoose.Types.ObjectId(actorId),
    content,
    groupId: new mongoose.Types.ObjectId(groupId),
    systemInfo: {
      type,
      actor: new mongoose.Types.ObjectId(actorId),
      targets: targets.map((t) => new mongoose.Types.ObjectId(t.id)),
    },
  });
  await message.save();
  await message.populate("sender", "name email profilePic");

  getIoInstance()
    .to(groupId)
    .emit("groupMessage", { groupId, message: message.toObject() });
}

/** Map a file's MIME type to the attachmentsV2 `type` discriminator the UI
 * uses (RichMessageDisplay renders images/videos/audio inline, everything
 * else as a document chip). */
function inferAttachmentType(
  mimeType: string
): "image" | "video" | "gif" | "audio" | "document" {
  if (!mimeType) return "document";
  if (mimeType === "image/gif") return "gif";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "document";
}

async function verifyJWT(token: string): Promise<any> {
  try {
    const secret = process.env.JWT_SECRET as string;
    const decoded = await verify(token, secret, "HS256");
    return decoded;
  } catch (error) {
    console.error("JWT verification error:", error);
    return null;
  }
}

function getUserIdFromJWT(decoded: any): string | null {
  return decoded?.userId || decoded?.id || null;
}

async function isUserAuthorized(
  groupId: string,
  userId: string
): Promise<{ isOwner: boolean; isAdmin: boolean; group: any }> {
  const group = await Group.findById(groupId);
  if (!group) {
    return { isOwner: false, isAdmin: false, group: null };
  }

  const isOwner = group.owner?.toString() === userId;
  const isAdmin = group.admins?.some((id: any) => id.toString() === userId);

  return { isOwner, isAdmin, group };
}

export const createGroup = async (c: Context) => {
  try {
    const token = c.req.header("Authorization")?.replace("Bearer ", "");
    if (!token) return c.json({ error: "Unauthorized" }, 401);

    const decoded = await verifyJWT(token);
    if (!decoded) return c.json({ error: "Invalid token" }, 401);

    const body = await c.req.parseBody();
    const name = body.name as string;
    const memberIds = JSON.parse(
      (body.members || body.memberIds || "[]") as string
    );
    const iconFile = body.icon as File | undefined;

    if (!name || !Array.isArray(memberIds) || memberIds.length < 2) {
      return c.json({ error: "Need at least 2 members and a group name" }, 400);
    }

    const userId = decoded.id || decoded.userId;
    const allMembers = [...new Set([userId, ...memberIds])];

    if (allMembers.length < 2) {
      return c.json({ error: "Need at least 2 members" }, 400);
    }

    let iconUrl: string | undefined = undefined;

    if (iconFile && iconFile instanceof File) {
      try {
        const arrayBuffer = await iconFile.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        const uploadResult = await uploadOnCloudinary(buffer, {
          folder: "group-icons",
          resource_type: "image",
        });

        if (uploadResult?.secure_url) {
          iconUrl = uploadResult.secure_url;
        }
      } catch (error) {
        console.error("Error uploading group icon:", error);
      }
    }

    const group = new Group({
      name: name.trim(),
      icon: iconUrl,
      owner: new mongoose.Types.ObjectId(userId as string),
      admins: [new mongoose.Types.ObjectId(userId as string)],
      participants: allMembers.map((id) => new mongoose.Types.ObjectId(id)),
      messages: [],
      isGroupDM: true,
      isDisabled: false,
    });

    await group.save();
    await group.populate("participants", "name email profilePic status");

    const io = getIoInstance();
    for (const memberId of allMembers) {
      io.to(memberId.toString()).emit("group-dm:created", {
        groupId: group._id,
        name: group.name,
        icon: group.icon,
        members: allMembers,
        owner: userId,
      });
    }

    return c.json(
      {
        success: true,
        group: group.toObject(),
        _id: group._id,
        groupId: group._id,
      },
      201
    );
  } catch (error) {
    console.error("Error creating group DM:", error);
    return c.json({ error: "Failed to create group DM" }, 500);
  }
};

export const addMembers = async (c: Context) => {
  try {
    const token = c.req.header("Authorization")?.replace("Bearer ", "");
    if (!token) return c.json({ error: "Unauthorized" }, 401);

    const decoded = await verifyJWT(token);
    if (!decoded) return c.json({ error: "Invalid token" }, 401);

    const { groupId } = c.req.param();
    const { memberIds } = await c.req.json();

    if (!Array.isArray(memberIds) || memberIds.length === 0) {
      return c.json({ error: "No members provided" }, 400);
    }

    const userId = getUserIdFromJWT(decoded);
    if (!userId) {
      return c.json({ error: "Invalid token payload" }, 401);
    }

    const { isOwner, isAdmin, group } = await isUserAuthorized(groupId, userId);

    if (!group) {
      return c.json({ error: "Group not found" }, 404);
    }

    if (!isOwner && !isAdmin) {
      return c.json({ error: "Only owner and admins can add members" }, 403);
    }

    if (group.isDisabled) {
      return c.json({ error: "This group is disabled" }, 403);
    }

    const newMembers = memberIds.filter(
      (id: string) => !group.participants.some((p: any) => p.toString() === id)
    );

    if (newMembers.length === 0) {
      return c.json({ error: "Those users are already in the group" }, 400);
    }

    if (group.participants.length + newMembers.length > MAX_GROUP_PARTICIPANTS) {
      return c.json(
        { error: `Groups can have at most ${MAX_GROUP_PARTICIPANTS} members` },
        400
      );
    }

    group.participants.push(
      ...newMembers.map((id: string) => new mongoose.Types.ObjectId(id))
    );
    await group.save();

    await group.populate("participants", "name email profilePic");

    // Notify every current participant (existing members' lists update; the
    // newly-added members — who were NOT in the group room — get the group
    // pushed into their sidebar via their personal room).
    notifyUsers(group.participants, "group-dm:members-added", {
      groupId,
      newMembers,
      allMembers: group.participants,
    });

    try {
      const addedUsers = group.participants.filter((p: any) =>
        newMembers.includes(p._id.toString())
      );
      await createGroupSystemMessage(
        groupId,
        "member_added",
        userId,
        addedUsers.map((u: any) => ({ id: u._id.toString(), name: u.name }))
      );

      // The system-message pill above only shows once the new member
      // actually opens the group — this is what tells them right away, the
      // same way a server's join-request/invite events already notify.
      const actor = await User.findById(userId).select("name");
      const io = getIoInstance();
      for (const addedUser of addedUsers) {
        const notification = await createNotification({
          recipient: addedUser._id.toString(),
          sender: userId,
          type: "member_joined",
          title: "Added to a group",
          message: `${actor?.name || "Someone"} added you to "${group.name || "a group"}"`,
          actionUrl: `/community/me?group=${groupId}`,
          metadata: { groupId },
        });
        if (notification) sendNotificationViaSocket(io, addedUser._id.toString(), notification);
      }
    } catch (err) {
      console.error("Failed to create group system message/notification:", err);
    }

    return c.json({ success: true, group });
  } catch (error) {
    console.error("Error adding members:", error);
    return c.json({ error: "Failed to add members" }, 500);
  }
};

export const removeMember = async (c: Context) => {
  try {
    const token = c.req.header("Authorization")?.replace("Bearer ", "");
    if (!token) return c.json({ error: "Unauthorized" }, 401);

    const decoded = await verifyJWT(token);
    if (!decoded) return c.json({ error: "Invalid token" }, 401);

    const { groupId, memberId } = c.req.param();

    const userId = getUserIdFromJWT(decoded);
    if (!userId) {
      return c.json({ error: "Invalid token payload" }, 401);
    }

    const { isOwner, isAdmin, group } = await isUserAuthorized(groupId, userId);

    if (!group) {
      return c.json({ error: "Group not found" }, 404);
    }

    if (!isOwner && !isAdmin) {
      return c.json({ error: "Only owner and admins can remove members" }, 403);
    }

    if (group.isDisabled) {
      return c.json({ error: "This group is disabled" }, 403);
    }

    if (memberId === userId) {
      return c.json(
        { error: "Use “Leave group” to remove yourself" },
        400
      );
    }

    if (memberId === group.owner?.toString()) {
      return c.json({ error: "The group owner can't be removed" }, 400);
    }

    const targetIsAdmin = group.admins?.some(
      (a: any) => a.toString() === memberId
    );
    // An admin can remove regular members, but only the owner can remove
    // another admin. (Owner removal is already blocked above.)
    if (targetIsAdmin && !isOwner) {
      return c.json({ error: "Only the owner can remove an admin" }, 403);
    }

    const wasMember = group.participants.some(
      (p: any) => p.toString() === memberId
    );
    if (!wasMember) {
      return c.json({ error: "That person isn't in this group" }, 404);
    }

    group.participants = group.participants.filter(
      (p: any) => p.toString() !== memberId
    );

    if (group.admins) {
      group.admins = group.admins.filter((a: any) => a.toString() !== memberId);
    }

    await group.save();
    await group.populate("participants", "name email profilePic");

    // Remaining members' lists update; the removed member (no longer in the
    // group room) is told via their personal room so their own UI reacts.
    notifyUsers(
      [...group.participants, memberId],
      "group-dm:member-removed",
      {
        groupId,
        removedMemberId: memberId,
        remainingMembers: group.participants,
      }
    );

    try {
      // The removed user is no longer in group.participants by this point
      // (filtered out above, before the populate() call) — fetched
      // separately since there's nowhere left to read their name from.
      const removedUser = await User.findById(memberId).select("name");
      await createGroupSystemMessage(groupId, "member_removed", userId, [
        { id: memberId, name: removedUser?.name || "A member" },
      ]);
    } catch (err) {
      console.error("Failed to create group system message:", err);
    }

    return c.json({ success: true, group });
  } catch (error) {
    console.error("Error removing member:", error);
    return c.json({ error: "Failed to remove member" }, 500);
  }
};

export const makeAdmin = async (c: Context) => {
  try {
    const token = c.req.header("Authorization")?.replace("Bearer ", "");
    if (!token) return c.json({ error: "Unauthorized" }, 401);

    const decoded = await verifyJWT(token);
    if (!decoded) return c.json({ error: "Invalid token" }, 401);

    const { groupId, memberId } = c.req.param();

    const userId = getUserIdFromJWT(decoded);
    if (!userId) {
      return c.json({ error: "Invalid token payload" }, 401);
    }

    const { isOwner, group } = await isUserAuthorized(groupId, userId);

    if (!group) {
      return c.json({ error: "Group not found" }, 404);
    }

    if (!isOwner) {
      return c.json({ error: "Only owner can make admins" }, 403);
    }

    if (group.isDisabled) {
      return c.json({ error: "This group is disabled" }, 403);
    }

    const memberExists = group.participants.some(
      (p: any) => p.toString() === memberId
    );
    if (!memberExists) {
      return c.json({ error: "Member not found in group" }, 404);
    }

    if (group.admins?.some((a: any) => a.toString() === memberId)) {
      return c.json({ error: "Member is already an admin" }, 400);
    }

    group.admins.push(new mongoose.Types.ObjectId(memberId));
    await group.save();

    notifyUsers(group.participants, "group-dm:member-promoted", {
      groupId,
      memberId,
      promotedBy: userId,
    });

    return c.json({ success: true, group });
  } catch (error) {
    console.error("Error making admin:", error);
    return c.json({ error: "Failed to make admin" }, 500);
  }
};

export const removeAdmin = async (c: Context) => {
  try {
    const token = c.req.header("Authorization")?.replace("Bearer ", "");
    if (!token) return c.json({ error: "Unauthorized" }, 401);

    const decoded = await verifyJWT(token);
    if (!decoded) return c.json({ error: "Invalid token" }, 401);

    const { groupId, memberId } = c.req.param();

    const userId = getUserIdFromJWT(decoded);
    if (!userId) {
      return c.json({ error: "Invalid token payload" }, 401);
    }

    const { isOwner, group } = await isUserAuthorized(groupId, userId);

    if (!group) {
      return c.json({ error: "Group not found" }, 404);
    }

    if (!isOwner) {
      return c.json({ error: "Only owner can remove admin role" }, 403);
    }

    if (group.isDisabled) {
      return c.json({ error: "This group is disabled" }, 403);
    }

    // The owner is always effectively an admin — don't let them be demoted
    // out of the admins list (keeps role state coherent).
    if (memberId === group.owner?.toString()) {
      return c.json({ error: "The group owner can't be demoted" }, 400);
    }

    if (group.admins) {
      group.admins = group.admins.filter((a: any) => a.toString() !== memberId);
      await group.save();
    }

    notifyUsers(group.participants, "group-dm:member-demoted", {
      groupId,
      memberId,
      demotedBy: userId,
    });

    return c.json({ success: true, group });
  } catch (error) {
    console.error("Error removing admin:", error);
    return c.json({ error: "Failed to remove admin" }, 500);
  }
};

export const leaveGroup = async (c: Context) => {
  try {
    const token = c.req.header("Authorization")?.replace("Bearer ", "");
    if (!token) return c.json({ error: "Unauthorized" }, 401);

    const decoded = await verifyJWT(token);
    if (!decoded) return c.json({ error: "Invalid token" }, 401);

    const { groupId } = c.req.param();

    const userId = getUserIdFromJWT(decoded);
    if (!userId) {
      return c.json({ error: "Invalid token payload" }, 401);
    }

    const group = await Group.findById(groupId);
    if (!group) return c.json({ error: "Group not found" }, 404);

    if (group.owner?.toString() === userId) {
      return c.json(
        {
          error:
            "As the owner you can't leave — delete the group instead.",
        },
        400
      );
    }

    const wasMember = group.participants.some(
      (p: any) => p.toString() === userId
    );
    if (!wasMember) {
      return c.json({ error: "You're not a member of this group" }, 400);
    }

    group.participants = group.participants.filter(
      (p: any) => p.toString() !== userId
    );

    if (group.admins) {
      group.admins = group.admins.filter((a: any) => a.toString() !== userId);
    }

    await group.save();

    // Remaining members' lists update; the leaver's own sidebar drops the
    // group via their personal room (they've left the group room).
    notifyUsers([...group.participants, userId], "group-dm:member-left", {
      groupId,
      userId,
      remainingCount: group.participants.length,
    });

    try {
      const leftUser = await User.findById(userId).select("name");
      await createGroupSystemMessage(groupId, "member_left", userId, [
        { id: userId, name: leftUser?.name || "A member" },
      ]);
    } catch (err) {
      console.error("Failed to create group system message:", err);
    }

    return c.json({ success: true });
  } catch (error) {
    console.error("Error leaving group:", error);
    return c.json({ error: "Failed to leave group" }, 500);
  }
};

export const updateGroup = async (c: Context) => {
  try {
    const token = c.req.header("Authorization")?.replace("Bearer ", "");
    if (!token) return c.json({ error: "Unauthorized" }, 401);

    const decoded = await verifyJWT(token);
    if (!decoded) return c.json({ error: "Invalid token" }, 401);

    const { groupId } = c.req.param();
    const { name, description, icon, isDisabled } = await c.req.json();

    const userId = getUserIdFromJWT(decoded);
    if (!userId) {
      return c.json({ error: "Invalid token payload" }, 401);
    }

    const { isOwner, isAdmin, group } = await isUserAuthorized(groupId, userId);

    if (!group) {
      return c.json({ error: "Group not found" }, 404);
    }

    if (!isOwner && !isAdmin) {
      return c.json({ error: "Only owner and admins can update group" }, 403);
    }

    if (isDisabled !== undefined && !isOwner) {
      return c.json({ error: "Only owner can disable/enable group" }, 403);
    }

    if (name !== undefined) {
      const trimmed = name.trim();
      if (!trimmed) {
        return c.json({ error: "Group name can't be empty" }, 400);
      }
      group.name = trimmed;
    }
    if (description !== undefined) group.description = description;
    if (icon !== undefined) group.icon = icon;
    if (isDisabled !== undefined) group.isDisabled = isDisabled;

    await group.save();

    notifyUsers(group.participants, "group-dm:updated", {
      groupId,
      name: group.name,
      description: group.description,
      icon: group.icon,
      isDisabled: group.isDisabled,
      updatedBy: userId,
    });

    return c.json({ success: true, group });
  } catch (error) {
    console.error("Error updating group:", error);
    return c.json({ error: "Failed to update group" }, 500);
  }
};

export const deleteGroup = async (c: Context) => {
  try {
    const token = c.req.header("Authorization")?.replace("Bearer ", "");
    if (!token) return c.json({ error: "Unauthorized" }, 401);

    const decoded = await verifyJWT(token);
    if (!decoded) return c.json({ error: "Invalid token" }, 401);

    const { groupId } = c.req.param();

    const userId = getUserIdFromJWT(decoded);
    if (!userId) {
      return c.json({ error: "Invalid token payload" }, 401);
    }

    const group = await Group.findById(groupId);
    if (!group) return c.json({ error: "Group not found" }, 404);

    if (group.owner?.toString() !== userId) {
      return c.json({ error: "Only the group owner can delete the group" }, 403);
    }

    // Capture the recipient set BEFORE deletion — after findByIdAndDelete the
    // participants are gone, and members who don't have the group open aren't
    // in the group room, so we fan out to each one's personal room.
    const recipients = [...group.participants];

    await Message.deleteMany({ groupId });
    await Group.findByIdAndDelete(groupId);

    // Best-effort — the Mongo deletes have already committed either way; a
    // failure here only means this group's messages keep surfacing through
    // search/the assistant a while longer.
    if (isChatServiceEnabled()) {
      void forwardDeleteContent("group", groupId);
    }

    notifyUsers(recipients, "group-dm:deleted", { groupId });

    return c.json({ success: true });
  } catch (error) {
    console.error("Error deleting group:", error);
    return c.json({ error: "Failed to delete group" }, 500);
  }
};

export const getGroupMembers = async (c: Context) => {
  try {
    const token = c.req.header("Authorization")?.replace("Bearer ", "");
    if (!token) return c.json({ error: "Unauthorized" }, 401);

    const decoded = await verifyJWT(token);
    if (!decoded) return c.json({ error: "Invalid token" }, 401);

    const { groupId } = c.req.param();

    const userId = getUserIdFromJWT(decoded);
    if (!userId) return c.json({ error: "Invalid token payload" }, 401);

    const group = await Group.findById(groupId).populate(
      "participants",
      "name email profilePic status lastSeen"
    );

    if (!group) return c.json({ error: "Group not found" }, 404);

    // Membership check — the member list includes emails, so only participants
    // (or the owner) may read it. Previously any authenticated user could
    // enumerate any group's members by id.
    const isMember =
      group.owner?.toString() === userId ||
      (group.participants as any[]).some((p) => p._id.toString() === userId);
    if (!isMember) {
      return c.json({ error: "You are not a member of this group" }, 403);
    }

    const members = (group.participants as any[]).map((p) => ({
      _id: p._id,
      name: p.name,
      email: p.email,
      profilePic: p.profilePic,
      status: p.status,
      lastSeen: p.lastSeen,
      isOwner: p._id.toString() === group.owner?.toString(),
      isAdmin: group.admins?.some(
        (a: any) => a.toString() === p._id.toString()
      ),
    }));

    return c.json({ success: true, members, isDisabled: group.isDisabled });
  } catch (error) {
    console.error("Error fetching members:", error);
    return c.json({ error: "Failed to fetch members" }, 500);
  }
};

async function migrateConversationToGroup(conversationId: string) {
  try {
    const existingGroup = await Group.findById(conversationId);
    if (existingGroup) return existingGroup;

    const conversation = await Conversation.findById(conversationId).populate(
      "participants"
    );
    if (!conversation) return null;

    if (!conversation.participants || conversation.participants.length < 2) {
      return null;
    }

    const firstParticipant = (conversation.participants as any)[0];
    const group = new Group({
      _id: conversationId,
      name: `Group - ${conversation.participants.length} members`,
      icon: "https://res.cloudinary.com/dv4wxcduy/image/upload/v1234567890/default-group-icon.png",
      owner: firstParticipant._id,
      admins: [firstParticipant._id],
      participants: conversation.participants.map((p: any) => p._id),
      messages: [],
      isGroupDM: true,
      isDisabled: false,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
    });

    await group.save();
    console.log(
      `[Migration] Converted Conversation ${conversationId} to Group`
    );
    return group;
  } catch (error) {
    console.error(
      `[Migration] Error migrating conversation ${conversationId}:`,
      error
    );
    return null;
  }
}

export const getUserGroups = async (c: Context) => {
  try {
    const token = c.req.header("Authorization")?.replace("Bearer ", "");
    if (!token) return c.json({ error: "Unauthorized" }, 401);

    const decoded = await verifyJWT(token);
    if (!decoded) return c.json({ error: "Invalid token" }, 401);

    const userId = decoded.userId || decoded.id;
    if (!userId) {
      return c.json({ error: "Invalid token payload" }, 401);
    }

    const userObjectId = new mongoose.Types.ObjectId(userId as string);

    const groups = await Group.find({
      participants: userObjectId,
      isGroupDM: true,
    })
      .populate("participants", "name email profilePic")
      .populate("owner", "name email profilePic")
      .sort({ updatedAt: -1 });

    return c.json({ success: true, groups });
  } catch (error) {
    console.error("Error fetching user groups:", error);
    return c.json({ error: "Failed to fetch groups" }, 500);
  }
};

async function getGroupOrConversation(groupId: string) {
  const groupDoc = await Group.findById(groupId);
  if (groupDoc) return { source: "group", doc: groupDoc };

  const convDoc = await Conversation.findById(groupId).populate("participants");
  if (
    convDoc &&
    Array.isArray((convDoc as any).participants) &&
    (convDoc as any).participants.length >= 2
  ) {
    const migrated = await migrateConversationToGroup(groupId);
    if (migrated) {
      return { source: "migrated", doc: migrated };
    }
  }

  return { source: null, doc: null };
}

export const getGroup = async (c: Context) => {
  try {
    // Auth + membership required. This endpoint returns participants' emails
    // and the last 50 messages; it previously had NO token check at all, so
    // anyone who knew/guessed a groupId could read all of it (IDOR).
    const token = c.req.header("Authorization")?.replace("Bearer ", "");
    if (!token) return c.json({ error: "Unauthorized" }, 401);

    const decoded = await verifyJWT(token);
    if (!decoded) return c.json({ error: "Invalid token" }, 401);

    const userId = getUserIdFromJWT(decoded);
    if (!userId) return c.json({ error: "Invalid token payload" }, 401);

    const { groupId } = c.req.param();

    if (!mongoose.Types.ObjectId.isValid(groupId)) {
      return c.json({ error: "Invalid group ID" }, 400);
    }

    const { source, doc: group } = await getGroupOrConversation(groupId);

    if (!group) return c.json({ error: "Group not found" }, 404);

    // participants are raw ObjectIds at this point (populate happens below).
    const isMember =
      group.owner?.toString() === userId ||
      (group.participants as any[]).some((p) => p.toString() === userId);
    if (!isMember) {
      return c.json({ error: "You are not a member of this group" }, 403);
    }

    if (source === "group" || source === "migrated") {
      await group.populate(
        "participants",
        "name email profilePic status lastSeen"
      );
      await group.populate("owner", "name email profilePic");
      const messages = await Message.find({ groupId: group._id })
        .sort({ createdAt: -1 })
        .limit(50)
        .populate("sender", "name email profilePic")
        .lean();
      return c.json({ success: true, group: { ...group.toObject(), messages } });
    }

    return c.json({ success: true, group });
  } catch (error) {
    console.error("Error fetching group:", error);
    return c.json({ error: "Failed to fetch group" }, 500);
  }
};

export const sendMessage = async (c: Context) => {
  try {
    const token = c.req.header("Authorization")?.replace("Bearer ", "");
    if (!token) return c.json({ error: "Unauthorized" }, 401);

    const decoded = await verifyJWT(token);
    if (!decoded) return c.json({ error: "Invalid token" }, 401);

    const { groupId } = c.req.param();

    let content = "";
    let replyTo: string | null = null;
    // Attachments are stored as attachmentsV2 (the shape the whole app
    // renders — see MessageBubble/RichMessageDisplay and dmController). The
    // group send path previously wrote a single `fileUrl` string, which no
    // renderer reads, so uploaded images/files never showed.
    const attachmentsV2: Array<Record<string, unknown>> = [];

    const contentType = c.req.header("content-type") || "";

    const addUrlAttachments = (body: any) => {
      if (body?.gifUrl) {
        attachmentsV2.push({
          url: body.gifUrl,
          type: "gif",
          mimeType: "image/gif",
        });
      }
      if (Array.isArray(body?.attachments)) {
        for (const a of body.attachments) if (a && a.url) attachmentsV2.push(a);
      }
    };

    if (contentType.includes("multipart/form-data")) {
      // { all: true } so multiple files sent under the same "attachments"
      // field arrive as an array rather than just the last one.
      const body = await c.req.parseBody({ all: true });
      content = (body.content as string) || "";
      replyTo = (body.replyTo as string) || null;

      const raw = body.attachments;
      const files = Array.isArray(raw) ? raw : raw ? [raw] : [];
      for (const f of files) {
        if (!(f instanceof File)) continue;
        try {
          const buffer = Buffer.from(await f.arrayBuffer());
          const attachmentType = inferAttachmentType(f.type);
          const uploadResult = await uploadOnCloudinary(buffer, {
            folder: "group-messages",
            resource_type: getCloudinaryResourceType(attachmentType),
          });
          const url = uploadResult?.secure_url || uploadResult?.url;
          if (url) {
            attachmentsV2.push({
              url,
              type: attachmentType,
              fileName: f.name,
              fileSize: f.size,
              mimeType: f.type,
            });
          }
        } catch (error) {
          console.error("Error uploading group attachment:", error);
        }
      }
    } else {
      // JSON (plain text, gifs/stickers, or pre-uploaded attachment metadata).
      try {
        const body = await c.req.json();
        content = body.content || "";
        replyTo = body.replyTo || null;
        addUrlAttachments(body);
      } catch {
        const body = await c.req.parseBody({ all: true });
        content = (body.content as string) || "";
      }
    }

    if (!content && attachmentsV2.length === 0) {
      return c.json({ error: "Message content is required" }, 400);
    }

    const userId = getUserIdFromJWT(decoded);
    if (!userId) {
      return c.json({ error: "Invalid token payload" }, 401);
    }

    if (!mongoose.Types.ObjectId.isValid(groupId)) {
      return c.json({ error: "Invalid group ID" }, 400);
    }

    const group = await Group.findById(groupId);
    if (!group) return c.json({ error: "Group not found" }, 404);

    const isParticipant = group.participants.some(
      (p: any) => p.toString() === userId
    );
    if (!isParticipant && group.owner?.toString() !== userId) {
      return c.json({ error: "Not a member of this group" }, 403);
    }

    if (group.isDisabled) {
      return c.json({ error: "This group is disabled" }, 403);
    }

    const message = new Message({
      sender: new mongoose.Types.ObjectId(userId as string),
      content: content || "",
      attachmentsV2,
      groupId: new mongoose.Types.ObjectId(groupId),
      createdAt: new Date(),
      replyTo:
        replyTo && mongoose.Types.ObjectId.isValid(replyTo)
          ? new mongoose.Types.ObjectId(replyTo)
          : undefined,
    });

    await message.save();

    await message.populate("sender", "name email profilePic");
    await message.populate({
      path: "replyTo",
      populate: { path: "sender", select: "name profilePic email" },
    });

    const io = getIoInstance();
    io.to(groupId).emit("groupMessage", {
      groupId,
      message: message.toObject(),
    });

    // Same gap as 1:1 DMs (see dmController.ts's createDm) — group messages
    // only ever reached an open, connected socket; a backgrounded/closed app
    // got nothing. No per-group mute setting exists (only mutedServers/
    // mutedConversations), so this only respects the recipient's global
    // notifications.level opt-out.
    try {
      const senderName = (message.sender as any)?.name || "Someone";
      const snippet = content
        ? String(content).slice(0, 140)
        : attachmentsV2.length > 0
          ? "📎 Sent an attachment"
          : "";
      const recipientIds = group.participants
        .map((p: any) => p.toString())
        .filter((id: string) => id !== userId);
      const recipients = await User.find({ _id: { $in: recipientIds } }).select(
        "settings.notifications.level"
      );
      for (const recipient of recipients) {
        const level = (recipient as any).settings?.notifications?.level || "all";
        if (level === "none") continue;
        const notification = await createNotification({
          recipient: recipient._id.toString(),
          sender: userId,
          type: "group_message",
          title: `${senderName} in ${group.name}`,
          message: snippet,
          metadata: { groupId, messageId: message._id.toString() },
          actionUrl: `${process.env.FRONTEND_URL || "http://localhost:3000"}/community/me?group=${groupId}`,
        });
        if (notification) sendNotificationViaSocket(io, recipient._id.toString(), notification);
      }
    } catch (err) {
      console.error("Failed to create group message notifications:", err);
    }

    await CacheInvalidator.invalidateGroup(groupId);
    return c.json({ success: true, message: message.toObject() }, 201);
  } catch (error) {
    console.error("Error sending message:", error);
    return c.json({ error: "Failed to send message" }, 500);
  }
};

const editGroupMessage = async (c: Context) => {
  try {
    const token = c.req.header("Authorization")?.replace("Bearer ", "");
    if (!token) return c.json({ error: "Unauthorized" }, 401);
    const decoded = await verifyJWT(token);
    if (!decoded) return c.json({ error: "Invalid token" }, 401);
    const userId = getUserIdFromJWT(decoded);
    if (!userId) return c.json({ error: "Invalid token payload" }, 401);
    const { groupId, messageId } = c.req.param();
    const { content } = await c.req.json();

    if (!content || !content.trim()) {
      return c.json({ error: "Message content cannot be empty" }, 400);
    }

    const group = await Group.findById(groupId);
    if (!group) return c.json({ error: "Group not found" }, 404);

    const isParticipant = group.participants.some(
      (p: any) => p.toString() === userId
    );
    if (!isParticipant && group.owner?.toString() !== userId) {
      return c.json({ error: "Not a member of this group" }, 403);
    }

    const message = await Message.findById(messageId);
    if (!message) return c.json({ error: "Message not found" }, 404);

    if (message.sender.toString() !== userId) {
      return c.json({ error: "You can only edit your own messages" }, 403);
    }

    message.content = content.trim();
    message.edited = true;
    await message.save();

    await message.populate("sender", "name email profilePic");
    await message.populate({
      path: "replyTo",
      populate: { path: "sender", select: "name profilePic email" },
    });

    const io = getIoInstance();
    io.to(groupId).emit("messageUpdated", message.toObject());

    await CacheInvalidator.invalidateGroup(groupId);
    return c.json({ success: true, message: message.toObject() }, 200);
  } catch (error) {
    console.error("Error editing message:", error);
    return c.json({ error: "Failed to edit message" }, 500);
  }
};

const deleteGroupMessage = async (c: Context) => {
  try {
    const token = c.req.header("Authorization")?.replace("Bearer ", "");
    if (!token) return c.json({ error: "Unauthorized" }, 401);
    const decoded = await verifyJWT(token);
    if (!decoded) return c.json({ error: "Invalid token" }, 401);
    const userId = getUserIdFromJWT(decoded);
    if (!userId) return c.json({ error: "Invalid token payload" }, 401);
    const { groupId, messageId } = c.req.param();

    const group = await Group.findById(groupId);
    if (!group) return c.json({ error: "Group not found" }, 404);

    const isParticipant = group.participants.some(
      (p: any) => p.toString() === userId
    );
    const isOwner = group.owner?.toString() === userId;
    const isAdmin = group.admins?.some((a: any) => a.toString() === userId);

    if (!isParticipant && !isOwner) {
      return c.json({ error: "Not a member of this group" }, 403);
    }

    const message = await Message.findById(messageId);
    if (!message) return c.json({ error: "Message not found" }, 404);

    const isSelfDelete = message.sender.toString() === userId;
    if (!isSelfDelete && !isOwner && !isAdmin) {
      return c.json({ error: "Not authorized to delete this message" }, 403);
    }

    // Only gates deleting your own message. An owner/admin removing someone
    // ELSE's message is moderation, not the sender reconsidering something
    // they said — that should stay available regardless of age.
    if (
      isSelfDelete &&
      Date.now() - message.createdAt.getTime() > DELETE_WINDOW_MS
    ) {
      return c.json(
        { error: "This message is too old to delete" },
        403
      );
    }

    await Message.findByIdAndDelete(messageId);

    // Unlike channel/DM messages, group-DM message deletes have no
    // "for-me"/"for-everyone" split — this is always a genuine hard delete,
    // so unlike those, there's no chunker-quirk risk in tombstoning it here.
    if (isChatServiceEnabled()) {
      void forwardDeleteContent("source", messageId, "message");
    }

    const io = getIoInstance();
    io.to(groupId).emit("messageDeleted", messageId);

    await CacheInvalidator.invalidateGroup(groupId);
    return c.json({ success: true, messageId }, 200);
  } catch (error) {
    console.error("Error deleting message:", error);
    return c.json({ error: "Failed to delete message" }, 500);
  }
};

const toggleGroupReaction = async (c: Context) => {
  try {
    const token = c.req.header("Authorization")?.replace("Bearer ", "");
    if (!token) return c.json({ error: "Unauthorized" }, 401);
    const decoded = await verifyJWT(token);
    if (!decoded) return c.json({ error: "Invalid token" }, 401);
    const authUserId = getUserIdFromJWT(decoded);
    if (!authUserId) return c.json({ error: "Invalid token payload" }, 401);
    const { groupId, messageId } = c.req.param();
    const { emoji } = await c.req.json();

    if (!emoji) {
      return c.json({ error: "Emoji is required" }, 400);
    }

    const group = await Group.findById(groupId);
    if (!group) return c.json({ error: "Group not found" }, 404);

    const isParticipant = group.participants.some(
      (p: any) => p.toString() === authUserId
    );
    if (!isParticipant && group.owner?.toString() !== authUserId) {
      return c.json({ error: "Not a member of this group" }, 403);
    }

    const message = await Message.findById(messageId);
    if (!message) return c.json({ error: "Message not found" }, 404);

    const userObjectId = new mongoose.Types.ObjectId(authUserId);

    const reactionIndex = message.reactions.findIndex((r) => r.emoji === emoji);

    if (reactionIndex > -1) {
      const hasReacted = message.reactions[reactionIndex].users.some(
        (u) => u.toString() === userObjectId.toString()
      );

      if (hasReacted) {
        message.reactions[reactionIndex].users = message.reactions[
          reactionIndex
        ].users.filter((u) => u.toString() !== userObjectId.toString());

        if (message.reactions[reactionIndex].users.length === 0) {
          message.reactions.splice(reactionIndex, 1);
        }
      } else {
        message.reactions.forEach((reaction) => {
          reaction.users = reaction.users.filter(
            (u) => u.toString() !== userObjectId.toString()
          );
        });
        message.reactions = message.reactions.filter((r) => r.users.length > 0);

        message.reactions[reactionIndex].users.push(userObjectId);
      }
    } else {
      message.reactions.forEach((reaction) => {
        reaction.users = reaction.users.filter(
          (u) => u.toString() !== userObjectId.toString()
        );
      });
      message.reactions = message.reactions.filter((r) => r.users.length > 0);

      message.reactions.push({
        emoji,
        users: [userObjectId],
      });
    }

    await message.save();

    const io = getIoInstance();
    io.to(groupId).emit("reactionUpdated", {
      messageId,
      reactions: message.reactions,
    });

    return c.json({ success: true, reactions: message.reactions }, 200);
  } catch (error) {
    console.error("Error toggling reaction:", error);
    return c.json({ error: "Failed to toggle reaction" }, 500);
  }
};

/**
 * Marks every message in a group as delivered to the calling user — called
 * when their client opens the group chat. Mirrors markMessagesAsRead's exact
 * per-message emit pattern (featureController.ts) so a group message's
 * sender learns about delivery through the same "message:delivered" channel
 * their personal room already receives, just keyed to their own room instead
 * of a new one. Unlike 1:1 DMs (a single conversation-level lastDeliveredAt
 * high-water-mark), a group has multiple recipients, so delivery has to be
 * tracked per-message (deliveredTo) to know when ALL of them have it.
 */
export const markGroupDelivered = async (c: Context) => {
  try {
    const token = c.req.header("Authorization")?.replace("Bearer ", "");
    if (!token) return c.json({ error: "Unauthorized" }, 401);
    const decoded = await verifyJWT(token);
    if (!decoded) return c.json({ error: "Invalid token" }, 401);
    const userId = getUserIdFromJWT(decoded);
    if (!userId) return c.json({ error: "Invalid token payload" }, 401);

    const { groupId } = c.req.param();
    if (!mongoose.Types.ObjectId.isValid(groupId)) {
      return c.json({ error: "Invalid group ID" }, 400);
    }

    const group = await Group.findById(groupId).select("participants owner");
    if (!group) return c.json({ error: "Group not found" }, 404);

    const isMember =
      group.owner?.toString() === userId ||
      group.participants.some((p: any) => p.toString() === userId);
    if (!isMember) {
      return c.json({ error: "Not a member of this group" }, 403);
    }

    const userObjectId = new mongoose.Types.ObjectId(userId);

    // Only messages from OTHER senders, not already delivered to this user —
    // own messages don't need a self-delivery ack, and this keeps the update
    // (and the resulting emits) limited to what actually changed.
    const undelivered = await Message.find({
      groupId: group._id,
      sender: { $ne: userObjectId },
      deliveredTo: { $ne: userObjectId },
    }).select("_id sender");

    if (undelivered.length === 0) {
      return c.json({ success: true, count: 0 }, 200);
    }

    await Message.updateMany(
      { _id: { $in: undelivered.map((m) => m._id) } },
      { $addToSet: { deliveredTo: userObjectId } }
    );

    const io = getIoInstance();
    for (const msg of undelivered) {
      if (!msg.sender) continue;
      io.to(msg.sender.toString()).emit("message:delivered", {
        groupId,
        messageId: msg._id,
        userId,
      });
    }

    return c.json({ success: true, count: undelivered.length }, 200);
  } catch (error) {
    console.error("Error marking group messages delivered:", error);
    return c.json({ error: "Failed to mark messages delivered" }, 500);
  }
};

export const getGroupMessages = async (c: Context) => {
  try {
    const token = c.req.header("Authorization")?.replace("Bearer ", "");
    if (!token) return c.json({ error: "Unauthorized" }, 401);

    const decoded = await verifyJWT(token);
    if (!decoded) return c.json({ error: "Invalid token" }, 401);

    const { groupId } = c.req.param();
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") || "30")));
    // Cursor for "load older": a message _id; we return the page of messages
    // strictly older than it. Absent → the newest page. This is what powers
    // WhatsApp-style scroll-up loading (open on the newest, page backwards),
    // replacing the old page/skip model that opened on the OLDEST messages.
    const before = c.req.query("before");

    if (!mongoose.Types.ObjectId.isValid(groupId)) {
      return c.json({ error: "Invalid group ID" }, 400);
    }

    const userId = getUserIdFromJWT(decoded);
    if (!userId) return c.json({ error: "Invalid token payload" }, 401);

    const group = await Group.findById(groupId).select("participants owner");
    if (!group) return c.json({ error: "Group not found" }, 404);

    const isParticipant = group.participants.some(
      (p: any) => p.toString() === userId
    );
    if (!isParticipant && group.owner?.toString() !== userId) {
      return c.json({ error: "Not a member of this group" }, 403);
    }

    const query: Record<string, unknown> = { groupId: group._id };
    if (before && mongoose.Types.ObjectId.isValid(before)) {
      query._id = { $lt: new mongoose.Types.ObjectId(before) };
    }

    // Fetch newest-first (limit + 1 to detect more), then hand back in
    // chronological order so the client can append the page above what it
    // already has. _id is monotonic with creation time, so it doubles as the
    // sort key and the cursor (matches the 1:1 DM getDm pattern).
    const rows = await Message.find(query)
      .sort({ _id: -1 })
      .limit(limit + 1)
      .populate("sender", "name email profilePic username")
      .populate({
        path: "replyTo",
        populate: { path: "sender", select: "name profilePic email" },
      })
      .lean();

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const messages = pageRows.reverse(); // oldest → newest for display
    const nextCursor = messages.length > 0 ? String(messages[0]._id) : null;

    return c.json({ messages, hasMore, nextCursor });
  } catch (error) {
    console.error("Error fetching group messages:", error);
    return c.json({ error: "Failed to fetch messages" }, 500);
  }
};

// Lets a group chat, on open/reload, show "call in progress — tap to join"
// even if the viewer wasn't around for the transient group-call:incoming
// ring (app closed, tab not open) — there's no persistent equivalent of that
// socket event otherwise.
export const getGroupCallStatus = async (c: Context) => {
  try {
    const token = c.req.header("Authorization")?.replace("Bearer ", "");
    if (!token) return c.json({ error: "Unauthorized" }, 401);

    const decoded = await verifyJWT(token);
    if (!decoded) return c.json({ error: "Invalid token" }, 401);

    const userId = getUserIdFromJWT(decoded);
    if (!userId) return c.json({ error: "Invalid token payload" }, 401);

    const { groupId } = c.req.param();
    if (!mongoose.Types.ObjectId.isValid(groupId)) {
      return c.json({ error: "Invalid group ID" }, 400);
    }

    const group = await Group.findById(groupId).select("participants").lean();
    if (!group) return c.json({ error: "Group not found" }, 404);
    const isMember = (group.participants || []).some((p: any) => p.toString() === userId);
    if (!isMember) {
      return c.json({ error: "You are not a member of this group" }, 403);
    }

    const call = await getActiveGroupCall(groupId);
    return c.json({ call });
  } catch (error) {
    console.error("Error fetching group call status:", error);
    return c.json({ error: "Failed to fetch group call status" }, 500);
  }
};

groupDmController.get("/my-groups", getUserGroups);
groupDmController.get("/:groupId", getGroup);
groupDmController.post("/create", createGroup);
groupDmController.post("/:groupId/add-members", addMembers);
groupDmController.delete("/:groupId/remove-member/:memberId", removeMember);
groupDmController.post("/:groupId/make-admin/:memberId", makeAdmin);
groupDmController.delete("/:groupId/remove-admin/:memberId", removeAdmin);
groupDmController.post("/:groupId/leave", leaveGroup);
groupDmController.put("/:groupId/update", updateGroup);
groupDmController.delete("/:groupId/delete", deleteGroup);
groupDmController.get("/:groupId/members", getGroupMembers);
groupDmController.get("/:groupId/call", getGroupCallStatus);
groupDmController.get("/:groupId/messages", getGroupMessages);
groupDmController.put("/:groupId/mark-delivered", markGroupDelivered);
groupDmController.post("/:groupId/messages", sendMessage);
groupDmController.put("/:groupId/messages/:messageId", editGroupMessage);
groupDmController.delete("/:groupId/messages/:messageId", deleteGroupMessage);
groupDmController.put(
  "/:groupId/messages/:messageId/reaction",
  toggleGroupReaction
);

export default groupDmController;
