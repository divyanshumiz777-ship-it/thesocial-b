import { describe, it, expect, vi, beforeEach } from "vitest";

// aiServiceClient reads REC_SERVICE_* at module load, so each test sets env
// then dynamically imports a fresh module instance (resetModules).

const ENABLE = () => {
  process.env.REC_SERVICE_ENABLED = "true";
  process.env.REC_SERVICE_URL = "http://rec-service:8001";
  process.env.INTERNAL_SERVICE_TOKEN = "test-token";
};

async function loadClient() {
  return await import("../src/lib/aiServiceClient.ts");
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("fetchRecommendedFeed — gateway → rec service", () => {
  it("returns reel IDs on a valid response", async () => {
    ENABLE();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ items: ["a", "b"] }),
      })),
    );
    const { fetchRecommendedFeed } = await loadClient();
    expect(await fetchRecommendedFeed("u1", {})).toEqual(["a", "b"]);
  });

  it("returns null on an empty items array", async () => {
    ENABLE();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ items: [] }) })),
    );
    const { fetchRecommendedFeed } = await loadClient();
    expect(await fetchRecommendedFeed("u1", {})).toBeNull();
  });

  it("returns null on an invalid response shape", async () => {
    ENABLE();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ nope: true }) })),
    );
    const { fetchRecommendedFeed } = await loadClient();
    expect(await fetchRecommendedFeed("u1", {})).toBeNull();
  });

  it("returns null on a non-OK upstream status", async () => {
    ENABLE();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })),
    );
    const { fetchRecommendedFeed } = await loadClient();
    expect(await fetchRecommendedFeed("u1", { retries: 1 })).toBeNull();
  });

  it("times out and returns null (→ caller falls back)", async () => {
    ENABLE();
    // fetch never resolves until the AbortController fires.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: any) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () =>
              reject(new Error("aborted")),
            );
          }),
      ),
    );
    const { fetchRecommendedFeed } = await loadClient();
    const result = await fetchRecommendedFeed("u1", { timeoutMs: 50, retries: 1 });
    expect(result).toBeNull();
  });

  it("returns null without calling fetch when disabled", async () => {
    process.env.REC_SERVICE_ENABLED = "false";
    process.env.REC_SERVICE_URL = "http://rec-service:8001";
    process.env.INTERNAL_SERVICE_TOKEN = "test-token";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { fetchRecommendedFeed } = await loadClient();
    expect(await fetchRecommendedFeed("u1", {})).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
