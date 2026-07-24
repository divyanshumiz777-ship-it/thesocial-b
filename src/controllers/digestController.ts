import { Context } from "hono";
import User from "../models/User.ts";
import { forwardCatchMeUpDigest, isChatServiceEnabled } from "../lib/chatServiceClient.ts";

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

// GET /api/v1/digest/catch-me-up — "while you were away" across every
// server the caller belongs to. Uses a dedicated watermark
// (User.catchMeUpSeenAt), not User.lastSeen — see the model's own comment
// on why lastSeen can't serve double duty here (a 15-minute presence
// heartbeat keeps bumping it forward even while the user is actively
// online).
export const getCatchMeUpDigest = async (c: Context) => {
  try {
    const me = c.get("user");
    const userDoc = await User.findById(me.id).select("catchMeUpSeenAt createdAt");
    if (!userDoc) return c.json({ error: "User not found" }, 404);

    const since = userDoc.catchMeUpSeenAt ?? new Date(Date.now() - DEFAULT_WINDOW_MS);

    if (!isChatServiceEnabled()) {
      return c.json({
        digest: null,
        since: since.toISOString(),
        available: false,
        totalMessageCount: 0,
        totalMentionCount: 0,
        servers: [],
      });
    }

    const result = await forwardCatchMeUpDigest(me.id, since.toISOString());

    // Advance the watermark regardless of whether the chat-service call
    // succeeded — a transient failure shouldn't leave the user re-fetching
    // the same (possibly huge) backlog window on every retry; worst case
    // a retry after a failure just misses whatever happened in between.
    userDoc.catchMeUpSeenAt = new Date();
    await userDoc.save();

    if (!result) {
      return c.json({
        digest: null,
        since: since.toISOString(),
        available: false,
        totalMessageCount: 0,
        totalMentionCount: 0,
        servers: [],
      });
    }

    return c.json({
      digest: result.digest,
      since: result.since,
      available: true,
      totalMessageCount: result.totalMessageCount,
      totalMentionCount: result.totalMentionCount,
      servers: result.servers,
    });
  } catch (error) {
    console.error("Error building catch-me-up digest:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};
