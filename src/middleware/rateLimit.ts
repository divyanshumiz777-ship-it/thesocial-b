import { Context, Next } from "hono";
import redis from "../lib/redis.ts";

// "Fail open on error" (below) only protects requests from a Redis call
// that actually REJECTS. ioredis's default enableOfflineQueue queues
// commands and keeps retrying while disconnected rather than rejecting
// immediately — so a genuinely unreachable Redis (e.g. REDIS_URL pointing
// at a host the server can't route to) doesn't error, it just never
// settles. That took down every route in production: each request sat
// inside this middleware, awaiting a Redis call that would never resolve
// or reject, until the client itself gave up (visible as HTTP 499s, 44s to
// 5+ minutes each). A race against a short timeout is what actually
// enforces "never block the request", independent of whether Redis fails
// fast, hangs, or is simply slow.
const REDIS_TIMEOUT_MS = 300;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("redis timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

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
  // Razorpay's own signature verification (inside handleRazorpayWebhook) is
  // the real gate here — a per-IP cap tuned for a browser client would risk
  // dropping legitimate webhook deliveries during a burst of renewal events
  // (e.g. many subscriptions all billing on the 1st of the month).
  if (path.startsWith("/api/v1/payments/webhook")) return { window: 60_000, max: 500 };
  // Appeals/reports are low-frequency-legitimate-use, sensitive actions —
  // an unmoderated high-volume path here becomes a harassment vector against
  // whoever ends up reviewing them (admins, the appealed-against user).
  if (path.startsWith("/api/v1/appeals") || path.startsWith("/api/v1/reports/"))
    return { window: 60_000, max: 10 };
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
    const count = (await withTimeout(
      redis.eval(
        SLIDING_WINDOW_SCRIPT,
        1,
        key,
        now.toString(),
        window.toString(),
        max.toString()
      ),
      REDIS_TIMEOUT_MS
    )) as number;

    if (count > max) {
      return c.json({ error: "Rate limit exceeded. Try again later." }, 429);
    }
  } catch {
    // Fail-open: a Redis error OR a timeout (see withTimeout above) should
    // never block requests.
  }

  await next();
};
