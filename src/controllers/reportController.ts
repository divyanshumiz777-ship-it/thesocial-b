import { Context } from "hono";
import mongoose from "mongoose";
import UserReport, { REPORT_REASONS } from "../models/UserReport.ts";
import User from "../models/User.ts";

const VALID_REASONS = new Set<string>(REPORT_REASONS);

export const reportUser = async (c: Context) => {
  try {
    const me = c.get("user");
    const reportedUserId = c.req.param("userId");
    const body = await c.req.json().catch(() => ({}));
    const { reason, details } = body as { reason?: string; details?: string };

    if (!reportedUserId || !mongoose.Types.ObjectId.isValid(reportedUserId)) {
      return c.json({ error: "Invalid user ID" }, 400);
    }
    if (reportedUserId === me.id) {
      return c.json({ error: "You cannot report yourself" }, 400);
    }
    if (!reason || !VALID_REASONS.has(reason)) {
      return c.json(
        { error: `A valid reason is required (${REPORT_REASONS.join(", ")})` },
        400
      );
    }

    const targetExists = await User.exists({ _id: reportedUserId });
    if (!targetExists) {
      return c.json({ error: "User not found" }, 404);
    }

    const report = await UserReport.create({
      reporter: me.id,
      reportedUser: reportedUserId,
      reason,
      details:
        typeof details === "string" && details.trim()
          ? details.trim().slice(0, 500)
          : undefined,
    });

    return c.json(
      { message: "Report submitted. Our team will review it.", reportId: report._id },
      201
    );
  } catch (error) {
    console.error("Error reporting user:", error);
    return c.json({ error: "Failed to submit report" }, 500);
  }
};
