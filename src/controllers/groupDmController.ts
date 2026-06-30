import { Context, Hono } from "hono";
import { getIoInstance } from "../config/socket.ts";
import Group from "../models/Group.ts";
import Conversation from "../models/Conversation.ts";
import Message from "../models/Message.ts";
import { verify } from "hono/jwt";
import mongoose from "mongoose";
import { uploadOnCloudinary } from "../lib/cloudinary.ts";
import CacheInvalidator from "../lib/cacheInvalidation.ts";

const groupDmController = new Hono();

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

    group.participants.push(
      ...newMembers.map((id: string) => new mongoose.Types.ObjectId(id))
    );
    await group.save();

    await group.populate("participants", "name email profilePic");

    const io = getIoInstance();
    io.to(groupId).emit("group-dm:members-added", {
      groupId,
      newMembers,
      allMembers: group.participants,
    });

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

    if (memberId === group.owner?.toString()) {
      return c.json({ error: "Cannot remove group owner" }, 400);
    }

    group.participants = group.participants.filter(
      (p: any) => p.toString() !== memberId
    );

    if (group.admins) {
      group.admins = group.admins.filter((a: any) => a.toString() !== memberId);
    }

    await group.save();
    await group.populate("participants", "name email profilePic");

    const io = getIoInstance();
    io.to(groupId).emit("group-dm:member-removed", {
      groupId,
      removedMemberId: memberId,
      remainingMembers: group.participants,
    });

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

    const io = getIoInstance();
    io.to(groupId).emit("group-dm:member-promoted", {
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

    if (group.admins) {
      group.admins = group.admins.filter((a: any) => a.toString() !== memberId);
      await group.save();
    }

    const io = getIoInstance();
    io.to(groupId).emit("group-dm:member-demoted", {
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
          error: "Owner cannot leave. Transfer ownership or delete the group.",
        },
        400
      );
    }

    if (group.isDisabled) {
      return c.json({ error: "This group is disabled" }, 403);
    }

    group.participants = group.participants.filter(
      (p: any) => p.toString() !== userId
    );

    if (group.admins) {
      group.admins = group.admins.filter((a: any) => a.toString() !== userId);
    }

    await group.save();

    const io = getIoInstance();
    io.to(groupId).emit("group-dm:member-left", {
      groupId,
      userId,
      remainingCount: group.participants.length,
    });

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

    if (name) group.name = name.trim();
    if (description !== undefined) group.description = description;
    if (icon !== undefined) group.icon = icon;
    if (isDisabled !== undefined) group.isDisabled = isDisabled;

    await group.save();

    const io = getIoInstance();
    io.to(groupId).emit("group-dm:updated", {
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
      return c.json({ error: "Only group owner can delete group" }, 403);
    }

    await Message.deleteMany({ groupId });

    await Group.findByIdAndDelete(groupId);

    const io = getIoInstance();
    io.to(groupId).emit("group-dm:deleted", { groupId });

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

    const group = await Group.findById(groupId).populate(
      "participants",
      "name email profilePic status lastSeen"
    );

    if (!group) return c.json({ error: "Group not found" }, 404);

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
    const { groupId } = c.req.param();

    if (!mongoose.Types.ObjectId.isValid(groupId)) {
      return c.json({ error: "Invalid group ID" }, 400);
    }

    const { source, doc: group } = await getGroupOrConversation(groupId);

    if (!group) return c.json({ error: "Group not found" }, 404);

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
    let fileUrl: string | null = null;

    const contentType = c.req.header("content-type") || "";

    if (contentType.includes("application/json")) {
      const body = await c.req.json();
      content = body.content || "";
      fileUrl = body.fileUrl || null;
    } else if (contentType.includes("multipart/form-data")) {
      const body = await c.req.parseBody();
      content = (body.content as string) || "";

      const file = body.attachments as File | File[] | undefined;
      if (file) {
        try {
          const files = Array.isArray(file) ? file : [file];
          for (const f of files) {
            if (f instanceof File) {
              const arrayBuffer = await f.arrayBuffer();
              const buffer = Buffer.from(arrayBuffer);

              const uploadResult = await uploadOnCloudinary(buffer, {
                folder: "group-messages",
                resource_type: "auto",
              });

              if (uploadResult?.url) {
                fileUrl = uploadResult.url;
                break;
              }
            }
          }
        } catch (error) {
          console.error("Error uploading file:", error);
        }
      }
    } else {
      try {
        const body = await c.req.json();
        content = body.content || "";
        fileUrl = body.fileUrl || null;
      } catch {
        const body = await c.req.parseBody();
        content = (body.content as string) || "";
      }
    }

    if (!content && !fileUrl) {
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
      fileUrl: fileUrl || null,
      groupId: new mongoose.Types.ObjectId(groupId),
      createdAt: new Date(),
    });

    await message.save();

    await message.populate("sender", "name email profilePic");

    const io = getIoInstance();
    io.to(groupId).emit("groupMessage", {
      groupId,
      message: message.toObject(),
    });

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

    if (message.sender.toString() !== userId && !isOwner && !isAdmin) {
      return c.json({ error: "Not authorized to delete this message" }, 403);
    }

    await Message.findByIdAndDelete(messageId);

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

export const getGroupMessages = async (c: Context) => {
  try {
    const token = c.req.header("Authorization")?.replace("Bearer ", "");
    if (!token) return c.json({ error: "Unauthorized" }, 401);

    const decoded = await verifyJWT(token);
    if (!decoded) return c.json({ error: "Invalid token" }, 401);

    const { groupId } = c.req.param();
    const page = Math.max(1, parseInt(c.req.query("page") || "1"));
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") || "50")));
    const skip = (page - 1) * limit;

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

    const messages = await Message.find({ groupId: group._id })
      .sort({ createdAt: 1 })
      .skip(skip)
      .limit(limit)
      .populate("sender", "name email profilePic username")
      .lean();

    return c.json(messages);
  } catch (error) {
    console.error("Error fetching group messages:", error);
    return c.json({ error: "Failed to fetch messages" }, 500);
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
groupDmController.get("/:groupId/messages", getGroupMessages);
groupDmController.post("/:groupId/messages", sendMessage);
groupDmController.put("/:groupId/messages/:messageId", editGroupMessage);
groupDmController.delete("/:groupId/messages/:messageId", deleteGroupMessage);
groupDmController.put(
  "/:groupId/messages/:messageId/reaction",
  toggleGroupReaction
);

export default groupDmController;
