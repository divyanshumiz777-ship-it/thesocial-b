import { Context } from "hono";
import User from "../models/User.ts";
import DiscordServer from "../models/DiscordServer.ts";
import Conversation from "../models/Conversation.ts";
import Group from "../models/Group.ts";
import Message from "../models/Message.ts";
import { Reel } from "../models/Reel.ts";
import Follow from "../models/Follow.ts";
import { forwardCatchMeUpDigest, isChatServiceEnabled } from "../lib/chatServiceClient.ts";

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

// Below this away-duration, a proactive digest would just be noise — the
// user hasn't really "been away" in any meaningful sense.
const MIN_AWAY_MS = 2 * 60 * 60 * 1000; // 2 hours
// Floor on how often the digest can re-prompt, independent of awayMs — this
// is what actually prevents "every reconnect within the same day" spam,
// since a flaky connection can cause many short disconnects in a row.
const REPROMPT_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

async function hasNewContentSince(userId: string, since: Date): Promise<boolean> {
  const [serverIds, convoIds, groupIds, followedCreatorIds] = await Promise.all([
    DiscordServer.find({ "members.user": userId }).distinct("_id"),
    Conversation.find({ participants: userId }).distinct("_id"),
    Group.find({ participants: userId }).distinct("_id"),
    Follow.find({ follower: userId, status: "accepted" }).distinct("followee"),
  ]);

  const [hasChannelMsg, hasDmMsg, hasGroupMsg, hasReel] = await Promise.all([
    serverIds.length
      ? Message.exists({ server: { $in: serverIds }, channel: { $exists: true }, createdAt: { $gt: since } })
      : Promise.resolve(false),
    convoIds.length
      ? Message.exists({ conversationId: { $in: convoIds }, createdAt: { $gt: since } })
      : Promise.resolve(false),
    groupIds.length
      ? Message.exists({ groupId: { $in: groupIds }, createdAt: { $gt: since } })
      : Promise.resolve(false),
    followedCreatorIds.length
      ? Reel.exists({ creator_id: { $in: followedCreatorIds }, isDeleted: false, createdAt: { $gt: since } })
      : Promise.resolve(false),
  ]);

  return Boolean(hasChannelMsg || hasDmMsg || hasGroupMsg || hasReel);
}

// GET /api/v1/digest/catch-me-up/eligibility — cheap peek: should a proactive
// digest surface right now? No chat-service/LLM call, no watermark mutation.
// Gated on (a) the user having been away long enough to be worth a digest,
// (b) not having been prompted again too recently, and (c) there actually
// being new content since their last-seen digest window.
export const getCatchMeUpEligibility = async (c: Context) => {
  try {
    const me = c.get("user");
    const userDoc = await User.findById(me.id).select("lastDisconnectedAt catchMeUpSeenAt createdAt");
    if (!userDoc) return c.json({ error: "User not found" }, 404);

    const now = Date.now();

    if (!userDoc.lastDisconnectedAt) {
      return c.json({ eligible: false, reason: "no-session-boundary-yet" });
    }
    const awayMs = now - userDoc.lastDisconnectedAt.getTime();
    if (awayMs < MIN_AWAY_MS) {
      return c.json({ eligible: false, reason: "not-away-long-enough", awayMs });
    }

    if (userDoc.catchMeUpSeenAt) {
      const sincePrompt = now - userDoc.catchMeUpSeenAt.getTime();
      if (sincePrompt < REPROMPT_INTERVAL_MS) {
        return c.json({ eligible: false, reason: "reprompt-interval-not-elapsed", awayMs });
      }
    }

    const since = userDoc.catchMeUpSeenAt ?? new Date(now - DEFAULT_WINDOW_MS);
    const hasContent = await hasNewContentSince(me.id, since);
    if (!hasContent) {
      return c.json({ eligible: false, reason: "no-new-content", awayMs });
    }

    return c.json({ eligible: true, since: since.toISOString(), awayMs });
  } catch (error) {
    console.error("Error checking catch-me-up eligibility:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

// GET /api/v1/digest/catch-me-up — "while you were away" across every
// server the caller belongs to, plus DMs/group DMs/reels from followed
// creators. Uses a dedicated watermark (User.catchMeUpSeenAt), not
// User.lastSeen — see the model's own comment on why lastSeen can't serve
// double duty here. A pure read: does NOT advance the watermark itself
// (see ackCatchMeUpDigest below) — a GET that mutates state made "peek
// without consuming" impossible for the eligibility check above.
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
        dmHighlights: [],
        reelHighlights: [],
      });
    }

    const result = await forwardCatchMeUpDigest(me.id, since.toISOString());

    if (!result) {
      return c.json({
        digest: null,
        since: since.toISOString(),
        available: false,
        totalMessageCount: 0,
        totalMentionCount: 0,
        servers: [],
        dmHighlights: [],
        reelHighlights: [],
      });
    }

    return c.json({
      digest: result.digest,
      since: result.since,
      available: true,
      totalMessageCount: result.totalMessageCount,
      totalMentionCount: result.totalMentionCount,
      servers: result.servers,
      dmHighlights: result.dmHighlights ?? [],
      reelHighlights: result.reelHighlights ?? [],
    });
  } catch (error) {
    console.error("Error building catch-me-up digest:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

// POST /api/v1/digest/catch-me-up/ack — advances the "seen" watermark.
// Called only on an explicit dismissal ("Got it"), never on a snooze — a
// snoozed digest must resurface with the SAME content next time, not have
// its window silently consumed.
export const ackCatchMeUpDigest = async (c: Context) => {
  try {
    const me = c.get("user");
    const userDoc = await User.findById(me.id).select("_id");
    if (!userDoc) return c.json({ error: "User not found" }, 404);

    userDoc.catchMeUpSeenAt = new Date();
    await userDoc.save();

    return c.json({ success: true });
  } catch (error) {
    console.error("Error acking catch-me-up digest:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};
