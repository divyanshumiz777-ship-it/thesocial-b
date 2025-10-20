import { Context, Next } from "hono";

const rateLimitStore = new Map<string, { count: number; last: number }>();
const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS = 60;

export const rateLimit = async (c: Context, next: Next) => {
  const ip =
    c.req.header("x-forwarded-for") || c.req.header("remote_addr") || "unknown";
  const now = Date.now();
  const entry = rateLimitStore.get(ip) || { count: 0, last: now };
  if (now - entry.last > WINDOW_MS) {
    entry.count = 0;
    entry.last = now;
  }
  entry.count++;
  rateLimitStore.set(ip, entry);
  if (entry.count > MAX_REQUESTS) {
    return c.json({ error: "Rate limit exceeded. Try again later." }, 429);
  }
  await next();
};
