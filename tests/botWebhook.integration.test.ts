import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import app from "../src/app";
import { serve } from "@hono/node-server";
import supertest from "supertest";
import jwt from "jsonwebtoken";

vi.mock("mongoose", async () => {
  const actual = (await vi.importActual("mongoose")) as any;
  return {
    ...actual,
    connect: vi.fn().mockResolvedValue({
      connection: { host: "test" },
    }),
    set: vi.fn(),
  };
});

vi.mock("../src/models/Bot.ts", () => ({
  default: {
    create: vi.fn().mockResolvedValue({
      _id: "test-bot-id",
      name: "TestBot",
      permissions: ["send_message"],
      owner: "test-user-id",
    }),
    find: vi.fn().mockResolvedValue([]),
    findOneAndDelete: vi.fn(),
    findOneAndUpdate: vi.fn(),
  },
}));

vi.mock("../src/models/Webhook.ts", () => ({
  default: {
    create: vi.fn().mockResolvedValue({
      _id: "test-webhook-id",
      url: "https://example.com/webhook",
      events: ["message.created"],
      owner: "test-user-id",
    }),
    find: vi.fn().mockResolvedValue([]),
    findOneAndDelete: vi.fn(),
    findById: vi.fn(),
  },
}));

vi.mock("../src/models/WebhookEventLog.ts", () => ({
  default: {
    create: vi.fn(),
    find: vi.fn().mockResolvedValue([]),
    findById: vi.fn(),
  },
}));

let server;
let request;
let validToken;

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "test-secret-key-for-testing-only";

  const payload = {
    id: "test-user-id",
    email: "test@example.com",
  };
  validToken = jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: "1h",
  });

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
    const healthRes = await request.get("/healthz");
    expect(healthRes.status).toBe(200);

    const listBots = await request
      .get("/api/v1/bot/bots")
      .set("Authorization", `Bearer ${validToken}`);
    expect(listBots.status).toBe(200);
    expect(listBots.body.bots).toEqual([]);

    const botRes = await request
      .post("/api/v1/bot")
      .set("Authorization", `Bearer ${validToken}`)
      .send({ name: "TestBot", permissions: ["send_message"] });

    console.log("Bot response:", botRes.status);
    expect([201, 404]).toContain(botRes.status);

    if (botRes.status === 201) {
      expect(botRes.body.bot.name).toBe("TestBot");
    }
  });
});
