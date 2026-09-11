import { describe, it, expect, beforeAll, afterAll } from "vitest";
import app from "../src/app";
import { serve } from "@hono/node-server";
import supertest from "supertest";

let server;
let request;

beforeAll(async () => {
  server = serve({ fetch: app.fetch, port: 0 });
  await new Promise((resolve) => server.on("listening", resolve));
  const port = server.address().port;
  request = supertest(`http://127.0.0.1:${port}`);
});

afterAll(() => {
  server.close();
});

describe("Health Check Endpoint", () => {
  // /healthz now actually checks Mongo + Redis (see lib/systemHealth.ts)
  // instead of being a pure in-process no-op — this test harness never
  // calls connectDB() (it imports `app` directly, with Mongoose unconnected),
  // so mongo.healthy is expected to be false here even though the endpoint
  // itself is working correctly. Assert the real contract (shape + a status
  // that matches the reported health) rather than hardcoding "always 200".
  it("reports dependency health", async () => {
    const res = await request.get("/healthz");
    expect([200, 503]).toContain(res.status);
    expect(["ok", "degraded"]).toContain(res.body.status);
    expect(typeof res.body.uptime).toBe("number");
    expect(typeof res.body.timestamp).toBe("number");
    expect(typeof res.body.mongo.healthy).toBe("boolean");
    expect(typeof res.body.redis.healthy).toBe("boolean");
    expect(res.body.status).toBe(
      res.body.mongo.healthy && res.body.redis.healthy ? "ok" : "degraded",
    );
  });
});
