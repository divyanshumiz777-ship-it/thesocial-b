import { Context, Next } from "hono";
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

function generateCacheKey(c: Context): string {
  const url = c.req.url;
  const user = c.get("user");
  const userId = user?.id || "anonymous";

  const parsedUrl = new URL(url);
  const path = parsedUrl.pathname;
  const query = parsedUrl.search;

  return `cache:${userId}:${path}${query}`;
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

  const key = generateCacheKey(c);

  try {
    const cached = await cache.get(key);
    if (cached) {
      console.log(`✅ Cache HIT: ${key}`);
      c.header("X-Cache", "HIT");
      return c.json(cached);
    }
  } catch (error) {
    console.error(`Cache GET error:`, error);
  }

  console.log(`❌ Cache MISS: ${key}`);

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

        console.log(`💾 Cached response for ${key} (TTL: ${ttl}s)`);
      }
    }
  } catch (error) {
    console.error(`Cache SET error:`, error);
  }
};

export default cacheMiddleware;
