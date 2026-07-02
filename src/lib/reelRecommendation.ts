import { Reel } from "../models/Reel.ts";
import { UserReelInteraction } from "../models/UserReelInteraction.ts";
import { UserReelPreference } from "../models/UserReelPreference.ts";
import Follow from "../models/Follow.ts";
import { Types } from "mongoose";
import { cache } from "./redis.ts";

export interface ReelScoreResult {
  reelId: string;
  score: number;
  reason: string;
}

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

  const freshnessBoost = Math.max(0, 10 - reelAgeDays) * 0.5;

  return baseScore + freshnessBoost;
};

export const calculateTrendingScore = (
  reel: any,
  ageInHours: number,
): number => {
  const watchTimeContribution = reel.viewCount / Math.max(1, ageInHours);
  const shareContribution = reel.shareCount * 2;

  return watchTimeContribution + shareContribution;
};

export const getPersonalizedFeed = async (
  userId: string,
  limit: number = 20,
): Promise<any[]> => {
  const cacheKey = `reel:feed:${userId}:${limit}`;
  const cached = await cache.get<any[]>(cacheKey);
  if (cached) return cached;

  try {
    const userObjId = Types.ObjectId.createFromHexString(userId);

    const userInteractions = await UserReelInteraction.find({
      user_id: userObjId,
    })
      .sort({ created_at: -1 })
      .limit(50);

    const tagFrequency: Record<string, number> = {};
    const audioIds = new Set<string>();

    // Real followed-creator signal (was previously derived from a boolean
    // per-reel interaction flag and pushed the wrong id — reel_id instead of
    // the creator's user id — into this set, so it never actually matched
    // anything). Follow.ts now gives us the real graph.
    const followedCreatorIds = await Follow.find({
      follower: userObjId,
      status: "accepted",
    }).distinct("followee");
    const creatorIds = new Set<string>(
      followedCreatorIds.map((id) => id.toString()),
    );

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

    const topTags = Object.entries(tagFrequency)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([tag]) => tag);

    const personalizedCount = Math.floor((limit * 60) / 100);
    const trendingCount = Math.floor((limit * 30) / 100);
    const randomCount = limit - personalizedCount - trendingCount;

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
      .limit(personalizedCount)
      .populate("creator_id", "name profilePic");

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
      .limit(trendingCount)
      .populate("creator_id", "name profilePic");

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
      .limit(randomCount)
      .populate("creator_id", "name profilePic");

    const feedReels = [...personalizedReels, ...trendingReels, ...randomReels];

    await cache.set(cacheKey, feedReels, 300); // 5-min TTL
    return feedReels;
  } catch (error) {
    console.error("Error getting personalized feed:", error);
    throw error;
  }
};

export const getColdStartFeed = async (
  userId: string,
  interests: string[] = [],
  language: string = "en",
  limit: number = 20,
): Promise<any[]> => {
  try {
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

    const interestCount = Math.floor((limit * 60) / 100);
    const trendingCount = limit - interestCount;

    const interestReels =
      interests.length > 0
        ? await Reel.find({
            tags: { $in: interests },
            language,
            isDeleted: false,
          })
            .sort({ created_at: -1 })
            .limit(interestCount)
            .populate("creator_id", "name profilePic")
        : [];

    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const trendingReels = await Reel.find({
      isDeleted: false,
      created_at: { $gte: twentyFourHoursAgo },
      _id: { $nin: interestReels.map((r) => r._id) },
    })
      .sort({ viewCount: -1, likeCount: -1 })
      .limit(trendingCount)
      .populate("creator_id", "name profilePic");

    return [...interestReels, ...trendingReels];
  } catch (error) {
    console.error("Error getting cold start feed:", error);
    throw error;
  }
};

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
