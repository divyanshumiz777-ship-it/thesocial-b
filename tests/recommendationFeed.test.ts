import { describe, it, expect, vi, beforeEach } from "vitest";

// Neutralize heavy/transitive imports so importing reelController is hermetic.
vi.mock("../src/lib/redis.ts", () => ({ default: {}, cache: {} }));
vi.mock("../src/lib/aiServiceClient.ts", () => ({
  isRecommendationServiceEnabled: vi.fn(),
  fetchRecommendedFeed: vi.fn(),
}));
vi.mock("../src/lib/reelRecommendation.ts", () => ({
  getPersonalizedFeed: vi.fn(),
}));
vi.mock("../src/lib/chatServiceClient.ts", () => ({
  forwardGenerateReelCaptions: vi.fn(),
}));
vi.mock("../src/models/Reel.ts", () => ({ Reel: { find: vi.fn() } }));

import { resolvePersonalizedFeed } from "../src/controllers/reelController";
import {
  isRecommendationServiceEnabled,
  fetchRecommendedFeed,
} from "../src/lib/aiServiceClient.ts";
import { getPersonalizedFeed } from "../src/lib/reelRecommendation.ts";
import { Reel } from "../src/models/Reel.ts";

const HEURISTIC = [{ _id: "heuristic", videoUrl: "heuristic" }];
const ID_A = "507f1f77bcf86cd799439011";
const ID_B = "507f1f77bcf86cd799439012";

beforeEach(() => {
  vi.clearAllMocks();
  (getPersonalizedFeed as any).mockResolvedValue(HEURISTIC);
});

describe("resolvePersonalizedFeed — gated recommendation integration", () => {
  it("flag OFF → heuristic feed; rec service not called", async () => {
    (isRecommendationServiceEnabled as any).mockReturnValue(false);

    const feed = await resolvePersonalizedFeed("u1", 20);

    expect(feed).toBe(HEURISTIC);
    expect(fetchRecommendedFeed).not.toHaveBeenCalled();
    expect(getPersonalizedFeed).toHaveBeenCalledWith("u1", 20);
  });

  it("flag ON + rec IDs → hydrated feed in rec order; heuristic not called", async () => {
    (isRecommendationServiceEnabled as any).mockReturnValue(true);
    (fetchRecommendedFeed as any).mockResolvedValue([ID_A, ID_B]);
    (Reel.find as any).mockReturnValue({
      // returned out of order to prove ordering is restored from rec IDs
      populate: vi.fn().mockResolvedValue([
        { _id: ID_B, videoUrl: "vB" },
        { _id: ID_A, videoUrl: "vA" },
      ]),
    });

    const feed = await resolvePersonalizedFeed("u1", 20);

    expect(feed.map((r: any) => r._id)).toEqual([ID_A, ID_B]);
    expect(getPersonalizedFeed).not.toHaveBeenCalled();
  });

  it("calls fetchRecommendedFeed with retries: 0 — a single attempt, not fetchRecommendedFeed's own default retry", async () => {
    (isRecommendationServiceEnabled as any).mockReturnValue(true);
    (fetchRecommendedFeed as any).mockResolvedValue(null);

    await resolvePersonalizedFeed("u1", 20);

    expect(fetchRecommendedFeed).toHaveBeenCalledWith("u1", { limit: 20, retries: 0 });
  });

  it("flag ON + rec returns null → fallback to heuristic", async () => {
    (isRecommendationServiceEnabled as any).mockReturnValue(true);
    (fetchRecommendedFeed as any).mockResolvedValue(null);

    const feed = await resolvePersonalizedFeed("u1", 20);

    expect(feed).toBe(HEURISTIC);
    expect(getPersonalizedFeed).toHaveBeenCalledWith("u1", 20);
  });

  it("flag ON + rec throws (service down) → fallback to heuristic", async () => {
    (isRecommendationServiceEnabled as any).mockReturnValue(true);
    (fetchRecommendedFeed as any).mockRejectedValue(new Error("ECONNREFUSED"));

    const feed = await resolvePersonalizedFeed("u1", 20);

    expect(feed).toBe(HEURISTIC);
    expect(getPersonalizedFeed).toHaveBeenCalledWith("u1", 20);
  });

  it("flag ON + rec IDs but hydration empty → fallback to heuristic", async () => {
    (isRecommendationServiceEnabled as any).mockReturnValue(true);
    (fetchRecommendedFeed as any).mockResolvedValue([ID_A]);
    (Reel.find as any).mockReturnValue({
      populate: vi.fn().mockResolvedValue([]),
    });

    const feed = await resolvePersonalizedFeed("u1", 20);

    expect(feed).toBe(HEURISTIC);
    expect(getPersonalizedFeed).toHaveBeenCalled();
  });
});
