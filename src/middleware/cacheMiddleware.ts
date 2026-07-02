import { Context, Next } from "hono";
import { verify } from "hono/jwt";
import { cache } from "../lib/redis.ts";

const CACHE_TTL = {
  SERVER: 300,
  CHANNEL: 180,
  MESSAGE: 60,
  USER: 600,
  CONVERSATION: 120,
  DEFAULT: 60,
};

const SKIP_CACHE_ROUTES = [
  "/api/v1/auth",
  "/api/v1/user/update",
  "/api/v1/user/settings",
  "/api/v1/dm/send",
  "/api/v1/channel/send-message",
  "/socket.io",
];

function getCacheTTL(url: string): number {
  if (url.includes("/server/get-server")) return CACHE_TTL.SERVER;
  if (url.includes("/channel/")) return CACHE_TTL.CHANNEL;
  if (url.includes("/messages") || url.includes("/get-dm"))
    return CACHE_TTL.MESSAGE;
  if (url.includes("/user/") || url.includes("/user-detail"))
    return CACHE_TTL.USER;
  if (url.includes("/conversations")) return CACHE_TTL.CONVERSATION;
  return CACHE_TTL.DEFAULT;
}

function shouldCache(url: string): boolean {
  return !SKIP_CACHE_ROUTES.some((route) => url.includes(route));
}

/**
 * Resolve the viewer for the cache key by VERIFYING the bearer token.
 *
 * This middleware runs before the route-level authMiddleware, so c.get("user")
 * is never populated here — the previous implementation therefore keyed every
 * entry as "anonymous", sharing one cached response across ALL viewers. For
 * viewer-dependent endpoints (profile privacy views, follow status/lists) that
 * was both a staleness bug and a privacy leak.
 *
 * Verification (HS256, same as authMiddleware) rather than a bare decode is
 * required: an unverified decode would let anyone forge a token with a victim's
 * id and poison that victim's cache entries with anonymous-view responses.
 * Invalid/absent tokens key as "anonymous" — authenticated routes then 401 in
 * authMiddleware and non-200s are never cached, while genuinely public routes
 * share one anonymous entry, which is correct because every anonymous viewer
 * gets the same view.
 */
async function resolveViewerId(c: Context): Promise<string> {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return "anonymous";
  try {
    const payload = (await verify(
      authHeader.slice(7),
      process.env.JWT_SECRET as string,
      "HS256"
    )) as { id?: string | number };
    return payload?.id ? String(payload.id) : "anonymous";
  } catch {
    return "anonymous";
  }
}

function generateCacheKey(c: Context, viewerId: string): string {
  const parsedUrl = new URL(c.req.url);
  return `cache:${viewerId}:${parsedUrl.pathname}${parsedUrl.search}`;
}

const cacheMiddleware = async (c: Context, next: Next) => {
  if (c.req.method !== "GET") {
    await next();
    return;
  }

  const url = c.req.url;

  if (!shouldCache(url)) {
    await next();
    return;
  }

  const viewerId = await resolveViewerId(c);
  const key = generateCacheKey(c, viewerId);

  try {
    const cached = await cache.get(key);
    if (cached) {
      c.header("X-Cache", "HIT");
      return c.json(cached);
    }
  } catch (error) {
    console.error(`Cache GET error:`, error);
  }

  await next();

  try {
    if (c.res && c.res.status === 200) {
      const contentType = c.res.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const cloned = c.res.clone();
        const data = await cloned.json();

        const ttl = getCacheTTL(url);
        await cache.set(key, data, ttl);

        c.header("X-Cache", "MISS");
      }
    }
  } catch (error) {
    console.error(`Cache SET error:`, error);
  }
};

export default cacheMiddleware;
