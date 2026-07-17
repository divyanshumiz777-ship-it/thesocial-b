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

// vi.mock factories are hoisted above the rest of the file, so this can't
// reference a later `const` — inline the literal and re-declare the const
// below (outside the factories) for use in the actual test bodies.
vi.mock("../src/models/Bot.ts", () => ({
  default: {
    create: vi.fn().mockResolvedValue({
      _id: "test-bot-id",
      name: "TestBot",
      permissions: ["send_message"],
      owner: "test-user-id",
      server: "6a465231c117705c1c2367ff",
    }),
    find: vi.fn().mockResolvedValue([]),
    findById: vi.fn(),
    findOneAndDelete: vi.fn(),
    findOneAndUpdate: vi.fn(),
    findByIdAndDelete: vi.fn(),
    findByIdAndUpdate: vi.fn(),
  },
}));

vi.mock("../src/models/Webhook.ts", () => ({
  default: {
    create: vi.fn().mockResolvedValue({
      _id: "test-webhook-id",
      url: "https://example.com/webhook",
      events: ["message.created"],
      owner: "test-user-id",
      server: "6a465231c117705c1c2367ff",
    }),
    find: vi.fn().mockResolvedValue([]),
    findOneAndDelete: vi.fn(),
    findById: vi.fn(),
    findByIdAndDelete: vi.fn(),
  },
}));

vi.mock("../src/models/WebhookEventLog.ts", () => ({
  default: {
    create: vi.fn(),
    find: vi.fn().mockResolvedValue([]),
    findById: vi.fn(),
  },
}));

// Bots/webhooks are now server-scoped: every mutation checks the acting
// user is an owner/admin of the server (or at least a member, for reads).
// Stub the acting user as that server's owner so these checks pass without
// needing a real DB connection.
vi.mock("../src/models/DiscordServer.ts", () => ({
  default: {
    findById: vi.fn().mockImplementation(() => ({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue({ owner: "test-user-id" }),
    })),
    findOne: vi.fn().mockImplementation(() => ({
      lean: vi.fn().mockResolvedValue({ owner: "test-user-id" }),
    })),
  },
}));

vi.mock("../src/models/ServerMember.ts", () => ({
  default: {
    exists: vi.fn().mockResolvedValue(true),
  },
}));

const TEST_SERVER_ID = "6a465231c117705c1c2367ff";

let server;
let request;
let validToken;

beforeAll(async () => {
  (process.env as any).NODE_ENV = "test";
  (process.env as any).JWT_SECRET = "test-secret-key-for-testing-only";

  const payload = {
    id: "test-user-id",
    email: "test@example.com",
  };
  validToken = jwt.sign(payload, process.env.JWT_SECRET!, {
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
      .get(`/api/v1/bot/bots/${TEST_SERVER_ID}`)
      .set("Authorization", `Bearer ${validToken}`);
    expect(listBots.status).toBe(200);
    expect(listBots.body.bots).toEqual([]);

    const botRes = await request
      .post("/api/v1/bot/bot")
      .set("Authorization", `Bearer ${validToken}`)
      .send({
        name: "TestBot",
        permissions: ["send_message"],
        serverId: TEST_SERVER_ID,
      });

    console.log("Bot response:", botRes.status);
    expect(botRes.status).toBe(201);
    expect(botRes.body.bot.name).toBe("TestBot");
  });

  it("rejects bot creation with no serverId (bots are now server-scoped)", async () => {
    const res = await request
      .post("/api/v1/bot/bot")
      .set("Authorization", `Bearer ${validToken}`)
      .send({ name: "TestBot", permissions: ["send_message"] });
    expect(res.status).toBe(400);
  });
});
