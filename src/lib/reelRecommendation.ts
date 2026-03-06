import { Reel } from "../models/Reel.ts";
import { UserReelInteraction } from "../models/UserReelInteraction.ts";
import { UserReelPreference } from "../models/UserReelPreference.ts";
import { Types } from "mongoose";

export interface ReelScoreResult {
  reelId: string;
  score: number;
  reason: string;
}

/**
 * PHASE 2: Rule-Based Scoring Formula
 * score = (watch_time * 0.4) + (like * 3) + (share * 5) + (comment * 4) - (skip * 2) + freshness_boost
 */
export const calculateReelScore = (
  interaction: any,
  reelAgeDays: number,
): number => {
  const baseScore =
    interaction.watch_time * 0.4 +
    (interaction.liked ? 3 : 0) +
    (interaction.shared ? 5 : 0) +
    (interaction.commented ? 4 : 0) -
    (interaction.skipped ? 2 : 0);

  // Freshness boost: higher for newer reels
  const freshnessBoost = Math.max(0, 10 - reelAgeDays) * 0.5;

  return baseScore + freshnessBoost;
};

/**
 * Calculate trending score for a reel
 * trending_score = (total_watch_time / age_in_hours) + (shares * 2) + (new_users_liking)
 */
export const calculateTrendingScore = (
  reel: any,
  ageInHours: number,
): number => {
  const watchTimeContribution = reel.viewCount / Math.max(1, ageInHours);
  const shareContribution = reel.shareCount * 2;

  return watchTimeContribution + shareContribution;
};

/**
 * PHASE 2: Get personalized feed for a user
 * 60% personalized + 30% trending + 10% random exploration
 */
export const getPersonalizedFeed = async (
  userId: string,
  limit: number = 20,
): Promise<any[]> => {
  try {
    const userObjId = Types.ObjectId.createFromHexString(userId);

    // Get user's last 50 interactions
    const userInteractions = await UserReelInteraction.find({
      user_id: userObjId,
    })
      .sort({ created_at: -1 })
      .limit(50);

    // Extract top tags, creators, and audio
    const tagFrequency: Record<string, number> = {};
    const creatorIds = new Set<string>();
    const audioIds = new Set<string>();

    userInteractions.forEach((interaction: any) => {
      if (interaction.follow_creator) {
        creatorIds.add(interaction.reel_id.toString());
      }
    });

    // Get liked/commented reels to extract tags
    const likedReels = await Reel.find({
      _id: {
        $in: userInteractions
          .filter((i: any) => i.liked || i.commented)
          .map((i: any) => i.reel_id),
      },
    });

    likedReels.forEach((reel: any) => {
      reel.tags.forEach((tag: string) => {
        tagFrequency[tag] = (tagFrequency[tag] ?? 0) + 1;
      });
      if (reel.audio_id) {
        audioIds.add(reel.audio_id);
      }
      if (reel.creator_id) {
        creatorIds.add(reel.creator_id.toString());
      }
    });

    // Get top tags
    const topTags = Object.entries(tagFrequency)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([tag]) => tag);

    // Build personalized feed (60%)
    const personalizedCount = Math.floor((limit * 60) / 100);
    const trendingCount = Math.floor((limit * 30) / 100);
    const randomCount = limit - personalizedCount - trendingCount;

    // Fetch personalized reels
    const personalizedReels = await Reel.find({
      $or: [
        { tags: { $in: topTags } },
        {
          creator_id: {
            $in: Array.from(creatorIds).map((id) =>
              Types.ObjectId.createFromHexString(id),
            ),
          },
        },
        { audio_id: { $in: Array.from(audioIds) } },
      ],
      isDeleted: false,
      _id: {
        $nin: userInteractions.map((i: any) => i.reel_id),
      },
    })
      .sort({ created_at: -1 })
      .limit(personalizedCount);

    // Fetch trending reels (30%)
    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const trendingReels = await Reel.find({
      isDeleted: false,
      created_at: { $gte: twentyFourHoursAgo },
      _id: {
        $nin: [
          ...personalizedReels.map((r) => r._id),
          ...userInteractions.map((i: any) => i.reel_id),
        ],
      },
    })
      .sort({ viewCount: -1, shareCount: -1 })
      .limit(trendingCount);

    // Fetch random reels (10% exploration)
    const randomReels = await Reel.find({
      isDeleted: false,
      _id: {
        $nin: [
          ...personalizedReels.map((r) => r._id),
          ...trendingReels.map((r) => r._id),
          ...userInteractions.map((i: any) => i.reel_id),
        ],
      },
    })
      .sort({ created_at: -1 })
      .limit(randomCount);

    // Combine and shuffle
    const feedReels = [...personalizedReels, ...trendingReels, ...randomReels];

    return feedReels;
  } catch (error) {
    console.error("Error getting personalized feed:", error);
    throw error;
  }
};

/**
 * PHASE 3: Handle cold start for new users
 */
export const getColdStartFeed = async (
  userId: string,
  interests: string[] = [],
  language: string = "en",
  limit: number = 20,
): Promise<any[]> => {
  try {
    // Create preference entry for user
    const userObjId = Types.ObjectId.createFromHexString(userId);

    let preference = await UserReelPreference.findOne({ user_id: userObjId });

    if (!preference) {
      preference = new UserReelPreference({
        user_id: userObjId,
        preferred_tags: interests,
        preferred_language: language,
      });
      await preference.save();
    }

    // Serve 60% interest-based + 40% trending
    const interestCount = Math.floor((limit * 60) / 100);
    const trendingCount = limit - interestCount;

    // Fetch interest-based reels
    const interestReels =
      interests.length > 0
        ? await Reel.find({
            tags: { $in: interests },
            language,
            isDeleted: false,
          })
            .sort({ created_at: -1 })
            .limit(interestCount)
        : [];

    // Fetch trending reels with freshness boost
    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const trendingReels = await Reel.find({
      isDeleted: false,
      created_at: { $gte: twentyFourHoursAgo },
      _id: { $nin: interestReels.map((r) => r._id) },
    })
      .sort({ viewCount: -1, likeCount: -1 })
      .limit(trendingCount);

    return [...interestReels, ...trendingReels];
  } catch (error) {
    console.error("Error getting cold start feed:", error);
    throw error;
  }
};

/**
 * Apply freshness boost to new reels (24 hours)
 */
export const applyFreshnessBoost = (
  reel: any,
  boostFactor: number = 1.5,
): number => {
  const createdAt = new Date(reel.created_at);
  const now = new Date();
  const ageInHours = (now.getTime() - createdAt.getTime()) / (1000 * 60 * 60);

  if (ageInHours < 24) {
    return calculateTrendingScore(reel, ageInHours) * boostFactor;
  }

  return calculateTrendingScore(reel, ageInHours);
};
