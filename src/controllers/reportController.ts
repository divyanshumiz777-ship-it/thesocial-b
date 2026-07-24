import { Context } from "hono";
import mongoose from "mongoose";
import UserReport, { REPORT_REASONS, REPORT_CONTENT_TYPES } from "../models/UserReport.ts";
import User from "../models/User.ts";
import { forwardModerationTriage } from "../lib/chatServiceClient.ts";

const VALID_REASONS = new Set<string>(REPORT_REASONS);
const VALID_CONTENT_TYPES = new Set<string>(REPORT_CONTENT_TYPES);

// Fire-and-forget — never awaited by the request handler. A report is fully
// valid and reviewable the moment it's created; triage only ever adds a
// severity badge on top, later, if the chat-service is up.
async function triageReportAsync(reportId: string, body: {
  reason: string;
  details?: string;
  contentType?: string;
  snippet?: string;
}) {
  try {
    const triage = await forwardModerationTriage({
      reason: body.reason,
      details: body.details,
      content_type: body.contentType,
      snippet: body.snippet,
    });
    if (!triage) return;
    await UserReport.updateOne(
      { _id: reportId },
      { $set: { triage: { ...triage, generatedAt: new Date() } } },
    );
  } catch (err) {
    console.error("Report triage failed for report", reportId, err);
  }
}

export const reportUser = async (c: Context) => {
  try {
    const me = c.get("user");
    const reportedUserId = c.req.param("userId");
    const body = await c.req.json().catch(() => ({}));
    const {
      reason,
      details,
      contentType,
      contentId,
      serverId,
      channelId,
      snippet,
    } = body as {
      reason?: string;
      details?: string;
      contentType?: string;
      contentId?: string;
      serverId?: string;
      channelId?: string;
      snippet?: string;
    };

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
    if (contentType && !VALID_CONTENT_TYPES.has(contentType)) {
      return c.json(
        { error: `Invalid content type (${REPORT_CONTENT_TYPES.join(", ")})` },
        400,
      );
    }

    const targetExists = await User.exists({ _id: reportedUserId });
    if (!targetExists) {
      return c.json({ error: "User not found" }, 404);
    }

    const trimmedDetails =
      typeof details === "string" && details.trim()
        ? details.trim().slice(0, 500)
        : undefined;
    const trimmedSnippet =
      typeof snippet === "string" && snippet.trim()
        ? snippet.trim().slice(0, 2000)
        : undefined;

    const report = await UserReport.create({
      reporter: me.id,
      reportedUser: reportedUserId,
      reason,
      details: trimmedDetails,
      contentType: contentType || undefined,
      contentId:
        contentId && mongoose.Types.ObjectId.isValid(contentId)
          ? contentId
          : undefined,
      serverId:
        serverId && mongoose.Types.ObjectId.isValid(serverId)
          ? serverId
          : undefined,
      channelId:
        channelId && mongoose.Types.ObjectId.isValid(channelId)
          ? channelId
          : undefined,
      snippet: trimmedSnippet,
    });

    void triageReportAsync(report._id.toString(), {
      reason,
      details: trimmedDetails,
      contentType,
      snippet: trimmedSnippet,
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
