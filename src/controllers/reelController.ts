import { Context } from "hono";
import { Reel } from "../models/Reel.ts";
import { UserReelInteraction } from "../models/UserReelInteraction.ts";
import { ReelComment } from "../models/ReelComment.ts";
import { Types } from "mongoose";
import { getIoInstance } from "../config/socket.ts";

const broadcastReel = (reelId: string, event: string, payload: object) => {
  try {
    getIoInstance().to(`reel:${reelId}`).emit(event, payload);
  } catch {
    // socket not initialised yet in tests / cold start — safe to ignore
  }
};

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
  }
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

    const reel = new Reel({
      creator_id: Types.ObjectId.createFromHexString(creator_id),
      videoUrl,
      thumbnailUrl,
      caption,
      tags: tags ?? [],
      language: language ?? "en",
      audio_id,
      audioName,
      duration,
    });

    await reel.save();

    await reel.populate("creator_id", "name profilePic");

    return c.json({ message: "Reel created successfully", reel }, 201);
  } catch (error) {
    console.error("Error creating reel:", error);
    return c.json({ error: "Failed to create reel" }, 500);
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
    const page = Number.parseInt(c.req.query("page") ?? "1", 10);
    const limit = Number.parseInt(c.req.query("limit") ?? "20", 10);

    const skip = (page - 1) * limit;

    const reels = await Reel.find({
      creator_id: Types.ObjectId.createFromHexString(userId),
      isDeleted: false,
    })
      .sort({ created_at: -1 })
      .skip(skip)
      .limit(limit)
      .populate("creator_id", "name profilePic");

    const total = await Reel.countDocuments({
      creator_id: Types.ObjectId.createFromHexString(userId),
      isDeleted: false,
    });

    return c.json(
      {
        reels,
        pagination: {
          total,
          page,
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
      .populate("user_id", "name profilePic username");

    const total = await ReelComment.countDocuments({ reel_id: reelId, isDeleted: false, parentCommentId: null });

    const userObjId = new Types.ObjectId(userId);
    const commentsWithMeta = comments.map((c: any) => ({
      ...c.toObject(),
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

    await Reel.findByIdAndUpdate(comment.reel_id, { $inc: { commentCount: -1 } });

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
