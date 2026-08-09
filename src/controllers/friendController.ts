import { Context } from "hono";
import User from "../models/User.ts";
import FriendRequest from "../models/FriendRequest.ts";
import Conversation from "../models/Conversation.ts";
import FriendNickname from "../models/FriendNickname.ts";
import Follow from "../models/Follow.ts";
import { Reel } from "../models/Reel.ts";
import mongoose from "mongoose";
import { getIoInstance } from "../config/socket.ts";
import {
  buildProfileView,
  getProfileVisibility,
} from "../lib/profilePrivacy.ts";
import { canViewRelationships } from "./followController.ts";
import {
  createNotification,
  sendNotificationViaSocket,
} from "./notificationController.ts";
import { isFriendRequestBlocked } from "../lib/serverPrivacy.ts";

export const sendFriendRequest = async (c: Context) => {
  try {
    const user = c.get("user");
    const senderId = user.id;
    const { receiverId } = await c.req.json();

    if (!receiverId) {
      return c.json({ error: "Receiver ID is required" }, 400);
    }

    if (senderId === receiverId) {
      return c.json({ error: "Cannot send friend request to yourself" }, 400);
    }

    const receiver = await User.findById(receiverId);
    if (!receiver) {
      return c.json({ error: "User not found" }, 404);
    }

    const isFriend = await User.findOne({
      _id: senderId,
      friends: receiverId,
    });

    if (isFriend) {
      return c.json({ error: "Already friends with this user" }, 400);
    }

    if (await isFriendRequestBlocked(senderId, receiverId)) {
      return c.json(
        {
          error:
            "This user has disabled friend requests from members of a community you share.",
        },
        403
      );
    }

    const existingRequest = await FriendRequest.findOne({
      $or: [
        { sender: senderId, receiver: receiverId },
        { sender: receiverId, receiver: senderId },
      ],
    });

    if (existingRequest) {
      if (existingRequest.status === "pending") {
        await existingRequest.populate([
          { path: "sender", select: "name profilePic email" },
          { path: "receiver", select: "name profilePic email" },
        ]);
        return c.json(
          {
            error: "Friend request already exists",
            friendRequest: existingRequest,
          },
          400
        );
      }

      existingRequest.sender = new mongoose.Types.ObjectId(senderId);
      existingRequest.receiver = new mongoose.Types.ObjectId(receiverId);
      existingRequest.status = "pending";
      existingRequest.createdAt = new Date();
      await existingRequest.save();

      await existingRequest.populate([
        { path: "sender", select: "name profilePic email" },
        { path: "receiver", select: "name profilePic email" },
      ]);

      const io = getIoInstance();
      io.to(receiverId).emit("friend_request_received", {
        friendRequest: existingRequest.toObject(),
      });

      // Same gap DMs already had (see dmController.ts's createDm) — the
      // socket emit above only reaches an open, connected tab; a
      // backgrounded/closed app got nothing. This is what actually
      // triggers a push via notificationController's sendPushToUser.
      const resentSenderName =
        (existingRequest.sender as any)?.name || "Someone";
      const resentNotification = await createNotification({
        recipient: receiverId,
        sender: senderId,
        type: "friend_request",
        title: "New friend request",
        message: `${resentSenderName} sent you a friend request`,
        metadata: { friendRequestId: existingRequest._id.toString() },
        actionUrl: `/profile/${senderId}`,
      });
      if (resentNotification) {
        sendNotificationViaSocket(io, receiverId, resentNotification);
      }

      return c.json(
        {
          message: "Friend request sent",
          friendRequest: existingRequest,
        },
        201
      );
    }

    const friendRequest = new FriendRequest({
      sender: senderId,
      receiver: receiverId,
      status: "pending",
    });

    await friendRequest.save();

    await friendRequest.populate([
      { path: "sender", select: "name profilePic email" },
      { path: "receiver", select: "name profilePic email" },
    ]);

    const io = getIoInstance();
    io.to(receiverId).emit("friend_request_received", {
      friendRequest: friendRequest.toObject(),
    });

    // See the resend branch above — same push-delivery gap DMs already had.
    const newSenderName = (friendRequest.sender as any)?.name || "Someone";
    const newNotification = await createNotification({
      recipient: receiverId,
      sender: senderId,
      type: "friend_request",
      title: "New friend request",
      message: `${newSenderName} sent you a friend request`,
      metadata: { friendRequestId: friendRequest._id.toString() },
      actionUrl: `/profile/${senderId}`,
    });
    if (newNotification) {
      sendNotificationViaSocket(io, receiverId, newNotification);
    }

    return c.json(
      {
        message: "Friend request sent",
        friendRequest,
      },
      201
    );
  } catch (error: any) {
    console.error("Error sending friend request:", error);

    if (error.code === 11000) {
      return c.json(
        {
          error: "Friend request already exists. Please refresh and try again.",
        },
        400
      );
    }

    return c.json({ error: "Failed to send friend request" }, 500);
  }
};

export const getPendingRequests = async (c: Context) => {
  try {
    const user = c.get("user");
    const userId = user.id;

    const requests = await FriendRequest.find({
      receiver: userId,
      status: "pending",
    })
      .populate("sender", "name profilePic email lastSeen")
      .sort({ createdAt: -1 })
      .limit(50);

    return c.json(requests);
  } catch (error) {
    console.error("Error fetching pending requests:", error);
    return c.json({ error: "Failed to fetch pending requests" }, 500);
  }
};

export const getSentRequests = async (c: Context) => {
  try {
    const user = c.get("user");
    const userId = user.id;

    const requests = await FriendRequest.find({
      sender: userId,
      status: "pending",
    })
      .populate("receiver", "name profilePic email lastSeen")
      .sort({ createdAt: -1 })
      .limit(50);

    return c.json(requests);
  } catch (error) {
    console.error("Error fetching sent requests:", error);
    return c.json({ error: "Failed to fetch sent requests" }, 500);
  }
};
export const acceptFriendRequest = async (c: Context) => {
  try {
    const requestId = c.req.param("requestId");
    const user = c.get("user");
    const userId = user.id;

    const friendRequest = await FriendRequest.findById(requestId);

    if (!friendRequest) {
      return c.json({ error: "Friend request not found" }, 404);
    }

    if (friendRequest.receiver.toString() !== userId) {
      return c.json({ error: "Unauthorized" }, 403);
    }

    if (friendRequest.status !== "pending") {
      return c.json(
        { error: `Friend request is already ${friendRequest.status}` },
        400
      );
    }

    friendRequest.status = "accepted";
    await friendRequest.save();

    await User.findByIdAndUpdate(friendRequest.sender, {
      $addToSet: { friends: friendRequest.receiver },
    });

    await User.findByIdAndUpdate(friendRequest.receiver, {
      $addToSet: { friends: friendRequest.sender },
    });

    await friendRequest.populate([
      { path: "sender", select: "name profilePic email" },
      { path: "receiver", select: "name profilePic email" },
    ]);

    const sender = await User.findById(friendRequest.sender).select(
      "name profilePic email lastSeen"
    );
    const receiver = await User.findById(friendRequest.receiver).select(
      "name profilePic email lastSeen"
    );

    const io = getIoInstance();

    io.to(userId).emit("friend_request_accepted", {
      friendRequest: friendRequest.toObject(),
      newFriend: sender,
    });

    io.to(friendRequest.sender.toString()).emit("friend_request_accepted", {
      friendRequest: friendRequest.toObject(),
      newFriend: receiver,
    });

    // Only the original sender gets notified — the acceptor just performed
    // the action themselves, so the emit to `userId` above is multi-device
    // sync only, not something they need pushed to them. Same push-delivery
    // gap DMs already had (see dmController.ts's createDm).
    const accepterName = receiver?.name || "Someone";
    const acceptNotification = await createNotification({
      recipient: friendRequest.sender.toString(),
      sender: userId,
      type: "friend_accepted",
      title: "Friend request accepted",
      message: `${accepterName} accepted your friend request`,
      metadata: { friendRequestId: friendRequest._id.toString() },
      actionUrl: `/profile/${userId}`,
    });
    if (acceptNotification) {
      sendNotificationViaSocket(
        io,
        friendRequest.sender.toString(),
        acceptNotification
      );
    }

    return c.json({
      message: "Friend request accepted",
      friendRequest,
      newFriend: sender,
    });
  } catch (error) {
    console.error("Error accepting friend request:", error);
    return c.json({ error: "Failed to accept friend request" }, 500);
  }
};

export const rejectFriendRequest = async (c: Context) => {
  try {
    const requestId = c.req.param("requestId");
    const user = c.get("user");
    const userId = user.id;

    const friendRequest = await FriendRequest.findById(requestId);

    if (!friendRequest) {
      return c.json({ error: "Friend request not found" }, 404);
    }

    if (friendRequest.receiver.toString() !== userId) {
      return c.json({ error: "Unauthorized" }, 403);
    }

    if (friendRequest.status !== "pending") {
      return c.json(
        { error: `Friend request is already ${friendRequest.status}` },
        400
      );
    }

    friendRequest.status = "rejected";
    await friendRequest.save();

    await friendRequest.populate([
      { path: "sender", select: "name profilePic email" },
      { path: "receiver", select: "name profilePic email" },
    ]);

    const io = getIoInstance();
    io.to(friendRequest.sender.toString()).emit("friend_request_rejected", {
      friendRequest: friendRequest.toObject(),
    });

    return c.json({
      message: "Friend request rejected",
      friendRequest,
    });
  } catch (error) {
    console.error("Error rejecting friend request:", error);
    return c.json({ error: "Failed to reject friend request" }, 500);
  }
};

export const getFriendsList = async (c: Context) => {
  try {
    const user = c.get("user");
    const userId = user.id;

    const userDoc = await User.findById(userId).populate(
      "friends",
      "name profilePic email lastSeen"
    );

    if (!userDoc) {
      return c.json({ error: "User not found" }, 404);
    }

    const friends = userDoc.friends || [];

    return c.json({
      count: friends.length,
      friends,
    });
  } catch (error) {
    console.error("Error fetching friends list:", error);
    return c.json({ error: "Failed to fetch friends list" }, 500);
  }
};

export const getOnlineFriends = async (c: Context) => {
  try {
    const user = c.get("user");
    const userId = user.id;

    const userDoc = await User.findById(userId).populate(
      "friends",
      "name profilePic email lastSeen"
    );

    if (!userDoc) {
      return c.json({ error: "User not found" }, 404);
    }

    const now = new Date();
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60000);

    const onlineFriends = (userDoc.friends || []).filter((friend: any) => {
      return new Date(friend.lastSeen) > fiveMinutesAgo;
    });

    return c.json({
      count: onlineFriends.length,
      friends: onlineFriends,
    });
  } catch (error) {
    console.error("Error fetching online friends:", error);
    return c.json({ error: "Failed to fetch online friends" }, 500);
  }
};

export const removeFriend = async (c: Context) => {
  try {
    const user = c.get("user");
    const userId = user.id;
    const friendId = c.req.param("friendId");

    if (!friendId || !mongoose.Types.ObjectId.isValid(friendId)) {
      return c.json({ error: "Invalid friend ID" }, 400);
    }

    // The remover chooses what happens to their conversation:
    // keep (default) = stays but messaging is disabled (createDm enforces the
    // friends-only rule) · delete = remove from the remover's side.
    const body = (await c.req.json().catch(() => ({}))) as {
      conversationAction?: "keep" | "delete";
    };
    const conversationAction =
      body.conversationAction === "delete" ? "delete" : "keep";

    await User.findByIdAndUpdate(userId, {
      $pull: { friends: friendId },
    });

    await User.findByIdAndUpdate(friendId, {
      $pull: { friends: userId },
    });

    const io = getIoInstance();

    let removedConversationId: string | null = null;
    if (conversationAction === "delete") {
      const conversation = await Conversation.findOne({
        participants: { $all: [userId, friendId], $size: 2 },
      });
      if (conversation) {
        conversation.deletedFor = (conversation.deletedFor ?? []).filter(
          (u) => u !== null && u !== undefined
        );
        if (!conversation.deletedFor.some((u) => u?.toString() === userId)) {
          conversation.deletedFor.push(new mongoose.Types.ObjectId(userId));
        }
        if (!conversation.deletedAt) conversation.deletedAt = new Map();
        conversation.deletedAt.set(userId, new Date());
        await conversation.save();
        removedConversationId = conversation._id.toString();
      }
    }

    io.to(userId).emit("friend_removed", {
      friendId,
    });

    io.to(friendId).emit("friend_removed", {
      friendId: userId,
    });

    if (removedConversationId) {
      io.to(userId).emit("conversation:removed", {
        conversationId: removedConversationId,
      });
    }

    return c.json({
      message: "Friend removed successfully",
      conversationAction,
    });
  } catch (error) {
    console.error("Error removing friend:", error);
    return c.json({ error: "Failed to remove friend" }, 500);
  }
};

export const getUserProfile = async (c: Context) => {
  try {
    const userId = c.req.param("userId");
    const user = c.get("user");
    const currentUserId = user.id;

    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
      return c.json({ error: "Invalid user ID" }, 400);
    }

    const userProfile = await User.findById(userId).select(
      "name email profilePic lastSeen about customStatus settings"
    );

    if (!userProfile) {
      return c.json({ error: "User not found" }, 404);
    }

    const currentUser = await User.findById(currentUserId);
    const isFriend = !!currentUser?.friends?.includes(
      new mongoose.Types.ObjectId(userId)
    );
    const isFollower = !!(await Follow.exists({
      follower: currentUserId,
      followee: userId,
      status: "accepted",
    }));

    const pendingRequest = await FriendRequest.findOne({
      $or: [
        { sender: currentUserId, receiver: userId },
        { sender: userId, receiver: currentUserId },
      ],
      status: "pending",
    });

    const view = buildProfileView(userProfile, {
      viewerId: currentUserId,
      isFriend,
      isFollower,
    });

    return c.json({
      user: view,
      isFriend,
      restricted: view.restricted,
      visibility: getProfileVisibility(userProfile),
      pendingRequest: pendingRequest
        ? {
            id: pendingRequest._id,
            status: pendingRequest.status,
            direction:
              pendingRequest.sender.toString() === currentUserId
                ? "sent"
                : "received",
          }
        : null,
    });
  } catch (error) {
    console.error("Error fetching user profile:", error);
    return c.json({ error: "Failed to fetch user profile" }, 500);
  }
};

export const searchUsers = async (c: Context) => {
  try {
    const query = c.req.query("q");
    const onlyCreators = c.req.query("onlyCreators") === "true";
    const user = c.get("user");
    const currentUserId = user.id;

    if (!query || query.trim().length === 0) {
      return c.json({ error: "Search query is required" }, 400);
    }

    const currentUser = await User.findById(currentUserId).select(
      "friends blockedUsers"
    );
    const friendIds = new Set(
      (currentUser?.friends ?? []).map((f) => f.toString())
    );
    const myBlocked = (currentUser?.blockedUsers ?? []).map((b) =>
      b.toString()
    );

    // Part 9: blocked users (either direction) must not be findable/addable.
    // Text index covers name/username/email/about (weighted), so "creator
    // search by bio/topic" and @username search both land here.
    const users = await User.find(
      {
        $text: { $search: query },
        _id: { $ne: currentUserId, $nin: myBlocked },
        blockedUsers: { $ne: currentUserId },
      },
      { score: { $meta: "textScore" } }
    )
      .sort({ score: { $meta: "textScore" } })
      .select("name username email profilePic lastSeen about verified customStatus settings")
      .limit(onlyCreators ? 60 : 20);

    const creatorIds = new Set(
      (
        await Reel.distinct("creator_id", {
          creator_id: { $in: users.map((u) => u._id) },
          isDeleted: { $ne: true },
        })
      ).map((id) => id.toString())
    );

    const filteredUsers = onlyCreators
      ? users.filter((u) => creatorIds.has(u._id.toString())).slice(0, 20)
      : users;

    const myFollowingIds = new Set(
      (
        await Follow.find({
          follower: currentUserId,
          followee: { $in: filteredUsers.map((u) => u._id) },
          status: "accepted",
        }).distinct("followee")
      ).map((id) => id.toString())
    );

    // Respect each result's profile visibility. Restricted users still appear
    // (identity only) so they remain findable for friend requests.
    const view = filteredUsers.map((u) => ({
      ...buildProfileView(u, {
        viewerId: currentUserId,
        isFriend: friendIds.has(u._id.toString()),
        isFollower: myFollowingIds.has(u._id.toString()),
      }),
      isCreator: creatorIds.has(u._id.toString()),
    }));

    return c.json({
      count: view.length,
      users: view,
    });
  } catch (error) {
    console.error("Error searching users:", error);
    return c.json({ error: "Failed to search users" }, 500);
  }
};

export const getNicknames = async (c: Context) => {
  try {
    const user = c.get("user");
    const nicknames = await FriendNickname.find({ owner: user.id }).lean();
    return c.json({
      nicknames: nicknames.map((n) => ({
        friendId: n.friend.toString(),
        nickname: n.nickname,
      })),
    });
  } catch {
    return c.json({ error: "Failed to fetch nicknames" }, 500);
  }
};

export const setNickname = async (c: Context) => {
  try {
    const user = c.get("user");
    const friendId = c.req.param("friendId") ?? "";
    const body = await c.req.json();
    const nickname = body?.nickname?.trim();

    if (!nickname) return c.json({ error: "Nickname is required" }, 400);
    if (nickname.length > 32)
      return c.json({ error: "Nickname too long (max 32 chars)" }, 400);
    if (!friendId || !mongoose.Types.ObjectId.isValid(friendId))
      return c.json({ error: "Invalid friend ID" }, 400);

    const doc = await FriendNickname.findOneAndUpdate(
      { owner: user.id, friend: friendId },
      { nickname },
      { upsert: true, new: true }
    );

    // Only the owner's own other tabs/devices should see this — a nickname
    // is a private, viewer-only label, never visible to the friend it's
    // set on. Every socket this user opens joins their own user.id room
    // (server.ts), so targeting it reaches all of them and nobody else.
    const io = getIoInstance();
    io.to(user.id).emit("friend:nickname-updated", { friendId, nickname: doc.nickname });

    return c.json({ friendId, nickname: doc.nickname });
  } catch {
    return c.json({ error: "Failed to set nickname" }, 500);
  }
};

export const removeNickname = async (c: Context) => {
  try {
    const user = c.get("user");
    const friendId = c.req.param("friendId") ?? "";
    if (!friendId || !mongoose.Types.ObjectId.isValid(friendId))
      return c.json({ error: "Invalid friend ID" }, 400);
    await FriendNickname.deleteOne({ owner: user.id, friend: friendId });

    const io = getIoInstance();
    io.to(user.id).emit("friend:nickname-updated", { friendId, nickname: null });

    return c.json({ success: true });
  } catch {
    return c.json({ error: "Failed to remove nickname" }, 500);
  }
};

/** View another user's friends — the "View Friends" profile action.
 * Privacy-gated the same way as followers/following/reels. Excludes any
 * friend with a block relationship (either direction) with the viewer,
 * matching how the codebase already treats blocking as an absolute
 * boundary everywhere else (searchUsers, getAllUsers, community members). */
export const getUserFriendsList = async (c: Context) => {
  try {
    const targetId = c.req.param("userId");
    const viewer = c.get("user");
    if (!targetId || !mongoose.Types.ObjectId.isValid(targetId)) {
      return c.json({ error: "Invalid user ID" }, 400);
    }

    if (!(await canViewRelationships(targetId, viewer.id))) {
      return c.json({ error: "This account's friends are private" }, 403);
    }

    const target = await User.findById(targetId).select("friends");
    if (!target) {
      return c.json({ error: "User not found" }, 404);
    }

    const viewerDoc = await User.findById(viewer.id).select("blockedUsers");
    const viewerBlocked = new Set(
      (viewerDoc?.blockedUsers ?? []).map((b) => b.toString())
    );
    const friendIds = (target.friends ?? []).filter(
      (id) => !viewerBlocked.has(id.toString())
    );

    const friends = await User.find({
      _id: { $in: friendIds },
      blockedUsers: { $ne: viewer.id }, // exclude friends who blocked the viewer
    }).select("name username profilePic about verified");

    return c.json({ friends });
  } catch (error) {
    console.error("Error fetching user friends list:", error);
    return c.json({ error: "Failed to fetch friends list" }, 500);
  }
};
