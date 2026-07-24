import { Context } from "hono";
import type { Server } from "socket.io";
import mongoose from "mongoose";
import User from "../models/User.ts";
import DiscordServer from "../models/DiscordServer.ts";
import Message from "../models/Message.ts";
import { Reel } from "../models/Reel.ts";
import Group from "../models/Group.ts";
import UserReport from "../models/UserReport.ts";
import ServerMember from "../models/ServerMember.ts";
import AuditLog from "../models/AuditLog.ts";
import Appeal from "../models/Appeal.ts";
import { applyBan, applyMute } from "../lib/moderationActions.ts";
import { createNotification, sendNotificationViaSocket } from "./notificationController.ts";

const REPORT_MUTE_DURATION_MS = 24 * 60 * 60 * 1000; // 24h — a fixed, conservative default for a report-driven mute; server moderators can still apply a custom duration through the existing per-server mute route.

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

// Daily time-series for the dashboard's growth/activity charts — one point
// per calendar day (UTC) for the requested window, gaps filled with 0 rather
// than omitted so the chart never silently drops a quiet day into a missing
// x-axis tick.
export const getAdminAnalytics = async (c: Context) => {
  try {
    const days = Math.min(Math.max(parseInt(c.req.query("days") || "30", 10) || 30, 7), 90);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const dayFormat = { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "UTC" } };

    const [userRows, messageRows, serverRows] = await Promise.all([
      User.aggregate([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: dayFormat, count: { $sum: 1 } } },
      ]),
      Message.aggregate([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: dayFormat, count: { $sum: 1 } } },
      ]),
      DiscordServer.aggregate([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: dayFormat, count: { $sum: 1 } } },
      ]),
    ]);

    const toMap = (rows: { _id: string; count: number }[]) =>
      new Map(rows.map((r) => [r._id, r.count]));
    const userMap = toMap(userRows);
    const messageMap = toMap(messageRows);
    const serverMap = toMap(serverRows);

    const series: { date: string; newUsers: number; newMessages: number; newServers: number }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      const key = d.toISOString().slice(0, 10);
      series.push({
        date: key,
        newUsers: userMap.get(key) ?? 0,
        newMessages: messageMap.get(key) ?? 0,
        newServers: serverMap.get(key) ?? 0,
      });
    }

    return c.json({ series, days });
  } catch (error) {
    console.error("Error fetching admin analytics:", error);
    return c.json({ error: "Failed to fetch admin analytics" }, 500);
  }
};

// Paginated, searchable user directory for the admin dashboard's Users tab.
export const getAdminUsers = async (c: Context) => {
  try {
    const page = Math.max(parseInt(c.req.query("page") || "1", 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(c.req.query("limit") || "20", 10) || 20, 1), 100);
    const q = (c.req.query("q") || "").trim();

    const filter: Record<string, unknown> = q
      ? {
          $or: [
            { name: { $regex: q, $options: "i" } },
            { email: { $regex: q, $options: "i" } },
          ],
        }
      : {};

    const [total, users] = await Promise.all([
      User.countDocuments(filter),
      User.find(filter)
        .select("name email profilePic verified createdAt lastSeen servers")
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
    ]);

    return c.json({
      users: users.map((u) => ({
        _id: u._id,
        name: u.name,
        email: u.email,
        profilePic: u.profilePic ?? "",
        verified: !!u.verified,
        createdAt: u.createdAt,
        lastSeen: u.lastSeen,
        serverCount: Array.isArray(u.servers) ? u.servers.length : 0,
      })),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (error) {
    console.error("Error fetching admin users:", error);
    return c.json({ error: "Failed to fetch users" }, 500);
  }
};

// Paginated, searchable community directory for the admin dashboard's
// Communities tab — unlike serverController.searchServers (which only ever
// surfaces public/search-opted-in servers to a regular member), this sees
// every server on the platform regardless of visibility/privacy settings,
// since requireAdmin already gates the whole router.
export const getAdminServers = async (c: Context) => {
  try {
    const page = Math.max(parseInt(c.req.query("page") || "1", 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(c.req.query("limit") || "20", 10) || 20, 1), 100);
    const q = (c.req.query("q") || "").trim();

    const filter: Record<string, unknown> = q
      ? { name: { $regex: q, $options: "i" } }
      : {};

    const [total, servers] = await Promise.all([
      DiscordServer.countDocuments(filter),
      DiscordServer.find(filter)
        .select("name description imageUrl visibility members channels onlineCount owner createdAt")
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("owner", "name email")
        .lean(),
    ]);

    return c.json({
      servers: servers.map((s: any) => ({
        _id: s._id,
        name: s.name,
        description: s.description ?? "",
        imageUrl: s.imageUrl ?? "",
        visibility: s.visibility,
        memberCount: Array.isArray(s.members) ? s.members.length : 0,
        channelCount: Array.isArray(s.channels) ? s.channels.length : 0,
        onlineCount: s.onlineCount ?? 0,
        owner: s.owner ? { _id: s.owner._id, name: s.owner.name, email: s.owner.email } : null,
        createdAt: s.createdAt,
      })),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (error) {
    console.error("Error fetching admin servers:", error);
    return c.json({ error: "Failed to fetch servers" }, 500);
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
      // Highest-severity, untriaged-last — a queue with zero severity signal
      // was the whole problem this bridges; sort so "high" surfaces first
      // without hiding reports triage never got to (missing sorts last via
      // the $ifNull-style fallback below).
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate("reporter", "name email")
      .populate("reportedUser", "name email")
      .lean();

    const severityRank: Record<string, number> = { high: 0, medium: 1, low: 2 };
    reports.sort((a, b) => {
      const ra = a.triage ? severityRank[a.triage.severity] ?? 3 : 3;
      const rb = b.triage ? severityRank[b.triage.severity] ?? 3 : 3;
      return ra - rb;
    });

    return c.json({ reports, status, count: reports.length });
  } catch (error) {
    console.error("Error fetching admin reports:", error);
    return c.json({ error: "Failed to fetch reports" }, 500);
  }
};

// Servers the reportedUser currently belongs to — lets the admin pick which
// one to act in without guessing (a report itself doesn't always know which
// shared server the incident happened in, e.g. a profile-page report).
export const getServersForReportedUser = async (c: Context) => {
  try {
    const userId = c.req.param("userId");
    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
      return c.json({ error: "Invalid user ID" }, 400);
    }
    const memberships = await ServerMember.find({ user: userId })
      .populate("server", "name")
      .lean();
    const servers = memberships
      .filter((m) => m.server)
      .map((m: any) => ({ id: m.server._id, name: m.server.name }));
    return c.json({ servers });
  } catch (error) {
    console.error("Error fetching servers for reported user:", error);
    return c.json({ error: "Failed to fetch servers" }, 500);
  }
};

// The Report-to-Action bridge: every report used to sit in "pending" forever
// because nothing connected it to the ban/mute machinery that already fully
// works. A human admin still makes every call here — this only wires the
// button up. Bypasses per-server checkPermission on purpose: platform-admin
// authority (already verified by requireAdmin/adminRoutes.ts) is broader
// than any single server's role system, and the admin acting on a report
// isn't necessarily a member/moderator of the server the incident happened in.
export const resolveReport = async (c: Context) => {
  try {
    const admin = c.get("user");
    const reportId = c.req.param("reportId");
    const io: Server = c.get("io");
    const body = await c.req.json().catch(() => ({}));
    const { action, serverId } = body as { action?: string; server?: string; serverId?: string };

    if (!reportId || !mongoose.Types.ObjectId.isValid(reportId)) {
      return c.json({ error: "Invalid report ID" }, 400);
    }
    if (!action || !["ban", "mute", "dismiss"].includes(action)) {
      return c.json({ error: "action must be ban, mute, or dismiss" }, 400);
    }

    const report = await UserReport.findById(reportId);
    if (!report) return c.json({ error: "Report not found" }, 404);
    if (report.status !== "pending") {
      return c.json({ error: "Report has already been resolved" }, 400);
    }

    if (action === "dismiss") {
      report.status = "dismissed";
      report.resolution = { action: "dismiss", resolvedBy: admin.id, resolvedAt: new Date() };
      await report.save();
      return c.json({ message: "Report dismissed" });
    }

    if (!serverId || !mongoose.Types.ObjectId.isValid(serverId)) {
      return c.json({ error: "serverId is required for ban/mute" }, 400);
    }
    const reportedUserId = report.reportedUser.toString();
    const isMember = await ServerMember.exists({ server: serverId, user: reportedUserId });
    if (!isMember) {
      return c.json({ error: "Reported user is not a member of that server" }, 400);
    }

    const reason = `Report resolution (${report.reason}): ${report.details || "no additional details"}`.slice(0, 500);
    let expiresAt: Date | undefined;
    if (action === "ban") {
      await applyBan(serverId, reportedUserId, reason, admin.id, io);
    } else {
      expiresAt = await applyMute(serverId, reportedUserId, reason, REPORT_MUTE_DURATION_MS, admin.id, io);
    }

    const auditLog = await AuditLog.create({
      server: serverId,
      action: action === "ban" ? "report_resolved_ban" : "report_resolved_mute",
      performedBy: admin.id,
      targetUser: reportedUserId,
      details: `Resolved report ${reportId}: ${report.reason}`,
    });

    report.status = "reviewed";
    report.resolution = {
      action: action as "ban" | "mute",
      server: new mongoose.Types.ObjectId(serverId),
      resolvedBy: admin.id,
      resolvedAt: new Date(),
      auditLog: auditLog._id,
    };
    await report.save();

    const server = await DiscordServer.findById(serverId).select("name").lean();
    const notification = await createNotification({
      recipient: reportedUserId,
      type: action === "ban" ? "banned" : "muted",
      title: action === "ban" ? "You were banned from a server" : "You were muted in a server",
      message:
        action === "ban"
          ? `You were banned from "${server?.name ?? "a server"}". Reason: ${report.reason}. You can file an appeal if you believe this was a mistake.`
          : `You were muted in "${server?.name ?? "a server"}" for 24 hours. Reason: ${report.reason}. You can file an appeal if you believe this was a mistake.`,
      actionUrl: `/appeal?serverId=${serverId}&action=${action}`,
      metadata: { serverId, serverName: server?.name, muteExpiresAt: expiresAt },
    });
    if (notification) sendNotificationViaSocket(io, reportedUserId, notification);

    return c.json({ message: `Report resolved: ${action}` });
  } catch (error) {
    console.error("Error resolving report:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

// ── Appeals ──────────────────────────────────────────────────────────────────

export const submitAppeal = async (c: Context) => {
  try {
    const me = c.get("user");
    const body = await c.req.json().catch(() => ({}));
    const { serverId, action, reason } = body as {
      serverId?: string;
      action?: string;
      reason?: string;
    };
    if (!serverId || !mongoose.Types.ObjectId.isValid(serverId)) {
      return c.json({ error: "Invalid server ID" }, 400);
    }
    if (!action || !["ban", "mute"].includes(action)) {
      return c.json({ error: "action must be ban or mute" }, 400);
    }
    if (!reason || !reason.trim()) {
      return c.json({ error: "A reason is required" }, 400);
    }

    const member = await ServerMember.findOne({ server: serverId, user: me.id }).lean();
    const isBanned = member?.banned?.isBanned;
    const isMuted = member?.muted?.isMuted;
    if (action === "ban" && !isBanned) {
      return c.json({ error: "You are not banned from this server" }, 400);
    }
    if (action === "mute" && !isMuted) {
      return c.json({ error: "You are not muted in this server" }, 400);
    }

    const existing = await Appeal.findOne({ user: me.id, server: serverId, action, status: "pending" });
    if (existing) {
      return c.json({ error: "You already have a pending appeal for this" }, 400);
    }

    const appeal = await Appeal.create({
      user: me.id,
      server: serverId,
      action,
      reason: reason.trim().slice(0, 1000),
    });

    return c.json({ message: "Appeal submitted", appealId: appeal._id }, 201);
  } catch (error) {
    console.error("Error submitting appeal:", error);
    return c.json({ error: "Failed to submit appeal" }, 500);
  }
};

export const getAdminAppeals = async (c: Context) => {
  try {
    const status = c.req.query("status") || "pending";
    const limit = Math.min(
      Math.max(parseInt(c.req.query("limit") || "10", 10) || 10, 1),
      50,
    );
    const appeals = await Appeal.find({ status })
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate("user", "name email")
      .populate("server", "name")
      .lean();
    return c.json({ appeals, status, count: appeals.length });
  } catch (error) {
    console.error("Error fetching appeals:", error);
    return c.json({ error: "Failed to fetch appeals" }, 500);
  }
};

export const resolveAppeal = async (c: Context) => {
  try {
    const admin = c.get("user");
    const appealId = c.req.param("appealId");
    const io: Server = c.get("io");
    const body = await c.req.json().catch(() => ({}));
    const { resolution } = body as { resolution?: string };

    if (!appealId || !mongoose.Types.ObjectId.isValid(appealId)) {
      return c.json({ error: "Invalid appeal ID" }, 400);
    }
    if (!resolution || !["reversed", "upheld"].includes(resolution)) {
      return c.json({ error: "resolution must be reversed or upheld" }, 400);
    }

    const appeal = await Appeal.findById(appealId);
    if (!appeal) return c.json({ error: "Appeal not found" }, 404);
    if (appeal.status !== "pending") {
      return c.json({ error: "Appeal has already been resolved" }, 400);
    }

    if (resolution === "reversed") {
      const serverId = appeal.server.toString();
      if (appeal.action === "ban") {
        await DiscordServer.findOneAndUpdate(
          { _id: serverId, "members.user": appeal.user },
          { $unset: { "members.$.banned": "" } },
        );
        await ServerMember.updateOne(
          { server: serverId, user: appeal.user },
          { $unset: { banned: "" } },
        );
      } else {
        await DiscordServer.findOneAndUpdate(
          { _id: serverId, "members.user": appeal.user },
          { $unset: { "members.$.muted": "" } },
        );
        await ServerMember.updateOne(
          { server: serverId, user: appeal.user },
          { $unset: { muted: "" } },
        );
      }
      await AuditLog.create({
        server: serverId,
        action: appeal.action === "ban" ? "appeal_reversed_ban" : "appeal_reversed_mute",
        performedBy: admin.id,
        targetUser: appeal.user,
        details: `Appeal ${appealId} upheld — ${appeal.action} reversed`,
      });
    }

    appeal.status = "reviewed";
    appeal.resolution = resolution as "reversed" | "upheld";
    appeal.resolvedBy = admin.id;
    appeal.resolvedAt = new Date();
    await appeal.save();

    const notification = await createNotification({
      recipient: appeal.user.toString(),
      type: "appeal_resolved",
      title: "Your appeal was reviewed",
      message:
        resolution === "reversed"
          ? `Your appeal was accepted — the ${appeal.action} has been reversed.`
          : `Your appeal was reviewed and the original decision was upheld.`,
      metadata: { serverId: appeal.server, resolution },
    });
    if (notification) sendNotificationViaSocket(io, appeal.user.toString(), notification);

    return c.json({ message: `Appeal ${resolution}` });
  } catch (error) {
    console.error("Error resolving appeal:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};
