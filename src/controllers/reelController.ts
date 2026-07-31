import { Context } from "hono";
import { Reel } from "../models/Reel.ts";
import { UserReelInteraction } from "../models/UserReelInteraction.ts";
import { ReelComment } from "../models/ReelComment.ts";
import User from "../models/User.ts";
import Follow from "../models/Follow.ts";
import { Types } from "mongoose";
import { getIoInstance } from "../config/socket.ts";
import {
  isReelEventStreamEnabled,
  publishReelEvent,
  computeCompletionRate,
} from "../lib/reelEventStream.ts";
import { getPersonalizedFeed } from "../lib/reelRecommendation.ts";
import {
  isRecommendationServiceEnabled,
  fetchRecommendedFeed,
} from "../lib/aiServiceClient.ts";
import { canViewFullProfile } from "../lib/profilePrivacy.ts";
import { canViewRelationships } from "./followController.ts";
import {
  forwardGenerateReelCaptions,
  forwardDeleteContent,
  forwardIngestDocument,
  isChatServiceEnabled,
} from "../lib/chatServiceClient.ts";
import logger from "../lib/logger.ts";
import { deriveVideoThumbnailUrl } from "../lib/cloudinary.ts";

const MAX_PINNED_REELS = 3;

const REDACTED_AUTHOR = { name: "Private User", profilePic: "", username: undefined };

/**
 * Redacts a populated user_id/creator_id ref to identity-only when the
 * viewer can't see that author's full profile (private/friends/followers
 * tiers). Keeps the same shape so existing frontend rendering doesn't branch.
 */
async function redactRestrictedAuthors<T extends { user_id?: any }>(
  docs: T[],
  viewerId: string,
): Promise<T[]> {
  const authorIds = Array.from(
    new Set(
      docs
        .map((d) => d.user_id?._id?.toString())
        .filter((id): id is string => !!id && id !== viewerId),
    ),
  );
  if (authorIds.length === 0) return docs;

  const [viewer, followingRows] = await Promise.all([
    User.findById(viewerId).select("friends"),
    Follow.find({
      follower: viewerId,
      followee: { $in: authorIds },
      status: "accepted",
    }).distinct("followee"),
  ]);
  const friendSet = new Set((viewer?.friends ?? []).map((f) => f.toString()));
  const followingSet = new Set(followingRows.map((id) => id.toString()));

  return docs.map((d) => {
    const author = d.user_id;
    const authorId = author?._id?.toString();
    if (!author || !authorId || authorId === viewerId) return d;

    const allowed = canViewFullProfile(author, {
      viewerId,
      isFriend: friendSet.has(authorId),
      isFollower: followingSet.has(authorId),
    });
    if (allowed) return d;

    return { ...d, user_id: { _id: author._id, ...REDACTED_AUTHOR } };
  });
}

const broadcastToRoom = (room: string, event: string, payload: object) => {
  try {
    getIoInstance().to(room).emit(event, payload);
  } catch {
    // socket not initialised yet in tests / cold start — safe to ignore
  }
};

const broadcastReel = (reelId: string, event: string, payload: object) =>
  broadcastToRoom(`reel:${reelId}`, event, payload);

// Fire-and-forget — never awaited by createReel. Captions are a nice-to-have
// enhancement, never a gate on the reel existing/being playable; a reel with
// captionsStatus="unavailable" just renders with no <track> element.
async function generateReelCaptionsAsync(reelId: string, videoUrl: string) {
  try {
    const result = await forwardGenerateReelCaptions(videoUrl);
    await Reel.updateOne(
      { _id: reelId },
      result
        ? { $set: { captionsVtt: result.vtt, captionsStatus: "ready" } }
        : { $set: { captionsStatus: "unavailable" } },
    );
  } catch (err) {
    console.error("Caption generation failed for reel", reelId, err);
    await Reel.updateOne({ _id: reelId }, { $set: { captionsStatus: "unavailable" } }).catch(() => {});
  }
}

const broadcastCreator = (creatorId: string, event: string, payload: object) =>
  broadcastToRoom(`creator:${creatorId}`, event, payload);

const updateReelCount = async (
  reel_id: string,
  event_type: string,
  liked?: boolean,
) => {
  const reel = await Reel.findById(reel_id);
  if (!reel) return;

  switch (event_type) {
    case "like":
      if (liked) reel.likeCount += 1;
      else reel.likeCount = Math.max(0, reel.likeCount - 1);
      break;
    case "view":
      reel.viewCount += 1;
      break;
    case "share":
      reel.shareCount += 1;
      break;
  }
  await reel.save();
};

const updateInteractionByEvent = (
  interaction: any,
  event_type: string,
  watch_time?: number,
) => {
  switch (event_type) {
    case "view":
      interaction.watch_time = 0;
      break;
    case "watch_time":
      interaction.watch_time = watch_time ?? interaction.watch_time;
      break;
    case "like":
      interaction.liked = !interaction.liked;
      break;
    case "share":
      interaction.shared = true;
      break;
    case "comment":
      interaction.commented = true;
      break;
    case "skip":
      interaction.skipped = true;
      break;
    case "follow_creator":
      interaction.follow_creator = true;
      break;
    case "completed":
      interaction.completed = true;
      break;
    case "save":
      // Toggle, mirroring "like": the same event both saves and unsaves.
      interaction.saved = !interaction.saved;
      break;
    case "rewatch":
      interaction.rewatch_count = (interaction.rewatch_count ?? 0) + 1;
      break;
  }
};

/**
 * Hydrate Recommendation Service reel IDs back into the exact response shape the
 * feed already returns (populated Reel docs), preserving recommendation order.
 * Reads only — no writes.
 */
const hydratePersonalizedReels = async (
  reelIds: string[],
): Promise<any[]> => {
  const objectIds = reelIds
    .map((id) => {
      try {
        return Types.ObjectId.createFromHexString(id);
      } catch {
        return null;
      }
    })
    .filter((id): id is Types.ObjectId => id !== null);

  if (objectIds.length === 0) return [];

  const reels = await Reel.find({
    _id: { $in: objectIds },
    isDeleted: false,
  }).populate("creator_id", "name profilePic");

  // Preserve the order returned by the Recommendation Service.
  const byId = new Map<string, any>(
    reels.map((r: any) => [r._id.toString(), r]),
  );
  return reelIds.map((id) => byId.get(id)).filter((r) => r != null);
};

/**
 * Personalized feed source with gated Recommendation Service integration.
 *
 * REC_SERVICE_ENABLED=false (default): returns the existing heuristic feed
 * (reelRecommendation.getPersonalizedFeed) exactly as before.
 *
 * REC_SERVICE_ENABLED=true: calls the Recommendation Service (250ms timeout,
 * 1 retry, circuit breaker). On timeout / unavailable / empty / invalid /
 * breaker-open / any exception it immediately falls back to the heuristic.
 * The rec path never throws; the response shape is unchanged.
 */
export const resolvePersonalizedFeed = async (
  userId: string,
  limit: number,
): Promise<any[]> => {
  if (isRecommendationServiceEnabled()) {
    try {
      // retries: 0 — fetchRecommendedFeed's own retry loop doesn't forward
      // its retries option down into callInternalService, so leaving this
      // unset let a slow-but-not-yet-tripped-breaker service cost up to
      // ~500ms (two back-to-back 250ms-timeout attempts) before falling
      // back. Capping at a single attempt bounds worst-case added latency to
      // ~250ms and lets the circuit breaker — not per-request retries —
      // absorb sustained slowness.
      const reelIds = await fetchRecommendedFeed(userId, { limit, retries: 0 });
      if (reelIds && reelIds.length > 0) {
        const hydrated = await hydratePersonalizedReels(reelIds);
        if (hydrated.length > 0) {
          logger.info(
            { userId, reason: "rec-ok", count: hydrated.length },
            "resolvePersonalizedFeed: served from recommendation service",
          );
          return hydrated;
        }
        logger.info(
          { userId, reason: "empty-hydration" },
          "resolvePersonalizedFeed: recommendation ids returned no hydratable reels — falling back",
        );
      } else {
        logger.info(
          { userId, reason: "empty-or-unavailable" },
          "resolvePersonalizedFeed: recommendation service returned nothing — falling back",
        );
      }
    } catch (error) {
      logger.warn(
        { userId, reason: "exception", error: error instanceof Error ? error.message : String(error) },
        "resolvePersonalizedFeed: recommendation service call threw — falling back to heuristic",
      );
    }
  } else {
    logger.debug({ userId, reason: "disabled" }, "resolvePersonalizedFeed: recommendation service disabled");
  }
  // Default + fallback: existing heuristic — behavior identical to today.
  return getPersonalizedFeed(userId, limit);
};

export const trackReelEvent = async (c: Context) => {
  try {
    const user_id = c.get("user").id;
    const { reel_id, event_type, watch_time } = await c.req.json();

    if (!reel_id || !event_type) {
      return c.json(
        { error: "Missing required fields: reel_id, event_type" },
        400,
      );
    }

    let interaction = await UserReelInteraction.findOne({
      user_id: Types.ObjectId.createFromHexString(user_id),
      reel_id: Types.ObjectId.createFromHexString(reel_id),
    });

    interaction ??= new UserReelInteraction({
      user_id: Types.ObjectId.createFromHexString(user_id),
      reel_id: Types.ObjectId.createFromHexString(reel_id),
    });

    updateInteractionByEvent(interaction, event_type, watch_time);

    interaction.last_interaction_at = new Date();
    await interaction.save();

    if (["like", "view", "share"].includes(event_type)) {
      await updateReelCount(reel_id, event_type, interaction.liked);
    }

    // Broadcast real-time count updates to all viewers of this reel
    if (event_type === "like") {
      const updated = await Reel.findById(reel_id).select("likeCount");
      if (updated) {
        broadcastReel(reel_id, "reel:like-updated", {
          reelId: reel_id,
          likeCount: updated.likeCount,
          // send who liked so receiver can update their own liked state if needed
          userId: user_id,
          liked: interaction.liked,
        });
      }
    }

    // Fire-and-forget: mirror the event to the Redis Stream for the
    // Recommendation Service. Fully gated (REC_EVENT_STREAM_ENABLED, default
    // OFF). Runs in a detached async task that is never awaited and never
    // throws, so it cannot block or affect this response. The reel-duration
    // lookup (for completion_rate) only runs when watch_time is present; if the
    // duration is unavailable, completion_rate is null.
    if (isReelEventStreamEnabled()) {
      void (async () => {
        let completion_rate: number | null = null;
        if (typeof watch_time === "number") {
          const reel = await Reel.findById(reel_id).select("duration");
          completion_rate = computeCompletionRate(watch_time, reel?.duration);
        }
        await publishReelEvent({
          user_id,
          reel_id,
          event_type,
          watch_time,
          completion_rate,
          ts: Date.now(),
        });
      })().catch(() => {});
    }

    return c.json({ message: "Event tracked successfully", interaction }, 200);
  } catch (error) {
    console.error("Error tracking reel event:", error);
    return c.json({ error: "Failed to track reel event" }, 500);
  }
};
export const createReel = async (c: Context) => {
  try {
    const creator_id = c.get("user").id;
    const {
      videoUrl,
      thumbnailUrl,
      caption,
      tags,
      language,
      audio_id,
      audioName,
      duration,
    } = await c.req.json();

    if (!videoUrl || !duration) {
      return c.json(
        { error: "Missing required fields: videoUrl, duration" },
        400,
      );
    }

    // The uploader never sends a thumbnail today — derive one from the
    // video's own first frame rather than leaving every reel without a
    // thumbnail. Only used as a fallback: an explicitly supplied
    // thumbnailUrl (if a future upload flow ever sends one) still wins.
    const resolvedThumbnailUrl = thumbnailUrl || deriveVideoThumbnailUrl(videoUrl);

    const reel = new Reel({
      creator_id: Types.ObjectId.createFromHexString(creator_id),
      videoUrl,
      thumbnailUrl: resolvedThumbnailUrl,
      caption,
      tags: tags ?? [],
      language: language ?? "en",
      audio_id,
      audioName,
      duration,
    });

    await reel.save();

    await reel.populate("creator_id", "name profilePic");

    void generateReelCaptionsAsync(reel._id.toString(), videoUrl);

    // Index the reel so it is findable by caption/tags right away (mirrors the
    // forwardDeleteContent call in the soft-delete path below). The chunker
    // enforces its own rule that only public, non-deleted reels are indexed,
    // so a private draft correctly produces no chunks rather than needing a
    // condition here.
    if (isChatServiceEnabled()) {
      void forwardIngestDocument("reel", reel._id.toString());
    }

    // Only worth telling followers about public reels — a private draft
    // publishing shouldn't ping everyone who follows this creator.
    if (reel.isPublic) {
      broadcastCreator(creator_id, "creator:newReel", {
        creatorId: creator_id,
        reelId: reel._id.toString(),
        thumbnail: reel.thumbnailUrl ?? "",
      });
    }

    return c.json({ message: "Reel created successfully", reel }, 201);
  } catch (error) {
    console.error("Error creating reel:", error);
    return c.json({ error: "Failed to create reel" }, 500);
  }
};

// Public, no-auth preview for share links — ReelsTab.tsx's handleShare()
// builds a link to /reels/:reelId via navigator.share/clipboard, but no
// matching page/route ever existed, so every reel share 404s for whoever
// receives it. This only exposes fields already fine for anyone with the
// link to see (no email, unlike the authenticated getReelById below).
export const getPublicReelPreview = async (c: Context) => {
  try {
    const { reelId } = c.req.param();
    const reel = await Reel.findOne({ _id: reelId, isDeleted: false })
      .select("videoUrl thumbnailUrl caption likeCount commentCount shareCount creator_id")
      .populate("creator_id", "name profilePic")
      .lean();
    if (!reel) {
      return c.json({ error: "Reel not found" }, 404);
    }
    return c.json({ reel }, 200);
  } catch (error) {
    console.error("Error fetching public reel preview:", error);
    return c.json({ error: "Failed to fetch reel" }, 500);
  }
};

// Public, no-auth — a <track src> request from a <video> element can't carry
// an Authorization header, so this must be reachable without one, same as
// getPublicReelPreview above. Returns 404 both when the reel doesn't exist
// and when captions were never generated/failed — the frontend only ever
// renders the <track> element when captionsStatus is already known to be
// "ready" (see ReelsTab.tsx), so a 404 here would only happen for a stale
// reference or a direct hit on this URL.
export const getReelCaptionsVtt = async (c: Context) => {
  try {
    const { reelId } = c.req.param();
    const reel = await Reel.findOne({ _id: reelId, isDeleted: false })
      .select("captionsVtt captionsStatus")
      .lean();
    if (!reel || reel.captionsStatus !== "ready" || !reel.captionsVtt) {
      return c.json({ error: "Captions not available" }, 404);
    }
    return c.text(reel.captionsVtt, 200, { "Content-Type": "text/vtt; charset=utf-8" });
  } catch (error) {
    console.error("Error fetching reel captions:", error);
    return c.json({ error: "Failed to fetch captions" }, 500);
  }
};

export const getReelById = async (c: Context) => {
  try {
    const { reelId } = c.req.param();

    const reel = await Reel.findById(reelId).populate(
      "creator_id",
      "name profilePic email",
    );

    if (!reel) {
      return c.json({ error: "Reel not found" }, 404);
    }

    return c.json({ reel }, 200);
  } catch (error) {
    console.error("Error fetching reel:", error);
    return c.json({ error: "Failed to fetch reel" }, 500);
  }
};

export const getUserReels = async (c: Context) => {
  try {
    const { userId } = c.req.param();
    const viewer = c.get("user");
    const limit = Math.min(
      Number.parseInt(c.req.query("limit") ?? "20", 10) || 20,
      50,
    );
    const sort = c.req.query("sort") ?? "newest";

    // Cursor mode (opaque skip-offset token) takes precedence when present —
    // this is what the infinite-scroll grid uses. Page mode is kept as-is for
    // existing callers (e.g. the one-shot limit=50 fetch predating this).
    const cursorParam = c.req.query("cursor");
    const page = cursorParam ? null : Number.parseInt(c.req.query("page") ?? "1", 10);
    const skip = cursorParam
      ? Math.max(Number.parseInt(cursorParam, 10) || 0, 0)
      : (page! - 1) * limit;

    if (!(await canViewRelationships(userId, viewer.id))) {
      return c.json(
        {
          restricted: true,
          message:
            "This creator's reels are not available due to their privacy settings.",
          reels: [],
          nextCursor: null,
          pagination: { total: 0, page: page ?? 1, limit, pages: 0 },
        },
        200,
      );
    }

    const filter = {
      creator_id: Types.ObjectId.createFromHexString(userId),
      isDeleted: false,
    };

    // Pinned reels always float to the top regardless of sort — matches
    // Instagram's actual behavior (pinning isn't a separate filter mode).
    const sortSpec: Record<string, 1 | -1> =
      sort === "popular"
        ? { isPinned: -1, viewCount: -1, shareCount: -1, likeCount: -1 }
        : sort === "liked"
          ? { isPinned: -1, likeCount: -1, created_at: -1 }
          : { isPinned: -1, created_at: -1 };

    const [reels, total] = await Promise.all([
      Reel.find(filter)
        .sort(sortSpec)
        .skip(skip)
        .limit(limit)
        .populate("creator_id", "name profilePic"),
      Reel.countDocuments(filter),
    ]);

    const hasMore = skip + reels.length < total;

    return c.json(
      {
        restricted: false,
        reels,
        nextCursor: hasMore ? String(skip + limit) : null,
        pagination: {
          total,
          page: page ?? Math.floor(skip / limit) + 1,
          limit,
          pages: Math.ceil(total / limit),
        },
      },
      200,
    );
  } catch (error) {
    console.error("Error fetching user reels:", error);
    return c.json({ error: "Failed to fetch user reels" }, 500);
  }
};

export const togglePinReel = async (c: Context) => {
  try {
    const { reelId } = c.req.param();
    const userId = c.get("user").id;

    const reel = await Reel.findById(reelId);
    if (!reel) return c.json({ error: "Reel not found" }, 404);
    if (reel.creator_id.toString() !== userId) {
      return c.json({ error: "Unauthorized to pin this reel" }, 403);
    }

    if (!reel.isPinned) {
      const pinnedCount = await Reel.countDocuments({
        creator_id: reel.creator_id,
        isPinned: true,
        isDeleted: false,
      });
      if (pinnedCount >= MAX_PINNED_REELS) {
        return c.json(
          { error: `You can pin up to ${MAX_PINNED_REELS} reels` },
          400,
        );
      }
      reel.isPinned = true;
      reel.pinnedAt = new Date();
    } else {
      reel.isPinned = false;
      reel.pinnedAt = undefined;
    }

    await reel.save();

    return c.json({
      message: reel.isPinned ? "Reel pinned" : "Reel unpinned",
      isPinned: reel.isPinned,
    });
  } catch (error) {
    console.error("Error toggling pin:", error);
    return c.json({ error: "Failed to toggle pin" }, 500);
  }
};

export const deleteReel = async (c: Context) => {
  try {
    const { reelId } = c.req.param();
    const userId = c.get("user").id;

    const reel = await Reel.findById(reelId);

    if (!reel) {
      return c.json({ error: "Reel not found" }, 404);
    }

    if (reel.creator_id.toString() !== userId) {
      return c.json({ error: "Unauthorized to delete this reel" }, 403);
    }

    reel.isDeleted = true;
    await reel.save();

    // Best-effort — the soft-delete has already committed either way; a
    // failure here only means this reel keeps surfacing through
    // search/the assistant a while longer, never a reason to roll it back.
    if (isChatServiceEnabled()) {
      void forwardDeleteContent("source", reelId, "reel");
    }

    return c.json({ message: "Reel deleted successfully" }, 200);
  } catch (error) {
    console.error("Error deleting reel:", error);
    return c.json({ error: "Failed to delete reel" }, 500);
  }
};

export const getComments = async (c: Context) => {
  try {
    const { reelId } = c.req.param();
    const page = Number.parseInt(c.req.query("page") ?? "1", 10);
    const limit = Number.parseInt(c.req.query("limit") ?? "20", 10);
    const userId = c.get("user").id;

    const skip = (page - 1) * limit;

    const comments = await ReelComment.find({ reel_id: reelId, isDeleted: false, parentCommentId: null })
      .sort({ created_at: -1 })
      .skip(skip)
      .limit(limit)
      .populate("user_id", "name profilePic username settings.privacy.profileVisibility");

    const total = await ReelComment.countDocuments({ reel_id: reelId, isDeleted: false, parentCommentId: null });

    const userObjId = new Types.ObjectId(userId);
    const plainComments = comments.map((c: any) => c.toObject());
    const redacted = await redactRestrictedAuthors(plainComments, userId);
    const commentsWithMeta = redacted.map((c: any) => ({
      ...c,
      isLiked: c.likedBy.some((id: Types.ObjectId) => id.equals(userObjId)),
      isOwn: c.user_id._id.toString() === userId,
    }));

    return c.json({ comments: commentsWithMeta, total, page, hasMore: skip + comments.length < total }, 200);
  } catch (error) {
    console.error("Error fetching comments:", error);
    return c.json({ error: "Failed to fetch comments" }, 500);
  }
};

export const addComment = async (c: Context) => {
  try {
    const { reelId } = c.req.param();
    const userId = c.get("user").id;
    const { content, parentCommentId } = await c.req.json();

    if (!content?.trim()) {
      return c.json({ error: "Comment content is required" }, 400);
    }

    const comment = new ReelComment({
      reel_id: new Types.ObjectId(reelId),
      user_id: new Types.ObjectId(userId),
      content: content.trim(),
      parentCommentId: parentCommentId ? new Types.ObjectId(parentCommentId) : null,
    });

    await comment.save();
    await comment.populate("user_id", "name profilePic username");

    const updatedReel = await Reel.findByIdAndUpdate(
      reelId,
      { $inc: { commentCount: 1 } },
      { new: true }
    ).select("commentCount");

    broadcastReel(reelId, "reel:comment-updated", {
      reelId,
      commentCount: updatedReel?.commentCount ?? 0,
    });

    return c.json({
      comment: { ...comment.toObject(), isLiked: false, isOwn: true },
    }, 201);
  } catch (error) {
    console.error("Error adding comment:", error);
    return c.json({ error: "Failed to add comment" }, 500);
  }
};

export const deleteComment = async (c: Context) => {
  try {
    const { commentId } = c.req.param();
    const userId = c.get("user").id;

    const comment = await ReelComment.findById(commentId);
    if (!comment) return c.json({ error: "Comment not found" }, 404);
    if (comment.user_id.toString() !== userId) return c.json({ error: "Unauthorized" }, 403);

    comment.isDeleted = true;
    await comment.save();

    const updatedReel = await Reel.findByIdAndUpdate(
      comment.reel_id,
      { $inc: { commentCount: -1 } },
      { new: true }
    ).select("commentCount");

    broadcastReel(comment.reel_id.toString(), "reel:comment-updated", {
      reelId: comment.reel_id.toString(),
      commentCount: Math.max(0, updatedReel?.commentCount ?? 0),
    });

    return c.json({ message: "Comment deleted" }, 200);
  } catch (error) {
    console.error("Error deleting comment:", error);
    return c.json({ error: "Failed to delete comment" }, 500);
  }
};

export const toggleCommentLike = async (c: Context) => {
  try {
    const { commentId } = c.req.param();
    const userId = c.get("user").id;
    const userObjId = new Types.ObjectId(userId);

    const comment = await ReelComment.findById(commentId);
    if (!comment) return c.json({ error: "Comment not found" }, 404);

    const alreadyLiked = comment.likedBy.some((id: Types.ObjectId) => id.equals(userObjId));

    if (alreadyLiked) {
      comment.likedBy = comment.likedBy.filter((id: Types.ObjectId) => !id.equals(userObjId));
      comment.likeCount = Math.max(0, comment.likeCount - 1);
    } else {
      comment.likedBy.push(userObjId);
      comment.likeCount += 1;
    }

    await comment.save();

    return c.json({ liked: !alreadyLiked, likeCount: comment.likeCount }, 200);
  } catch (error) {
    console.error("Error toggling comment like:", error);
    return c.json({ error: "Failed to toggle like" }, 500);
  }
};

export const getUserInteractions = async (c: Context) => {
  try {
    const userId = c.get("user").id;
    const { reelIds } = await c.req.json();

    if (!Array.isArray(reelIds) || reelIds.length === 0) {
      return c.json({ interactions: {} }, 200);
    }

    const interactions = await UserReelInteraction.find({
      user_id: new Types.ObjectId(userId),
      reel_id: { $in: reelIds.map((id: string) => new Types.ObjectId(id)) },
    }).select("reel_id liked shared");

    const result: Record<string, { liked: boolean; shared: boolean }> = {};
    for (const interaction of interactions) {
      result[interaction.reel_id.toString()] = {
        liked: interaction.liked,
        shared: interaction.shared,
      };
    }

    return c.json({ interactions: result }, 200);
  } catch (error) {
    console.error("Error fetching user interactions:", error);
    return c.json({ error: "Failed to fetch interactions" }, 500);
  }
};
