import { Context } from "hono";
import { Reel } from "../models/Reel.ts";
import { UserReelInteraction } from "../models/UserReelInteraction.ts";
import { Types } from "mongoose";

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
    case "comment":
      reel.commentCount += 1;
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
    const { user_id, reel_id, event_type, watch_time } = await c.req.json();

    if (!user_id || !reel_id || !event_type) {
      return c.json(
        { error: "Missing required fields: user_id, reel_id, event_type" },
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

    if (["like", "view", "share", "comment"].includes(event_type)) {
      await updateReelCount(reel_id, event_type, interaction.liked);
    }

    return c.json({ message: "Event tracked successfully", interaction }, 200);
  } catch (error) {
    console.error("Error tracking reel event:", error);
    return c.json({ error: "Failed to track reel event" }, 500);
  }
};
export const createReel = async (c: Context) => {
  try {
    const {
      creator_id,
      videoUrl,
      thumbnailUrl,
      caption,
      tags,
      language,
      audio_id,
      audioName,
      duration,
    } = await c.req.json();

    if (!creator_id || !videoUrl || !duration) {
      return c.json(
        { error: "Missing required fields: creator_id, videoUrl, duration" },
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
    const { userId } = await c.req.json();

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
