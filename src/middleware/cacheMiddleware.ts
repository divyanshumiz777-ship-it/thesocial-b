import { Context, Next } from "hono";
import redis from "../lib/redis.ts";

const cacheMiddleware = async (c: Context, next: Next) => {
  if (c.req.method !== "GET") {
    await next();
    return;
  }

  const key = `cache:${c.req.url}`;
  const cached = await redis.get(key);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      return c.json(parsed);
    } catch {
      return c.body(cached, 200, { "content-type": "application/json" });
    }
  }

  await next();

  try {
    if (c.res && c.res.status === 200) {
      const contentType = c.res.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const cloned = c.res.clone();
        const data = await cloned.json();
        await redis.set(key, JSON.stringify(data), "EX", 60);
      }
    }
  } catch {}
};

export default cacheMiddleware;
