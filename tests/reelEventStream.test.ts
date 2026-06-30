import { describe, it, expect, vi } from "vitest";

// reelEventStream imports the ioredis client + logger at module load; mock the
// redis module so importing the pure helper opens no real connection.
vi.mock("../src/lib/redis.ts", () => ({ default: {}, cache: {} }));

import { computeCompletionRate } from "../src/lib/reelEventStream.ts";

describe("computeCompletionRate", () => {
  it("computes watch_time / duration", () => {
    expect(computeCompletionRate(5, 10)).toBe(0.5);
  });

  it("clamps to 1 when watch_time exceeds duration", () => {
    expect(computeCompletionRate(20, 10)).toBe(1);
  });

  it("returns null for negative watch_time", () => {
    expect(computeCompletionRate(-5, 10)).toBeNull();
  });

  it("returns null when duration is missing, zero, or invalid", () => {
    expect(computeCompletionRate(5, 0)).toBeNull();
    expect(computeCompletionRate(5, undefined)).toBeNull();
    expect(computeCompletionRate(5, NaN)).toBeNull();
    expect(computeCompletionRate(5, -10)).toBeNull();
  });

  it("returns null when watch_time is missing or non-finite", () => {
    expect(computeCompletionRate(undefined, 10)).toBeNull();
    expect(computeCompletionRate(NaN, 10)).toBeNull();
    expect(computeCompletionRate(Infinity, 10)).toBeNull();
  });
});
