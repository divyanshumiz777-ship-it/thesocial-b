import { Context } from "hono";
import mongoose from "mongoose";
import Notification from "../models/Notification.ts";
import User from "../models/User.ts";
import { Server } from "socket.io";
import { sendPushToUser } from "../lib/webPush.ts";
import { sendFcmToUser } from "../lib/fcmPush.ts";

interface UserPayload {
  id: string;
  email: string;
}

export const createNotification = async (data: {
  recipient: string;
  sender?: string;
  type: string;
  title: string;
  message: string;
  metadata?: any;
  actionUrl?: string;
}) => {
  try {
    // Part 9: suppress notifications between users with a block relationship
    // (either direction). Central choke point — covers mentions, friend adds,
    // server events, etc.
    if (data.sender && data.recipient && data.sender !== data.recipient) {
      const [recipient, sender] = await Promise.all([
        User.findById(data.recipient).select("blockedUsers"),
        User.findById(data.sender).select("blockedUsers"),
      ]);
      const recipientBlockedSender = recipient?.blockedUsers?.some(
        (u) => u?.toString() === data.sender
      );
      const senderBlockedRecipient = sender?.blockedUsers?.some(
        (u) => u?.toString() === data.recipient
      );
      if (recipientBlockedSender || senderBlockedRecipient) {
        return null;
      }
    }

    const notification = await Notification.create(data);
    const populatedNotification = await Notification.findById(notification._id)
      .populate("sender", "name profilePic")
      .populate("recipient", "name")
      .lean();

    // Fire-and-forget — a push failure (or no subscriptions/VAPID unset)
    // never blocks notification creation; the in-app notification already
    // exists regardless of push delivery. Web and native (FCM) are two
    // independent, equally-optional channels — a user may have subscriptions
    // on either, both, or neither.
    const pushPayload = {
      title: data.title,
      body: data.message,
      actionUrl: data.actionUrl,
      notificationId: notification._id.toString(),
    };
    void sendPushToUser(data.recipient, pushPayload);
    void sendFcmToUser(data.recipient, pushPayload);

    return populatedNotification;
  } catch (error) {
    console.error("Error creating notification:", error);
    return null;
  }
};

export const getNotifications = async (
  c: Context<{ Variables: { user: UserPayload } }>
) => {
  const user = c.get("user");
  const page = parseInt(c.req.query("page") || "1", 10);
  const limit = parseInt(c.req.query("limit") || "20", 10);
  const unreadOnly = c.req.query("unreadOnly") === "true";

  try {
    const query: any = { recipient: user.id };
    if (unreadOnly) {
      query.read = false;
    }

    const skip = (page - 1) * limit;

    const [notifications, total, unreadCount] = await Promise.all([
      Notification.find(query)
        .populate("sender", "name profilePic")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Notification.countDocuments(query),
      Notification.countDocuments({ recipient: user.id, read: false }),
    ]);

    return c.json(
      {
        notifications,
        pagination: {
          currentPage: page,
          totalPages: Math.ceil(total / limit),
          totalNotifications: total,
          unreadCount,
        },
      },
      200
    );
  } catch (error) {
    console.error("Error fetching notifications:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const getUnreadCount = async (
  c: Context<{ Variables: { user: UserPayload } }>
) => {
  const user = c.get("user");

  try {
    const unreadCount = await Notification.countDocuments({
      recipient: user.id,
      read: false,
    });

    return c.json({ unreadCount }, 200);
  } catch (error) {
    console.error("Error fetching unread count:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const markAsRead = async (
  c: Context<{ Variables: { user: UserPayload } }>
) => {
  const user = c.get("user");
  const { notificationId } = c.req.param();

  if (!mongoose.Types.ObjectId.isValid(notificationId)) {
    return c.json({ error: "Invalid notification ID format" }, 400);
  }

  try {
    const notification = await Notification.findOneAndUpdate(
      { _id: notificationId, recipient: user.id },
      { read: true },
      { new: true }
    ).populate("sender", "name profilePic");

    if (!notification) {
      return c.json({ error: "Notification not found" }, 404);
    }

    return c.json({ notification }, 200);
  } catch (error) {
    console.error("Error marking notification as read:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const markAllAsRead = async (
  c: Context<{ Variables: { user: UserPayload } }>
) => {
  const user = c.get("user");

  try {
    await Notification.updateMany(
      { recipient: user.id, read: false },
      { read: true }
    );

    return c.json({ message: "All notifications marked as read" }, 200);
  } catch (error) {
    console.error("Error marking all notifications as read:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const deleteNotification = async (
  c: Context<{ Variables: { user: UserPayload } }>
) => {
  const user = c.get("user");
  const { notificationId } = c.req.param();

  if (!mongoose.Types.ObjectId.isValid(notificationId)) {
    return c.json({ error: "Invalid notification ID format" }, 400);
  }

  try {
    const notification = await Notification.findOneAndDelete({
      _id: notificationId,
      recipient: user.id,
    });

    if (!notification) {
      return c.json({ error: "Notification not found" }, 404);
    }

    return c.json({ message: "Notification deleted successfully" }, 200);
  } catch (error) {
    console.error("Error deleting notification:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const deleteAllRead = async (
  c: Context<{ Variables: { user: UserPayload } }>
) => {
  const user = c.get("user");

  try {
    const result = await Notification.deleteMany({
      recipient: user.id,
      read: true,
    });

    return c.json(
      {
        message: "All read notifications deleted",
        deletedCount: result.deletedCount,
      },
      200
    );
  } catch (error) {
    console.error("Error deleting read notifications:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const sendNotificationViaSocket = (
  io: Server | undefined,
  recipientId: string,
  notification: any
) => {
  if (io) {
    io.to(recipientId).emit("notification", notification);
  }
};
