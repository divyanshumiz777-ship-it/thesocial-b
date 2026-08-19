import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/models/Message.ts", () => ({
  default: { findById: vi.fn(), find: vi.fn() },
}));
vi.mock("../src/models/User.ts", () => ({
  default: { findById: vi.fn(), find: vi.fn() },
}));
vi.mock("../src/lib/cacheInvalidation.ts", () => ({
  invalidateAfterMessage: vi.fn(),
}));
vi.mock("../src/lib/chatServiceClient.ts", () => ({
  isChatServiceEnabled: () => false,
  forwardDeleteContent: vi.fn(),
}));

import Message from "../src/models/Message.ts";
import User from "../src/models/User.ts";
import { deleteMessage, getMessagesByChannelId } from "../src/controllers/messageController.ts";

const SENDER_ID = "507f1f77bcf86cd799439001";
const OTHER_USER_ID = "507f1f77bcf86cd799439099";
const MESSAGE_ID = "507f1f77bcf86cd799439abc";
const CHANNEL_ID = "507f1f77bcf86cd799439def";

function mockContext(opts: { userId?: string; messageId?: string; body?: any }) {
  const calls: { body: any; status: number }[] = [];
  const io = { to: vi.fn().mockReturnValue({ emit: vi.fn() }) };
  const c: any = {
    get: (key: string) => (key === "user" ? (opts.userId ? { id: opts.userId } : null) : io),
    req: {
      param: () => ({ messageId: opts.messageId ?? MESSAGE_ID }),
      json: async () => opts.body ?? {},
    },
    json: (body: any, status = 200) => {
      calls.push({ body, status });
      return { body, status };
    },
  };
  return { c, calls, io };
}

function makeMessage(overrides: any = {}) {
  return {
    _id: MESSAGE_ID,
    sender: SENDER_ID,
    channel: CHANNEL_ID,
    server: "507f1f77bcf86cd799439fed",
    createdAt: new Date(),
    deletedFor: [] as any[],
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("deleteMessage (channel messages)", () => {
  // Regression test for a confirmed bug: the handler used to destructure a
  // non-existent `user` route param (only :messageId is registered on the
  // route) instead of reading the authenticated user via c.get("user"),
  // which made the sender-equality check always false and 403'd every
  // caller unconditionally — including a message's own sender.
  it("lets the message's own sender delete their own message (for-me)", async () => {
    (Message.findById as any).mockResolvedValue(makeMessage());

    const { c, calls } = mockContext({ userId: SENDER_ID, body: {} });
    await deleteMessage(c);

    expect(calls[0].status).toBe(200);
  });

  it("lets the message's own sender delete their own message (for-everyone)", async () => {
    const message = makeMessage();
    (Message.findById as any).mockResolvedValue(message);

    const { c, calls } = mockContext({ userId: SENDER_ID, body: { deleteType: "for-everyone" } });
    await deleteMessage(c);

    expect(calls[0].status).toBe(200);
    expect(message.deletedForEveryone).toBe(true);
    expect(message.content).toBe("[This message was deleted]");
  });

  it("403s when a different user tries to delete someone else's message", async () => {
    (Message.findById as any).mockResolvedValue(makeMessage());

    const { c, calls } = mockContext({ userId: OTHER_USER_ID, body: {} });
    await deleteMessage(c);

    expect(calls[0].status).toBe(403);
  });

  it("401s when there is no authenticated user", async () => {
    const { c, calls } = mockContext({ userId: undefined, body: {} });
    await deleteMessage(c);

    expect(calls[0].status).toBe(401);
    expect(Message.findById).not.toHaveBeenCalled();
  });

  it("403s a for-everyone delete past the 24h window", async () => {
    const old = makeMessage({ createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) });
    (Message.findById as any).mockResolvedValue(old);

    const { c, calls } = mockContext({ userId: SENDER_ID, body: { deleteType: "for-everyone" } });
    await deleteMessage(c);

    expect(calls[0].status).toBe(403);
    expect(old.save).not.toHaveBeenCalled();
  });

  it("allows a for-me delete past the 24h window (no time restriction on for-me)", async () => {
    const old = makeMessage({ createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) });
    (Message.findById as any).mockResolvedValue(old);

    const { c, calls } = mockContext({ userId: SENDER_ID, body: {} });
    await deleteMessage(c);

    expect(calls[0].status).toBe(200);
    expect(old.deletedFor.map((id: any) => id.toString())).toContain(SENDER_ID);
  });

  it("404s when the message doesn't exist", async () => {
    (Message.findById as any).mockResolvedValue(null);

    const { c, calls } = mockContext({ userId: SENDER_ID, body: {} });
    await deleteMessage(c);

    expect(calls[0].status).toBe(404);
  });
});

function mockChannelReadContext(viewerId: string) {
  const calls: { body: any; status: number }[] = [];
  const c: any = {
    get: (key: string) => (key === "user" ? { id: viewerId } : {}),
    req: {
      param: () => ({ channelId: CHANNEL_ID }),
      query: () => "",
    },
    json: (body: any, status = 200) => {
      calls.push({ body, status });
      return { body, status };
    },
  };
  return { c, calls };
}

function mockFindChain(resolvedMessages: any[]) {
  const chain: any = {
    sort: () => chain,
    skip: () => chain,
    limit: () => chain,
    populate: () => chain,
    then: (resolve: any) => resolve(resolvedMessages),
  };
  return chain;
}

describe("getMessagesByChannelId (channel messages)", () => {
  // Regression test for a confirmed bug: unlike dmController.ts's getDm
  // (which filters `deletedFor: { $ne: user.id }`), this query never
  // excluded messages the viewer had deleted "for me" — a for-me delete
  // would silently reappear on the very next fetch (reconnect resync,
  // remount, pagination).
  it("excludes messages the viewer deleted for-me from the query filter", async () => {
    (User.findById as any).mockReturnValue({ select: () => ({ lean: async () => ({ blockedUsers: [] }) }) });
    (User.find as any).mockReturnValue({ lean: async () => [] });
    (Message.find as any).mockReturnValue(mockFindChain([]));

    const { c } = mockChannelReadContext(SENDER_ID);
    await getMessagesByChannelId(c);

    expect(Message.find).toHaveBeenCalledWith(
      expect.objectContaining({ channel: CHANNEL_ID, deletedFor: { $ne: SENDER_ID } }),
    );
  });
});
