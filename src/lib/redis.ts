import Redis from "ioredis";

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  enableOfflineQueue: true,
  retryStrategy(times) {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  reconnectOnError(err) {
    const targetError = "READONLY";
    if (err.message.includes(targetError)) {
      return true;
    }
    return false;
  },
});

redis.on("connect", () => {
  console.log("✅ Redis connected successfully");
});

redis.on("error", (err) => {
  console.error("❌ Redis connection error:", err.message);
});

redis.on("ready", () => {
  console.log("✅ Redis is ready to accept commands");
});

redis.on("reconnecting", () => {
  console.log("🔄 Redis reconnecting...");
});

process.on("SIGINT", async () => {
  await redis.quit();
  console.log("Redis connection closed");
  process.exit(0);
});

export const cache = {
  async get<T>(key: string): Promise<T | null> {
    try {
      const data = await redis.get(key);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      console.error(`Redis GET error for key ${key}:`, error);
      return null;
    }
  },

  async set(
    key: string,
    value: any,
    ttlSeconds: number = 300
  ): Promise<boolean> {
    try {
      await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
      return true;
    } catch (error) {
      console.error(`Redis SET error for key ${key}:`, error);
      return false;
    }
  },

  async del(key: string): Promise<boolean> {
    try {
      await redis.del(key);
      return true;
    } catch (error) {
      console.error(`Redis DEL error for key ${key}:`, error);
      return false;
    }
  },

  async delPattern(pattern: string): Promise<number> {
    try {
      const keys = await redis.keys(pattern);
      if (keys.length === 0) return 0;
      await redis.del(...keys);
      return keys.length;
    } catch (error) {
      console.error(`Redis DEL pattern error for ${pattern}:`, error);
      return 0;
    }
  },

  async exists(key: string): Promise<boolean> {
    try {
      const result = await redis.exists(key);
      return result === 1;
    } catch (error) {
      console.error(`Redis EXISTS error for key ${key}:`, error);
      return false;
    }
  },

  async expire(key: string, seconds: number): Promise<boolean> {
    try {
      await redis.expire(key, seconds);
      return true;
    } catch (error) {
      console.error(`Redis EXPIRE error for key ${key}:`, error);
      return false;
    }
  },

  async mget<T>(keys: string[]): Promise<(T | null)[]> {
    try {
      const values = await redis.mget(...keys);
      return values.map((v) => (v ? JSON.parse(v) : null));
    } catch (error) {
      console.error(`Redis MGET error:`, error);
      return keys.map(() => null);
    }
  },

  async incr(key: string): Promise<number> {
    try {
      return await redis.incr(key);
    } catch (error) {
      console.error(`Redis INCR error for key ${key}:`, error);
      return 0;
    }
  },

  async setNX(
    key: string,
    value: any,
    ttlSeconds: number = 300
  ): Promise<boolean> {
    try {
      const result = await redis.set(
        key,
        JSON.stringify(value),
        "EX",
        ttlSeconds,
        "NX"
      );
      return result === "OK";
    } catch (error) {
      console.error(`Redis SETNX error for key ${key}:`, error);
      return false;
    }
  },
};

export default redis;
