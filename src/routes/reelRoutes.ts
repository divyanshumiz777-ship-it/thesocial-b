import { Hono, Context } from "hono";
import {
  trackReelEvent,
  createReel,
  getReelById,
  getUserReels,
  deleteReel,
  getComments,
  addComment,
  deleteComment,
  toggleCommentLike,
  getUserInteractions,
} from "../controllers/reelController.ts";
import {
  getPersonalizedFeed,
  getColdStartFeed,
} from "../lib/reelRecommendation.ts";
import { authMiddleware } from "../middleware/authMiddleware.ts";

export const reelRouter = new Hono();

reelRouter.use(authMiddleware);

reelRouter.post("/track-event", trackReelEvent);

reelRouter.post("/create", createReel);

// Comment routes — registered before /:reelId to prevent wild-card capture
reelRouter.get("/comments/:commentId/like", toggleCommentLike);
reelRouter.post("/comments/:commentId/like", toggleCommentLike);
reelRouter.delete("/comments/:commentId", deleteComment);

reelRouter.get("/user/:userId", getUserReels);

// User interaction state (liked reels) for a batch of reel IDs
reelRouter.post("/interactions/batch", getUserInteractions);

reelRouter.get("/:reelId/comments", getComments);
reelRouter.post("/:reelId/comments", addComment);

reelRouter.get("/:reelId", getReelById);
reelRouter.delete("/:reelId", deleteReel);

reelRouter.get("/feed/personalized/:userId", async (c: Context) => {
  try {
    const { userId } = c.req.param();
    const limit = Number.parseInt(c.req.query("limit") ?? "20", 10);

    const feed = await getPersonalizedFeed(userId, limit);

    return c.json(
      {
        feed,
        count: feed.length,
        timestamp: new Date().toISOString(),
      },
      200,
    );
  } catch (error) {
    console.error("Error fetching personalized feed:", error);
    return c.json({ error: "Failed to fetch personalized feed" }, 500);
  }
});

reelRouter.post("/feed/cold-start/:userId", async (c: Context) => {
  try {
    const { userId } = c.req.param();
    const { interests, language, limit } = await c.req.json();

    const feed = await getColdStartFeed(
      userId,
      interests ?? [],
      language ?? "en",
      limit ?? 20,
    );

    return c.json(
      {
        feed,
        count: feed.length,
        timestamp: new Date().toISOString(),
      },
      200,
    );
  } catch (error) {
    console.error("Error fetching cold start feed:", error);
    return c.json({ error: "Failed to fetch cold start feed" }, 500);
  }
});

reelRouter.get("/explore/trending", async (c: Context) => {
  try {
    const limit = Number.parseInt(c.req.query("limit") ?? "20", 10);

    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const { Reel } = await import("../models/Reel.ts");

    const trendingReels = await Reel.find({
      isDeleted: false,
      created_at: { $gte: twentyFourHoursAgo },
    })
      .sort({ viewCount: -1, shareCount: -1, likeCount: -1 })
      .limit(limit)
      .populate("creator_id", "name profilePic");

    return c.json(
      {
        reels: trendingReels,
        count: trendingReels.length,
      },
      200,
    );
  } catch (error) {
    console.error("Error fetching trending reels:", error);
    return c.json({ error: "Failed to fetch trending reels" }, 500);
  }
});

reelRouter.get("/explore/tag/:tag", async (c: Context) => {
  try {
    const { tag } = c.req.param();
    const limit = Number.parseInt(c.req.query("limit") ?? "20", 10);

    const { Reel } = await import("../models/Reel.ts");

    const tagReels = await Reel.find({
      tags: tag,
      isDeleted: false,
    })
      .sort({ created_at: -1 })
      .limit(limit)
      .populate("creator_id", "name profilePic");

    return c.json(
      {
        reels: tagReels,
        tag,
        count: tagReels.length,
      },
      200,
    );
  } catch (error) {
    console.error("Error fetching reels by tag:", error);
    return c.json({ error: "Failed to fetch reels by tag" }, 500);
  }
});

reelRouter.get("/explore/all", async (c: Context) => {
  try {
    const page = Number.parseInt(c.req.query("page") ?? "1", 10);
    const limit = Number.parseInt(c.req.query("limit") ?? "20", 10);

    const skip = (page - 1) * limit;

    const { Reel } = await import("../models/Reel.ts");

    const allReels = await Reel.find({ isDeleted: false })
      .sort({ created_at: -1 })
      .skip(skip)
      .limit(limit)
      .populate("creator_id", "name profilePic");

    const total = await Reel.countDocuments({ isDeleted: false });

    return c.json(
      {
        reels: allReels,
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
    console.error("Error fetching all reels:", error);
    return c.json({ error: "Failed to fetch reels" }, 500);
  }
});

reelRouter.get("/analytics/:userId", async (c: Context) => {
  try {
    const { userId } = c.req.param();
    const days = Number.parseInt(c.req.query("days") ?? "7", 10);

    const { getFeedAnalytics } = await import("../lib/reelAnalytics.ts");
    const analytics = await getFeedAnalytics(userId, days);

    return c.json({ analytics, period: days }, 200);
  } catch (error) {
    console.error("Error fetching analytics:", error);
    return c.json({ error: "Failed to fetch analytics" }, 500);
  }
});

reelRouter.get("/tags/recommended/:userId", async (c: Context) => {
  try {
    const { userId } = c.req.param();
    const limit = Number.parseInt(c.req.query("limit") ?? "10", 10);

    const { getRecommendedTags } = await import("../lib/reelAnalytics.ts");
    const tags = await getRecommendedTags(userId, limit);

    return c.json({ tags }, 200);
  } catch (error) {
    console.error("Error fetching recommended tags:", error);
    return c.json({ error: "Failed to fetch recommended tags" }, 500);
  }
});

reelRouter.get("/trending/24h", async (c: Context) => {
  try {
    const limit = Number.parseInt(c.req.query("limit") ?? "10", 10);

    const { getTrendingReels24h } = await import("../lib/reelAnalytics.ts");
    const reels = await getTrendingReels24h(limit);

    return c.json({ reels, count: reels.length }, 200);
  } catch (error) {
    console.error("Error fetching 24h trending reels:", error);
    return c.json({ error: "Failed to fetch trending reels" }, 500);
  }
});

reelRouter.post("/search", async (c: Context) => {
  try {
    const { query, filters, limit } = await c.req.json();

    if (!query) {
      return c.json({ error: "Search query is required" }, 400);
    }

    const { searchReels } = await import("../lib/reelAnalytics.ts");
    const reels = await searchReels(query, filters, limit ?? 20);

    return c.json({ reels, count: reels.length }, 200);
  } catch (error) {
    console.error("Error searching reels:", error);
    return c.json({ error: "Failed to search reels" }, 500);
  }
});
