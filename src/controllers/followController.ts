import { Context } from "hono";
import mongoose from "mongoose";
import User from "../models/User.ts";
import Follow from "../models/Follow.ts";
import { Reel } from "../models/Reel.ts";
import { UserReelPreference } from "../models/UserReelPreference.ts";
import { getProfileVisibility, buildProfileView } from "../lib/profilePrivacy.ts";
import {
  createNotification,
  sendNotificationViaSocket,
} from "./notificationController.ts";
import { getIoInstance } from "../config/socket.ts";
import { invalidateAfterFollowChange } from "../lib/cacheInvalidation.ts";

const PROFILE_CARD_FIELDS =
  "name username profilePic about verified settings.privacy.profileVisibility";

async function areBlocked(a: string, b: string): Promise<boolean> {
  if (a === b) return false;
  const [userA, userB] = await Promise.all([
    User.findById(a).select("blockedUsers"),
    User.findById(b).select("blockedUsers"),
  ]);
  const aBlockedB = userA?.blockedUsers?.some((u) => u?.toString() === b);
  const bBlockedA = userB?.blockedUsers?.some((u) => u?.toString() === a);
  return !!aBlockedB || !!bBlockedA;
}

async function getFollowerCount(userId: string): Promise<number> {
  return Follow.countDocuments({ followee: userId, status: "accepted" });
}

function safeIo() {
  try {
    return getIoInstance();
  } catch {
    return undefined; // socket not initialised yet in tests / cold start
  }
}

export const followUser = async (c: Context) => {
  try {
    const me = c.get("user");
    const followerId = me.id;
    const followeeId = c.req.param("userId");

    if (!followeeId || !mongoose.Types.ObjectId.isValid(followeeId)) {
      return c.json({ error: "Invalid user ID" }, 400);
    }
    if (followerId === followeeId) {
      return c.json({ error: "Cannot follow yourself" }, 400);
    }

    // The JWT payload only carries {id, email} — fetch the real profile for
    // the name/avatar that go into the notification and socket payload.
    const [follower, followee] = await Promise.all([
      User.findById(followerId).select("name profilePic"),
      User.findById(followeeId).select(
        "name username profilePic settings.privacy blockedUsers"
      ),
    ]);
    if (!followee) {
      return c.json({ error: "User not found" }, 404);
    }

    if (await areBlocked(followerId, followeeId)) {
      return c.json({ error: "Unable to follow this user" }, 403);
    }

    const existing = await Follow.findOne({
      follower: followerId,
      followee: followeeId,
    });
    if (existing) {
      return c.json(
        {
          error:
            existing.status === "pending"
              ? "Follow request already pending"
              : "Already following this user",
          status: existing.status,
        },
        400
      );
    }

    const visibility = getProfileVisibility(followee);
    const status: "pending" | "accepted" =
      visibility === "followers" ? "pending" : "accepted";

    const follow = await Follow.create({
      follower: followerId,
      followee: followeeId,
      status,
    });

    const followerName = follower?.name ?? "Someone";
    const notification = await createNotification({
      recipient: followeeId,
      sender: followerId,
      type: "follow",
      title: status === "pending" ? "New follow request" : "New follower",
      message:
        status === "pending"
          ? `${followerName} wants to follow you`
          : `${followerName} started following you`,
      metadata: { followId: follow._id, status },
      actionUrl: `/profile/${followerId}`,
    });

    const io = safeIo();
    if (notification) sendNotificationViaSocket(io, followeeId, notification);
    if (status === "accepted") {
      io?.to(followeeId).emit("creator:follow", {
        followerId,
        name: followerName,
        profilePic: follower?.profilePic ?? "",
        followedAt: follow.createdAt,
      });
      io?.to(followeeId).emit("creator:followerCountUpdated", {
        creatorId: followeeId,
        followerCount: await getFollowerCount(followeeId),
      });
      // Mirror of the above for anyone watching the FOLLOWER's following-list
      // (opposite direction — creator:follow only reaches followee-room viewers).
      io?.to(`following-list:${followerId}`).emit("creator:followingAdded", {
        followerId,
        addedUser: {
          _id: followeeId,
          name: followee.name,
          username: (followee as any).username,
          profilePic: followee.profilePic,
        },
      });
    }

    await invalidateAfterFollowChange(followerId, followeeId);

    return c.json(
      { message: "Follow recorded", status, follow, notification },
      201
    );
  } catch (error: any) {
    if (error?.code === 11000) {
      return c.json({ error: "Already following this user" }, 400);
    }
    console.error("Error following user:", error);
    return c.json({ error: "Failed to follow user" }, 500);
  }
};

export const unfollowUser = async (c: Context) => {
  try {
    const me = c.get("user");
    const followeeId = c.req.param("userId");

    if (!followeeId || !mongoose.Types.ObjectId.isValid(followeeId)) {
      return c.json({ error: "Invalid user ID" }, 400);
    }

    const deleted = await Follow.findOneAndDelete({
      follower: me.id,
      followee: followeeId,
    });

    if (!deleted) {
      return c.json({ error: "You are not following this user" }, 404);
    }

    if (deleted.status === "accepted") {
      const io = safeIo();
      io?.to(followeeId).emit("creator:unfollow", { followerId: me.id });
      io?.to(followeeId).emit("creator:followerCountUpdated", {
        creatorId: followeeId,
        followerCount: await getFollowerCount(followeeId),
      });
      io?.to(`following-list:${me.id}`).emit("creator:followingRemoved", {
        followerId: me.id,
        removedUserId: followeeId,
      });
    }

    await invalidateAfterFollowChange(me.id, followeeId);

    return c.json({
      message:
        deleted.status === "pending"
          ? "Follow request cancelled"
          : "Unfollowed",
    });
  } catch (error) {
    console.error("Error unfollowing user:", error);
    return c.json({ error: "Failed to unfollow user" }, 500);
  }
};

export const acceptFollowRequest = async (c: Context) => {
  try {
    const me = c.get("user");
    const requesterId = c.req.param("userId");

    if (!requesterId || !mongoose.Types.ObjectId.isValid(requesterId)) {
      return c.json({ error: "Invalid user ID" }, 400);
    }

    const follow = await Follow.findOne({
      follower: requesterId,
      followee: me.id,
      status: "pending",
    });
    if (!follow) {
      return c.json({ error: "No pending request from this user" }, 404);
    }

    follow.status = "accepted";
    await follow.save();

    const [me_, requester] = await Promise.all([
      User.findById(me.id).select("name username profilePic"),
      User.findById(requesterId).select("name profilePic"),
    ]);

    const notification = await createNotification({
      recipient: requesterId,
      sender: me.id,
      type: "follow",
      title: "Follow request accepted",
      message: `${me_?.name ?? "Someone"} accepted your follow request`,
      metadata: { followId: follow._id, status: "accepted" },
      actionUrl: `/profile/${me.id}`,
    });

    const io = safeIo();
    if (notification) sendNotificationViaSocket(io, requesterId, notification);
    io?.to(me.id).emit("creator:follow", {
      followerId: requesterId,
      name: requester?.name ?? "Someone",
      profilePic: requester?.profilePic ?? "",
      followedAt: follow.createdAt,
    });
    io?.to(me.id).emit("creator:followerCountUpdated", {
      creatorId: me.id,
      followerCount: await getFollowerCount(me.id),
    });
    io?.to(`following-list:${requesterId}`).emit("creator:followingAdded", {
      followerId: requesterId,
      addedUser: {
        _id: me.id,
        name: me_?.name,
        username: (me_ as any)?.username,
        profilePic: me_?.profilePic,
      },
    });

    await invalidateAfterFollowChange(requesterId, me.id);

    return c.json({ message: "Follow request accepted", follow, notification });
  } catch (error) {
    console.error("Error accepting follow request:", error);
    return c.json({ error: "Failed to accept follow request" }, 500);
  }
};

export const rejectFollowRequest = async (c: Context) => {
  try {
    const me = c.get("user");
    const requesterId = c.req.param("userId");

    if (!requesterId || !mongoose.Types.ObjectId.isValid(requesterId)) {
      return c.json({ error: "Invalid user ID" }, 400);
    }

    const deleted = await Follow.findOneAndDelete({
      follower: requesterId,
      followee: me.id,
      status: "pending",
    });
    if (!deleted) {
      return c.json({ error: "No pending request from this user" }, 404);
    }

    await invalidateAfterFollowChange(requesterId, me.id);

    return c.json({ message: "Follow request rejected" });
  } catch (error) {
    console.error("Error rejecting follow request:", error);
    return c.json({ error: "Failed to reject follow request" }, 500);
  }
};

export const getPendingFollowRequests = async (c: Context) => {
  try {
    const me = c.get("user");
    const requests = await Follow.find({ followee: me.id, status: "pending" })
      .populate("follower", PROFILE_CARD_FIELDS)
      .sort({ createdAt: -1 })
      .limit(100);

    return c.json({ count: requests.length, requests });
  } catch (error) {
    console.error("Error fetching pending follow requests:", error);
    return c.json({ error: "Failed to fetch pending follow requests" }, 500);
  }
};

async function canViewRelationships(
  targetId: string,
  viewerId: string
): Promise<boolean> {
  if (targetId === viewerId) return true;
  const target = await User.findById(targetId).select(
    "settings.privacy blockedUsers"
  );
  if (!target) return false;
  if (await areBlocked(targetId, viewerId)) return false;

  const visibility = getProfileVisibility(target);
  if (visibility === "public") return true;

  const [isFollower, isFriend] = await Promise.all([
    Follow.exists({ follower: viewerId, followee: targetId, status: "accepted" }),
    User.exists({ _id: viewerId, friends: targetId }),
  ]);

  if (visibility === "friends") return !!isFriend;
  if (visibility === "followers") return !!isFollower || !!isFriend;
  return false; // private
}

function parseCursorPage(c: Context) {
  const limit = Math.min(
    Math.max(parseInt(c.req.query("limit") || "30", 10) || 30, 1),
    100
  );
  const cursor = c.req.query("cursor");
  const isValidCursor = cursor && mongoose.Types.ObjectId.isValid(cursor);
  return { limit, cursor: isValidCursor ? cursor : undefined };
}

const LIST_ROW_FIELDS = "name username profilePic verified friends";

/**
 * Shared implementation for getFollowers/getFollowing — the two are
 * identical except which Follow field ("followee" vs "follower") is fixed to
 * the profile being viewed, and which field holds "the other side" of each
 * edge (the row's user). Adds three things the modal needs per row without
 * N+1 queries:
 *   - text search (name/username) scoped to this list, combined with cursor
 *     pagination so search works even on not-yet-loaded pages;
 *   - isFollowedByViewer, via one batched Follow query over the whole page;
 *   - mutualFriendsCount, via one batched set-intersection against the
 *     viewer's own friends (the row's `friends` array is fetched only for
 *     this computation and stripped before the response — never sent raw).
 */
async function listFollowEdge(
  c: Context,
  fixedField: "followee" | "follower",
  otherField: "follower" | "followee",
  responseKey: "followers" | "following",
  privacyErrorMessage: string
) {
  const me = c.get("user");
  const userId = c.req.param("userId");
  if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
    return c.json({ error: "Invalid user ID" }, 400);
  }

  if (!(await canViewRelationships(userId, me.id))) {
    return c.json({ error: privacyErrorMessage }, 403);
  }

  const { limit, cursor } = parseCursorPage(c);
  const q = (c.req.query("q") ?? "").trim();

  const query: any = { [fixedField]: userId, status: "accepted" };
  if (cursor) query._id = { $lt: cursor };

  if (q) {
    const matchingUserIds = await User.find(
      { $or: [{ name: { $regex: q, $options: "i" } }, { username: { $regex: q, $options: "i" } }] },
      "_id"
    ).limit(500);
    query[otherField] = { $in: matchingUserIds.map((u) => u._id) };
  }

  const rows = await Follow.find(query)
    .sort({ _id: -1 })
    .limit(limit + 1)
    .populate(otherField, LIST_ROW_FIELDS);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const users = page.map((r: any) => r[otherField]).filter(Boolean);
  const userIds = users.map((u: any) => u._id.toString());

  const [viewerDoc, viewerFollowingIds] = await Promise.all([
    User.findById(me.id).select("friends"),
    userIds.length
      ? Follow.find({
          follower: me.id,
          followee: { $in: userIds },
          status: "accepted",
        }).distinct("followee")
      : Promise.resolve([]),
  ]);
  const viewerFriendSet = new Set((viewerDoc?.friends ?? []).map((f) => f.toString()));
  const viewerFollowingSet = new Set(viewerFollowingIds.map((id) => id.toString()));

  const enriched = users.map((u: any) => {
    const rowFriendSet = new Set<string>((u.friends ?? []).map((f: any) => f.toString()));
    let mutualFriendsCount = 0;
    for (const f of rowFriendSet) if (viewerFriendSet.has(f)) mutualFriendsCount++;

    return {
      _id: u._id,
      name: u.name,
      username: u.username,
      profilePic: u.profilePic,
      verified: u.verified,
      isFollowedByViewer: viewerFollowingSet.has(u._id.toString()),
      mutualFriendsCount,
    };
  });

  return c.json({
    [responseKey]: enriched,
    nextCursor: hasMore ? page[page.length - 1]._id : null,
  });
}

export const getFollowers = async (c: Context) => {
  try {
    return await listFollowEdge(
      c,
      "followee",
      "follower",
      "followers",
      "This account's followers are private"
    );
  } catch (error) {
    console.error("Error fetching followers:", error);
    return c.json({ error: "Failed to fetch followers" }, 500);
  }
};

export const getFollowing = async (c: Context) => {
  try {
    return await listFollowEdge(
      c,
      "follower",
      "followee",
      "following",
      "This account's following list is private"
    );
  } catch (error) {
    console.error("Error fetching following:", error);
    return c.json({ error: "Failed to fetch following" }, 500);
  }
};

export const getMutualFollowers = async (c: Context) => {
  try {
    const me = c.get("user");
    const userId = c.req.param("userId");
    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
      return c.json({ error: "Invalid user ID" }, 400);
    }
    if (userId === me.id) {
      return c.json({ mutuals: [] });
    }

    if (!(await canViewRelationships(userId, me.id))) {
      return c.json({ error: "This account's followers are private" }, 403);
    }

    // Accounts the viewer follows who also follow the target profile.
    const myFollowing = await Follow.find({
      follower: me.id,
      status: "accepted",
    }).distinct("followee");

    if (myFollowing.length === 0) {
      return c.json({ mutuals: [] });
    }

    const mutuals = await Follow.find({
      followee: userId,
      status: "accepted",
      follower: { $in: myFollowing },
    })
      .limit(50)
      .populate("follower", PROFILE_CARD_FIELDS);

    return c.json({ mutuals: mutuals.map((m) => m.follower) });
  } catch (error) {
    console.error("Error fetching mutual followers:", error);
    return c.json({ error: "Failed to fetch mutual followers" }, 500);
  }
};

export const getFollowStatus = async (c: Context) => {
  try {
    const me = c.get("user");
    const userId = c.req.param("userId");
    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
      return c.json({ error: "Invalid user ID" }, 400);
    }

    if (userId === me.id) {
      return c.json({
        isSelf: true,
        isFollowing: false,
        isFollowedBy: false,
        isPendingOutgoing: false,
        isPendingIncoming: false,
        isMutual: false,
      });
    }

    const [outgoing, incoming] = await Promise.all([
      Follow.findOne({ follower: me.id, followee: userId }).select("status"),
      Follow.findOne({ follower: userId, followee: me.id }).select("status"),
    ]);

    const isFollowing = outgoing?.status === "accepted";
    const isFollowedBy = incoming?.status === "accepted";

    return c.json({
      isSelf: false,
      isFollowing,
      isFollowedBy,
      isPendingOutgoing: outgoing?.status === "pending",
      isPendingIncoming: incoming?.status === "pending",
      isMutual: isFollowing && isFollowedBy,
    });
  } catch (error) {
    console.error("Error fetching follow status:", error);
    return c.json({ error: "Failed to fetch follow status" }, 500);
  }
};

export const getSuggestedCreators = async (c: Context) => {
  try {
    const me = c.get("user");
    const limit = Math.min(
      Math.max(parseInt(c.req.query("limit") || "10", 10) || 10, 1),
      30
    );

    const [meDoc, alreadyRelated, blockedByOthers, allCreatorIds] =
      await Promise.all([
        User.findById(me.id).select("blockedUsers friends"),
        Follow.find({ follower: me.id }).distinct("followee"),
        User.find({ blockedUsers: me.id }, "_id"),
        Reel.distinct("creator_id", { isDeleted: { $ne: true } }),
      ]);

    const excludeIds = new Set<string>([
      me.id,
      ...(meDoc?.blockedUsers ?? []).map((b) => b.toString()),
      ...blockedByOthers.map((u) => u._id.toString()),
      ...alreadyRelated.map((id) => id.toString()),
    ]);
    const friendSet = new Set((meDoc?.friends ?? []).map((f) => f.toString()));

    const candidateIds = allCreatorIds
      .map((id) => id.toString())
      .filter((id) => !excludeIds.has(id));

    if (candidateIds.length === 0) {
      return c.json({ suggestions: [] });
    }

    // Rank by follower count — a simple, dependency-free popularity signal
    // for this REST surface. The richer tag/engagement-based ranking lives
    // in the assistant's suggest_creators tool (services/chat-service).
    const followerCounts = await Follow.aggregate([
      {
        $match: {
          followee: { $in: candidateIds.map((id) => new mongoose.Types.ObjectId(id)) },
          status: "accepted",
        },
      },
      { $group: { _id: "$followee", count: { $sum: 1 } } },
    ]);
    const countMap = new Map<string, number>(
      followerCounts.map((f) => [f._id.toString(), f.count])
    );

    const ranked = candidateIds
      .map((id) => ({ id, count: countMap.get(id) ?? 0 }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);

    const users = await User.find({
      _id: { $in: ranked.map((r) => r.id) },
    }).select("name username profilePic about verified settings.privacy.profileVisibility");
    const userMap = new Map(users.map((u) => [u._id.toString(), u]));

    const suggestions = ranked
      .map((r) => {
        const u = userMap.get(r.id);
        if (!u) return null;
        return {
          ...buildProfileView(u, { viewerId: me.id, isFriend: friendSet.has(r.id) }),
          followerCount: r.count,
        };
      })
      .filter(Boolean);

    return c.json({ suggestions });
  } catch (error) {
    console.error("Error fetching suggested creators:", error);
    return c.json({ error: "Failed to fetch suggested creators" }, 500);
  }
};

export const muteCreator = async (c: Context) => {
  try {
    const me = c.get("user");
    const creatorId = c.req.param("creatorId");
    if (!creatorId || !mongoose.Types.ObjectId.isValid(creatorId)) {
      return c.json({ error: "Invalid user ID" }, 400);
    }
    if (creatorId === me.id) {
      return c.json({ error: "You cannot mute yourself" }, 400);
    }

    await UserReelPreference.findOneAndUpdate(
      { user_id: me.id },
      { $addToSet: { muted_creators: creatorId } },
      { upsert: true }
    );

    await invalidateAfterFollowChange(me.id, creatorId);

    return c.json({ message: "Creator muted", muted: true });
  } catch (error) {
    console.error("Error muting creator:", error);
    return c.json({ error: "Failed to mute creator" }, 500);
  }
};

export const unmuteCreator = async (c: Context) => {
  try {
    const me = c.get("user");
    const creatorId = c.req.param("creatorId");
    if (!creatorId || !mongoose.Types.ObjectId.isValid(creatorId)) {
      return c.json({ error: "Invalid user ID" }, 400);
    }

    await UserReelPreference.findOneAndUpdate(
      { user_id: me.id },
      { $pull: { muted_creators: creatorId } }
    );

    await invalidateAfterFollowChange(me.id, creatorId);

    return c.json({ message: "Creator unmuted", muted: false });
  } catch (error) {
    console.error("Error unmuting creator:", error);
    return c.json({ error: "Failed to unmute creator" }, 500);
  }
};

export const getMuteStatus = async (c: Context) => {
  try {
    const me = c.get("user");
    const creatorId = c.req.param("creatorId");
    if (!creatorId || !mongoose.Types.ObjectId.isValid(creatorId)) {
      return c.json({ error: "Invalid user ID" }, 400);
    }

    const pref = await UserReelPreference.findOne({ user_id: me.id }).select(
      "muted_creators"
    );
    const muted = !!pref?.muted_creators?.some(
      (id) => id.toString() === creatorId
    );

    return c.json({ muted });
  } catch (error) {
    console.error("Error fetching mute status:", error);
    return c.json({ error: "Failed to fetch mute status" }, 500);
  }
};

export { canViewRelationships };
