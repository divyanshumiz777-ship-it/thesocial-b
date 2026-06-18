import { Context, Next } from "hono";
import redis from "../lib/redis.ts";

// Lua sliding-window script:
// KEYS[1] = sorted-set key
// ARGV[1] = current timestamp (ms)
// ARGV[2] = window size (ms)
// ARGV[3] = max requests
// Returns current request count; 0 means Redis error (fail-open)
const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
redis.call('ZADD', key, now, now)
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)
redis.call('EXPIRE', key, math.ceil(window / 1000))
return count
`;

// Route-class limits
function getLimit(path: string): { window: number; max: number } {
  if (path.startsWith("/api/v1/auth/")) return { window: 60_000, max: 10 };
  if (
    path.startsWith("/api/v1/message/") ||
    path.startsWith("/api/v1/dm/")
  )
    return { window: 60_000, max: 200 };
  return { window: 60_000, max: 60 };
}

function extractIp(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded && process.env.TRUSTED_PROXY === "true") {
    return forwarded.split(",")[0].trim();
  }
  return c.req.header("x-real-ip") || "unknown";
}

export const rateLimit = async (c: Context, next: Next) => {
  const ip = extractIp(c);
  const path = new URL(c.req.url).pathname;
  const { window, max } = getLimit(path);
  const now = Date.now();
  const key = `rl:${ip}:${path.split("/").slice(0, 4).join("/")}`;

  try {
    const count = (await redis.eval(
      SLIDING_WINDOW_SCRIPT,
      1,
      key,
      now.toString(),
      window.toString(),
      max.toString()
    )) as number;

    if (count > max) {
      return c.json({ error: "Rate limit exceeded. Try again later." }, 429);
    }
  } catch {
    // Fail-open: Redis error should not block requests
  }

  await next();
};
