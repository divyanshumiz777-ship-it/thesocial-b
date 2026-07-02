import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { sign } from "hono/jwt";

const store = new Map<string, any>();

vi.mock("../src/lib/redis.ts", () => ({
  default: {},
  cache: {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: any) => {
      store.set(key, value);
      return true;
    }),
    del: vi.fn(async (key: string) => store.delete(key)),
    delPattern: vi.fn(async (pattern: string) => {
      // Translate the redis glob to a regex for the in-memory store.
      const re = new RegExp(
        "^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"
      );
      let n = 0;
      for (const key of [...store.keys()]) {
        if (re.test(key)) {
          store.delete(key);
          n++;
        }
      }
      return n;
    }),
  },
}));

import cacheMiddleware from "../src/middleware/cacheMiddleware";
import { CacheInvalidator } from "../src/lib/cacheInvalidation";
import { cache } from "../src/lib/redis.ts";

const SECRET = "test-secret-key-for-testing-only";
const USER_A = "507f1f77bcf86cd799439011";
const USER_B = "507f1f77bcf86cd799439012";

let tokenA: string;
let tokenB: string;
let forgedToken: string;

beforeAll(async () => {
  (process.env as any).JWT_SECRET = SECRET;
  tokenA = await sign({ id: USER_A, email: "a@x.com" }, SECRET, "HS256");
  tokenB = await sign({ id: USER_B, email: "b@x.com" }, SECRET, "HS256");
  // Signed with the WRONG secret but claiming to be user A — must not key as A.
  forgedToken = await sign({ id: USER_A, email: "a@x.com" }, "attacker-secret", "HS256");
});

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
});

/** Minimal Hono-Context stand-in covering exactly what the middleware touches. */
function makeContext(opts: {
  method?: string;
  path?: string;
  token?: string;
  responseBody?: any;
}) {
  const headers: Record<string, string> = {};
  const c: any = {
    req: {
      method: opts.method ?? "GET",
      url: `http://localhost:8000${opts.path ?? "/api/v1/user/user-detail/xyz"}`,
      header: (name: string) =>
        name === "Authorization" && opts.token ? `Bearer ${opts.token}` : undefined,
    },
    res: undefined as Response | undefined,
    header: (k: string, v: string) => {
      headers[k] = v;
    },
    json: (body: any) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  };
  const next = vi.fn(async () => {
    c.res = new Response(JSON.stringify(opts.responseBody ?? { fresh: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { c, next, headers };
}

describe("cacheMiddleware — per-viewer key isolation", () => {
  it("keys a verified token by its user id", async () => {
    const { c, next } = makeContext({ token: tokenA, responseBody: { who: "A" } });
    await cacheMiddleware(c, next);
    expect(next).toHaveBeenCalled();
    expect(store.has(`cache:${USER_A}:/api/v1/user/user-detail/xyz`)).toBe(true);
  });

  it("two different users never share a cache entry for the same path", async () => {
    const a = makeContext({ token: tokenA, responseBody: { who: "A" } });
    await cacheMiddleware(a.c, a.next);

    const b = makeContext({ token: tokenB, responseBody: { who: "B" } });
    await cacheMiddleware(b.c, b.next);

    // B's request must NOT be served A's cached response.
    expect(b.next).toHaveBeenCalled();
    expect(store.get(`cache:${USER_A}:/api/v1/user/user-detail/xyz`)).toEqual({ who: "A" });
    expect(store.get(`cache:${USER_B}:/api/v1/user/user-detail/xyz`)).toEqual({ who: "B" });
  });

  it("a forged token (wrong signature) keys as anonymous — no cache poisoning under the victim's id", async () => {
    const { c, next } = makeContext({ token: forgedToken, responseBody: { who: "anon-view" } });
    await cacheMiddleware(c, next);
    expect(store.has(`cache:${USER_A}:/api/v1/user/user-detail/xyz`)).toBe(false);
    expect(store.has(`cache:anonymous:/api/v1/user/user-detail/xyz`)).toBe(true);
  });

  it("no token keys as anonymous", async () => {
    const { c, next } = makeContext({ responseBody: { who: "anon" } });
    await cacheMiddleware(c, next);
    expect(store.has("cache:anonymous:/api/v1/user/user-detail/xyz")).toBe(true);
  });

  it("serves a HIT from the viewer's own entry without calling next", async () => {
    store.set(`cache:${USER_A}:/api/v1/user/user-detail/xyz`, { cached: true });
    const { c, next } = makeContext({ token: tokenA });
    const res = await cacheMiddleware(c, next);
    expect(next).not.toHaveBeenCalled();
    expect(await (res as Response).json()).toEqual({ cached: true });
  });

  it("skips non-GET requests entirely", async () => {
    const { c, next } = makeContext({ method: "POST", token: tokenA });
    await cacheMiddleware(c, next);
    expect(next).toHaveBeenCalled();
    expect(store.size).toBe(0);
  });
});

describe("CacheInvalidator.invalidateFollowGraph", () => {
  it("evicts both parties' follow namespaces and profile views, across all viewers", async () => {
    // Entries that must be evicted:
    store.set(`cache:${USER_B}:/api/v1/follow/${USER_A}/status`, {});
    store.set(`cache:anonymous:/api/v1/follow/${USER_A}/followers`, {});
    store.set(`cache:${USER_A}:/api/v1/follow/${USER_B}/following?cursor=x`, {});
    store.set(`cache:${USER_A}:/api/v1/follow/suggested`, {});
    store.set(`cache:${USER_B}:/api/v1/user/user-detail/${USER_A}`, {});
    store.set(`cache:anonymous:/api/v1/user/user-detail/${USER_B}`, {});
    // Entry that must SURVIVE (unrelated third parties):
    store.set(`cache:third:/api/v1/user/user-detail/unrelated-user`, {});
    store.set(`cache:third:/api/v1/follow/unrelated-user/status`, {});

    await CacheInvalidator.invalidateFollowGraph(USER_A, USER_B);

    expect(store.has(`cache:${USER_B}:/api/v1/follow/${USER_A}/status`)).toBe(false);
    expect(store.has(`cache:anonymous:/api/v1/follow/${USER_A}/followers`)).toBe(false);
    expect(store.has(`cache:${USER_A}:/api/v1/follow/${USER_B}/following?cursor=x`)).toBe(false);
    expect(store.has(`cache:${USER_A}:/api/v1/follow/suggested`)).toBe(false);
    expect(store.has(`cache:${USER_B}:/api/v1/user/user-detail/${USER_A}`)).toBe(false);
    expect(store.has(`cache:anonymous:/api/v1/user/user-detail/${USER_B}`)).toBe(false);

    expect(store.has(`cache:third:/api/v1/user/user-detail/unrelated-user`)).toBe(true);
    expect(store.has(`cache:third:/api/v1/follow/unrelated-user/status`)).toBe(true);
    expect(cache.delPattern).toHaveBeenCalled();
  });
});
