import { Hono } from "hono";
import {
  getNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  deleteNotification,
  deleteAllRead,
} from "../controllers/notificationController.ts";
import { authMiddleware } from "../middleware/authMiddleware.ts";

export const notificationRouter = new Hono();

notificationRouter.get("/", authMiddleware, getNotifications);
notificationRouter.get("/unread-count", authMiddleware, getUnreadCount);
notificationRouter.put("/:notificationId/read", authMiddleware, markAsRead);
notificationRouter.put("/mark-all-read", authMiddleware, markAllAsRead);
notificationRouter.delete("/clear-read", authMiddleware, deleteAllRead);
notificationRouter.delete(
  "/:notificationId",
  authMiddleware,
  deleteNotification
);
