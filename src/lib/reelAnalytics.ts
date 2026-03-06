import { Reel } from "../models/Reel.ts";
import { UserReelInteraction } from "../models/UserReelInteraction.ts";
import { Types } from "mongoose";

/**
 * PHASE 6: Analytics and Monitoring
 * Track key metrics for feed optimization
 */
export interface FeedAnalytics {
  avgWatchTime: number;
  sessionLength: number;
  skipRate: number;
  likeRate: number;
  shareRate: number;
  retentionDay1: number;
  retentionDay7: number;
}

/**
 * Get feed analytics for a specific time period
 */
export const getFeedAnalytics = async (
  userId: string,
  days: number = 7,
): Promise<FeedAnalytics> => {
  try {
    const userObjId = Types.ObjectId.createFromHexString(userId);
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const interactions = await UserReelInteraction.find({
      user_id: userObjId,
      created_at: { $gte: startDate },
    });

    if (interactions.length === 0) {
      return {
        avgWatchTime: 0,
        sessionLength: 0,
        skipRate: 0,
        likeRate: 0,
        shareRate: 0,
        retentionDay1: 0,
        retentionDay7: 0,
      };
    }

    const totalWatchTime = interactions.reduce(
      (sum, i: any) => sum + i.watch_time,
      0,
    );
    const totalSkips = interactions.filter((i: any) => i.skipped).length;
    const totalLikes = interactions.filter((i: any) => i.liked).length;
    const totalShares = interactions.filter((i: any) => i.shared).length;

    // Calculate retention
    const day1Date = new Date();
    day1Date.setDate(day1Date.getDate() - 1);
    const activeToday = interactions.filter(
      (i: any) => i.last_interaction_at > day1Date,
    ).length;

    const day7Date = new Date();
    day7Date.setDate(day7Date.getDate() - 7);
    const activeLastWeek = interactions.filter(
      (i: any) => i.last_interaction_at > day7Date,
    ).length;

    return {
      avgWatchTime: totalWatchTime / interactions.length,
      sessionLength: interactions.length,
      skipRate: totalSkips / interactions.length,
      likeRate: totalLikes / interactions.length,
      shareRate: totalShares / interactions.length,
      retentionDay1: (activeToday / interactions.length) * 100,
      retentionDay7: (activeLastWeek / interactions.length) * 100,
    };
  } catch (error) {
    console.error("Error calculating feed analytics:", error);
    throw error;
  }
};

/**
 * Get recommended tags for a user based on their interactions
 */
export const getRecommendedTags = async (
  userId: string,
  limit: number = 10,
): Promise<string[]> => {
  try {
    const userObjId = Types.ObjectId.createFromHexString(userId);

    // Get user's liked reels
    const likedInteractions = await UserReelInteraction.find({
      user_id: userObjId,
      liked: true,
    }).limit(50);

    const reelIds = likedInteractions.map((i: any) => i.reel_id);

    // Get tags from liked reels
    const reels = await Reel.find({ _id: { $in: reelIds } });

    const tagFrequency: Record<string, number> = {};

    reels.forEach((reel: any) => {
      reel.tags.forEach((tag: string) => {
        tagFrequency[tag] = (tagFrequency[tag] ?? 0) + 1;
      });
    });

    // Return top tags
    return Object.entries(tagFrequency)
      .sort(([, a], [, b]) => b - a)
      .slice(0, limit)
      .map(([tag]) => tag);
  } catch (error) {
    console.error("Error getting recommended tags:", error);
    throw error;
  }
};

/**
 * Get reel trending score for the past 24 hours
 */
export const getTrendingReels24h = async (
  limit: number = 10,
): Promise<any[]> => {
  try {
    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const reels = await Reel.find({
      isDeleted: false,
      created_at: { $gte: twentyFourHoursAgo },
    })
      .sort({
        viewCount: -1,
        shareCount: -1,
        likeCount: -1,
      })
      .limit(limit)
      .populate("creator_id", "name profilePic");

    return reels;
  } catch (error) {
    console.error("Error getting trending reels:", error);
    throw error;
  }
};

/**
 * Get user's interaction history with stats
 */
export const getUserInteractionHistory = async (
  userId: string,
  limit: number = 20,
): Promise<any[]> => {
  try {
    const userObjId = Types.ObjectId.createFromHexString(userId);

    const interactions = await UserReelInteraction.find({
      user_id: userObjId,
    })
      .sort({ created_at: -1 })
      .limit(limit)
      .populate("reel_id");

    return interactions;
  } catch (error) {
    console.error("Error getting user interaction history:", error);
    throw error;
  }
};

/**
 * Search reels by multiple criteria
 */
export const searchReels = async (
  query: string,
  filters?: {
    tags?: string[];
    language?: string;
    creators?: string[];
  },
  limit: number = 20,
): Promise<any[]> => {
  try {
    const searchConditions: any = {
      isDeleted: false,
      $or: [
        { caption: { $regex: query, $options: "i" } },
        { tags: { $in: [new RegExp(query, "i")] } },
      ],
    };

    if (filters?.tags?.length) {
      searchConditions.tags = { $in: filters.tags };
    }

    if (filters?.language) {
      searchConditions.language = filters.language;
    }

    if (filters?.creators?.length) {
      searchConditions.creator_id = {
        $in: filters.creators.map((id) =>
          Types.ObjectId.createFromHexString(id),
        ),
      };
    }

    const reels = await Reel.find(searchConditions)
      .sort({ created_at: -1 })
      .limit(limit)
      .populate("creator_id", "name profilePic");

    return reels;
  } catch (error) {
    console.error("Error searching reels:", error);
    throw error;
  }
};
