import { Context } from "hono";
import User from "../models/User.ts";
import FriendRequest from "../models/FriendRequest.ts";
import mongoose from "mongoose";
import { getIoInstance } from "../config/socket.ts";

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

    await User.findByIdAndUpdate(userId, {
      $pull: { friends: friendId },
    });

    await User.findByIdAndUpdate(friendId, {
      $pull: { friends: userId },
    });

    const io = getIoInstance();

    io.to(userId).emit("friend_removed", {
      friendId,
    });

    io.to(friendId).emit("friend_removed", {
      friendId: userId,
    });

    return c.json({
      message: "Friend removed successfully",
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
      "name email profilePic lastSeen friends"
    );

    if (!userProfile) {
      return c.json({ error: "User not found" }, 404);
    }

    const currentUser = await User.findById(currentUserId);
    const isFriend = currentUser?.friends?.includes(
      new mongoose.Types.ObjectId(userId)
    );

    const pendingRequest = await FriendRequest.findOne({
      $or: [
        { sender: currentUserId, receiver: userId },
        { sender: userId, receiver: currentUserId },
      ],
      status: "pending",
    });

    return c.json({
      user: userProfile,
      isFriend: !!isFriend,
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
    const user = c.get("user");
    const currentUserId = user.id;

    if (!query || query.trim().length === 0) {
      return c.json({ error: "Search query is required" }, 400);
    }

    const users = await User.find(
      {
        $text: { $search: query },
        _id: { $ne: currentUserId },
      },
      { score: { $meta: "textScore" } }
    )
      .sort({ score: { $meta: "textScore" } })
      .select("name email profilePic lastSeen")
      .limit(20);

    return c.json({
      count: users.length,
      users,
    });
  } catch (error) {
    console.error("Error searching users:", error);
    return c.json({ error: "Failed to search users" }, 500);
  }
};
