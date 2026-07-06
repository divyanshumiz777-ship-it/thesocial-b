import { Context } from "hono";
import User from "../models/User.ts";
import DiscordServer from "../models/DiscordServer.ts";
import Message from "../models/Message.ts";
import { Reel } from "../models/Reel.ts";
import Group from "../models/Group.ts";
import UserReport from "../models/UserReport.ts";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export const getAdminStats = async (c: Context) => {
  try {
    const sevenDaysAgo = new Date(Date.now() - SEVEN_DAYS_MS);

    const [
      totalUsers,
      newUsersLast7Days,
      totalServers,
      totalMessages,
      totalReels,
      totalGroups,
      pendingReports,
      totalReports,
    ] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ createdAt: { $gte: sevenDaysAgo } }),
      DiscordServer.countDocuments(),
      Message.countDocuments(),
      Reel.countDocuments({ isDeleted: false }),
      Group.countDocuments({ isGroupDM: true }),
      UserReport.countDocuments({ status: "pending" }),
      UserReport.countDocuments(),
    ]);

    return c.json({
      users: { total: totalUsers, newLast7Days: newUsersLast7Days },
      servers: { total: totalServers },
      messages: { total: totalMessages },
      reels: { total: totalReels },
      groups: { total: totalGroups },
      reports: { pending: pendingReports, total: totalReports },
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error fetching admin stats:", error);
    return c.json({ error: "Failed to fetch admin stats" }, 500);
  }
};

export const getAdminReports = async (c: Context) => {
  try {
    const status = c.req.query("status") || "pending";
    const limit = Math.min(
      Math.max(parseInt(c.req.query("limit") || "10", 10) || 10, 1),
      50,
    );

    const reports = await UserReport.find({ status })
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate("reporter", "name email")
      .populate("reportedUser", "name email")
      .lean();

    return c.json({ reports, status, count: reports.length });
  } catch (error) {
    console.error("Error fetching admin reports:", error);
    return c.json({ error: "Failed to fetch reports" }, 500);
  }
};
