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
import { verify } from "hono/jwt";
import User from "../models/User.ts";
import DiscordServer from "../models/DiscordServer.ts";
import { Server } from "socket.io";
import {
  canViewFullProfile,
  getProfileVisibility,
  redactedProfileView,
  fullProfileView,
  buildProfileView,
} from "../lib/profilePrivacy.ts";
import {
  createNotification,
  sendNotificationViaSocket,
} from "./notificationController.ts";
import { invalidateAfterUserUpdate } from "../lib/cacheInvalidation.ts";
import { broadcastProfileChange } from "../lib/profileBroadcast.ts";
import ServerMember from "../models/ServerMember.ts";
import Follow from "../models/Follow.ts";
import { Reel } from "../models/Reel.ts";
import { canViewRelationships } from "./followController.ts";
import { redactParticipant } from "../lib/dmFormatting.ts";

function computeCreatorLevel(followerCount: number): string {
  if (followerCount >= 10000) return "Top Creator";
  if (followerCount >= 1000) return "Established Creator";
  if (followerCount >= 100) return "Rising Creator";
  return "New Creator";
}

/** Aggregate creator/social stats shown on a profile — always computed,
 * regardless of privacy restriction (follower/following/post counts are
 * shown even on locked profiles, matching the convention every mainstream
 * social platform uses; the underlying content itself stays gated). */
async function getCreatorStats(targetId: string, viewerId: string | null) {
  const targetObjId = new mongoose.Types.ObjectId(targetId);

  const [followerCount, followingCount, reelAgg, target] = await Promise.all([
    Follow.countDocuments({ followee: targetId, status: "accepted" }),
    Follow.countDocuments({ follower: targetId, status: "accepted" }),
    Reel.aggregate([
      { $match: { creator_id: targetObjId, isDeleted: false } },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          totalLikes: { $sum: "$likeCount" },
          totalViews: { $sum: "$viewCount" },
        },
      },
    ]),
    User.findById(targetId).select("servers friends"),
  ]);

  const reelCount = reelAgg[0]?.count ?? 0;
  const isCreator = reelCount > 0;

  let mutualFriendsCount = 0;
  let mutualCommunitiesCount = 0;
  if (viewerId && viewerId !== targetId && target) {
    const viewer = await User.findById(viewerId).select("servers friends");
    if (viewer) {
      const targetFriendSet = new Set(
        (target.friends ?? []).map((f) => f.toString())
      );
      mutualFriendsCount = (viewer.friends ?? []).filter((f) =>
        targetFriendSet.has(f.toString())
      ).length;

      const targetServerSet = new Set(
        (target.servers ?? []).map((s) => s.toString())
      );
      mutualCommunitiesCount = (viewer.servers ?? []).filter((s) =>
        targetServerSet.has(s.toString())
      ).length;
    }
  }

  return {
    followerCount,
    followingCount,
    reelCount,
    totalLikes: reelAgg[0]?.totalLikes ?? 0,
    totalViews: reelAgg[0]?.totalViews ?? 0,
    communitiesJoinedCount: target?.servers?.length ?? 0,
    mutualFriendsCount,
    mutualCommunitiesCount,
    isCreator,
    creatorLevel: isCreator ? computeCreatorLevel(followerCount) : null,
  };
}

export const getAllUsers = async (c: Context) => {
  try {
    const auth = c.get("user");
    const authId = auth?.id;

    if (authId && mongoose.Types.ObjectId.isValid(authId)) {
      const me = await User.findById(authId).select("friends blockedUsers");
      const friendSet = new Set((me?.friends || []).map(String));
      const myBlocked = (me?.blockedUsers || []).map((b) => b.toString());

      // Part 9: a blocked user (either direction) must not appear in
      // suggestions/listings — exclude self, users I blocked, and users who
      // blocked me.
      const users = await User.find({
        _id: { $ne: authId, $nin: myBlocked },
        blockedUsers: { $ne: authId },
      });

      const myFollowingIds = new Set(
        (
          await Follow.find({
            follower: authId,
            followee: { $in: users.map((u) => u._id) },
            status: "accepted",
          }).distinct("followee")
        ).map((id) => id.toString())
      );

      // Uses the same buildProfileView pipeline as getUser/getUserProfile/
      // searchUsers so "friends"/"followers"/"private" are all honoured
      // consistently (previously this only redacted "private", leaving
      // "friends"-only profiles fully exposed to non-friend viewers here).
      const enriched = users.map((u) => {
        const isFriend = friendSet.has(String(u._id));
        const isFollower = myFollowingIds.has(String(u._id));
        const view = buildProfileView(u, {
          viewerId: authId,
          isFriend,
          isFollower,
        });
        return { ...view, isFriend };
      });

      if (enriched.length === 0) {
        return c.json({ message: "No users found" }, 404);
      }
      return c.json({ users: enriched }, 200);
    }

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

    // This route is public, so resolve the viewer from the bearer token when
    // present — needed to honour "friends"/"private" visibility.
    let viewerId: string | null = null;
    const authHeader = c.req.header("Authorization");
    if (authHeader?.startsWith("Bearer ")) {
      try {
        const decoded = (await verify(
          authHeader.slice(7),
          process.env.JWT_SECRET as string,
          "HS256"
        )) as { id?: string };
        viewerId = decoded?.id ?? null;
      } catch {
        viewerId = null; // anonymous viewer
      }
    }

    let isFriend = false;
    let isFollower = false;
    if (viewerId && viewerId !== id) {
      const viewer = await User.findById(viewerId).select("friends");
      isFriend = !!viewer?.friends?.some((f) => f.toString() === id);
      isFollower = !!(await Follow.exists({
        follower: viewerId,
        followee: id,
        status: "accepted",
      }));
    }

    const visibility = getProfileVisibility(user);
    const stats = await getCreatorStats(id, viewerId);

    if (canViewFullProfile(user, { viewerId, isFriend, isFollower })) {
      // Curated view only — never return the raw Mongoose doc, which would
      // leak friends/blockedUsers/settings/providerAccountId/reset tokens.
      return c.json(
        { user: { ...fullProfileView(user), stats }, restricted: false, visibility },
        200
      );
    }

    // Restricted: identity only, plus the always-visible aggregate counts.
    return c.json(
      { user: { ...redactedProfileView(user), stats }, restricted: true, visibility },
      200
    );
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
    if (profilePic) user.profilePic = profilePic;
    await user.save();

    // Same authoritative broadcast as updateProfile so this alternate write
    // path can't silently leave other viewers stale.
    broadcastProfileChange({
      _id: user._id,
      name: user.name,
      profilePic: user.profilePic,
      // @ts-ignore - about field exists but not in the User type
      about: user.about,
    });

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

/** View another user's PUBLIC communities — the "View Communities" profile
 * action. Privacy-gated the same way as followers/following/reels; ALSO only
 * ever returns publicly-visible communities regardless of profile privacy,
 * since community visibility is a separate, stricter axis than profile
 * visibility — a public profile shouldn't leak private server membership. */
export const getUserCommunities = async (c: Context) => {
  try {
    const { id: targetId } = c.req.param();
    const viewer = c.get("user");
    if (!targetId || !mongoose.Types.ObjectId.isValid(targetId)) {
      return c.json({ error: "Invalid user ID" }, 400);
    }

    if (!(await canViewRelationships(targetId, viewer.id))) {
      return c.json({ error: "This account's communities are private" }, 403);
    }

    const target = await User.findById(targetId).select("servers");
    if (!target) {
      return c.json({ error: "User not found" }, 404);
    }

    const communities = await DiscordServer.find({
      _id: { $in: target.servers ?? [] },
      visibility: "public",
    })
      .select("name description imageUrl visibility")
      .lean();

    return c.json({ communities });
  } catch (error) {
    console.error("Error fetching user communities:", error);
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
    const ConversationReadStatus = (
      await import("../models/ConversationReadStatus.ts")
    ).default;

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
        select: "name email profilePic lastSeen settings",
        match: { _id: { $ne: id } },
      })
      .sort({ updatedAt: -1 });

    // One query for this user's read state across all visible conversations,
    // instead of one query per conversation.
    const readStatuses = await ConversationReadStatus.find({
      user: id,
      conversation: { $in: conversations.map((conv) => conv._id) },
    }).select("conversation lastReadAt");

    const lastReadByConv = new Map<string, Date>(
      readStatuses.map((rs) => [rs.conversation.toString(), rs.lastReadAt])
    );

    const formattedConversations = await Promise.all(
      conversations.map(async (conv) => {
        const convId = conv._id;
        // Per-user "delete conversation" hides everything before this cutoff.
        const deletedAt = conv.deletedAt?.get(id.toString());
        const lastReadAt = lastReadByConv.get(convId.toString());

        // Latest message visible to this user (skips messages they deleted
        // for themselves, and anything before their delete cutoff).
        const lastMsgQuery: Record<string, unknown> = {
          conversationId: convId,
          deletedFor: { $ne: id },
        };
        if (deletedAt) lastMsgQuery.createdAt = { $gt: deletedAt };

        const lastMsgDoc = await Message.findOne(lastMsgQuery)
          .sort({ createdAt: -1 })
          .select("content sender createdAt edited attachmentsV2")
          .populate({ path: "sender", select: "name" })
          .lean<{
            _id: mongoose.Types.ObjectId;
            content: string;
            sender:
              | { _id: mongoose.Types.ObjectId; name: string }
              | mongoose.Types.ObjectId;
            createdAt: Date;
            edited?: boolean;
            attachmentsV2?: unknown[];
          }>();

        const lastMessage = lastMsgDoc
          ? {
              _id: lastMsgDoc._id,
              content: lastMsgDoc.content,
              sender: lastMsgDoc.sender,
              createdAt: lastMsgDoc.createdAt,
              edited: lastMsgDoc.edited || false,
              attachmentsV2: lastMsgDoc.attachmentsV2 || [],
            }
          : null;

        // Unread = messages from the other participant after the later of
        // {last read, delete cutoff}, excluding messages deleted for everyone
        // or for this user.
        const cutoffs = [lastReadAt, deletedAt].filter(Boolean) as Date[];
        const unreadCutoff = cutoffs.length
          ? new Date(Math.max(...cutoffs.map((d) => d.getTime())))
          : null;

        const unreadQuery: Record<string, unknown> = {
          conversationId: convId,
          sender: { $ne: id },
          deletedForEveryone: { $ne: true },
          deletedFor: { $ne: id },
        };
        if (unreadCutoff) unreadQuery.createdAt = { $gt: unreadCutoff };

        const unreadCount = await Message.countDocuments(unreadQuery);

        // Redact profilePic for participants who set visibility to "private".
        // "friends" accounts are fine — DM contacts are effectively friends.
        const redactedParticipants = (conv.participants as any[]).map(
          redactParticipant
        );

        return {
          _id: conv._id,
          participants: redactedParticipants,
          lastMessage,
          unreadCount,
          createdAt: conv.createdAt,
          updatedAt: conv.updatedAt,
          lastActivityAt: lastMessage?.createdAt ?? conv.updatedAt,
        };
      })
    );

    // Authoritative ordering: most recent activity first.
    formattedConversations.sort(
      (a, b) =>
        new Date(b.lastActivityAt).getTime() -
        new Date(a.lastActivityAt).getTime()
    );

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

    // Authoritative, server-side global broadcast — reaches every connected
    // viewer regardless of the editor's own socket state or which surface
    // shows the avatar. Replaces the old self-room-only emit + the fragile
    // client re-emit in MyProfileEditor.
    broadcastProfileChange({
      _id: user._id,
      name: user.name,
      profilePic: user.profilePic,
      // @ts-ignore - about field exists but not in the User type
      about: user.about,
    });

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
