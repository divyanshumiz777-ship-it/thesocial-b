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
  it("should return status ok", async () => {
    const res = await request.get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(typeof res.body.uptime).toBe("number");
    expect(typeof res.body.timestamp).toBe("number");
  });
});
