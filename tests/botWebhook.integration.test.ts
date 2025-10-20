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

describe("Bot & Webhook Integration", () => {
  it("should create a bot and log webhook event", async () => {
    const botRes = await request
      .post("/api/v1/bot")
      .send({ name: "TestBot", permissions: ["send_message"] })
      .set("Authorization", "Bearer testtoken");
    expect(botRes.status).toBe(201);
    expect(botRes.body.bot.name).toBe("TestBot");
  });
});
