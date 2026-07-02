import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/models/User.ts", () => ({
  default: { findById: vi.fn(), findByIdAndUpdate: vi.fn() },
}));
vi.mock("../src/models/Conversation.ts", () => ({
  default: { findOne: vi.fn(), findById: vi.fn(), create: vi.fn() },
}));
vi.mock("../src/models/Message.ts", () => ({
  default: { find: vi.fn(), findOne: vi.fn(), countDocuments: vi.fn() },
}));
vi.mock("../src/models/ConversationReadStatus.ts", () => ({
  default: { findOne: vi.fn() },
}));
vi.mock("../src/lib/cacheInvalidation.ts", () => ({
  invalidateAfterDM: vi.fn(),
  invalidateAfterFollowChange: vi.fn(),
}));

import User from "../src/models/User.ts";
import Conversation from "../src/models/Conversation.ts";
import Message from "../src/models/Message.ts";
import ConversationReadStatus from "../src/models/ConversationReadStatus.ts";
import {
  findOrRestoreDm,
  getDm,
  getConversationTheme,
  setConversationTheme,
} from "../src/controllers/dmController.ts";

const ME = "507f1f77bcf86cd799439001";
const FRIEND = "507f1f77bcf86cd799439002";
const STRANGER = "507f1f77bcf86cd799439003";
const BLOCKED_BY_ME = "507f1f77bcf86cd799439004";
const BLOCKS_ME = "507f1f77bcf86cd799439005";
const MISSING = "507f1f77bcf86cd799439099";
const CONV_ID = "507f1f77bcf86cd799439010";

const USERS: Record<string, any> = {
  [ME]: { _id: ME, friends: [FRIEND], blockedUsers: [BLOCKED_BY_ME] },
  [FRIEND]: { _id: FRIEND, blockedUsers: [] },
  [STRANGER]: { _id: STRANGER, blockedUsers: [] },
  [BLOCKED_BY_ME]: { _id: BLOCKED_BY_ME, blockedUsers: [] },
  [BLOCKS_ME]: { _id: BLOCKS_ME, blockedUsers: [ME] },
};

function selectResolves(value: any) {
  return { select: vi.fn().mockResolvedValue(value) };
}

// Minimal thenable query-chain mock: every chain method returns itself, and
// awaiting the chain (at any point) resolves to the same fixed value — mirrors
// how these controllers never call more than one terminal op per query.
function chainable(resolvedValue: any) {
  const obj: any = {};
  obj.sort = vi.fn(() => obj);
  obj.select = vi.fn(() => obj);
  obj.populate = vi.fn(() => obj);
  obj.limit = vi.fn(() => obj);
  obj.skip = vi.fn(() => obj);
  obj.lean = vi.fn(() => Promise.resolve(resolvedValue));
  obj.then = (resolve: any, reject: any) =>
    Promise.resolve(resolvedValue).then(resolve, reject);
  return obj;
}

function makeIo() {
  const emitted: { room: string; event: string; payload: any }[] = [];
  const io: any = {
    to: vi.fn((room: string) => ({
      emit: (event: string, payload: any) => emitted.push({ room, event, payload }),
    })),
  };
  return { io, emitted };
}

function mockContext(opts: {
  userId?: string;
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: any;
  io?: any;
}) {
  const calls: { body: any; status: number }[] = [];
  const c: any = {
    get: (key: string) =>
      key === "user" ? { id: opts.userId ?? ME } : key === "io" ? opts.io : undefined,
    req: {
      param: () => opts.params ?? {},
      query: (name: string) => opts.query?.[name],
      json: async () => opts.body ?? {},
    },
    json: (body: any, status = 200) => {
      calls.push({ body, status });
      return { body, status };
    },
  };
  return { c, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
  (User.findById as any).mockImplementation((id: string) => selectResolves(USERS[id] ?? null));
  (Message.findOne as any).mockReturnValue(chainable(null));
  (Message.countDocuments as any).mockResolvedValue(0);
  (ConversationReadStatus.findOne as any).mockReturnValue(selectResolves(null));
});

describe("findOrRestoreDm", () => {
  it("400s on an invalid receiverId", async () => {
    const { c, calls } = mockContext({ body: { receiverId: "not-an-id" } });
    await findOrRestoreDm(c);
    expect(calls[0].status).toBe(400);
  });

  it("400s when messaging yourself", async () => {
    const { c, calls } = mockContext({ body: { receiverId: ME } });
    await findOrRestoreDm(c);
    expect(calls[0].status).toBe(400);
    expect(calls[0].body.error).toMatch(/yourself/i);
  });

  it("404s when the receiver doesn't exist", async () => {
    const { c, calls } = mockContext({ body: { receiverId: MISSING } });
    await findOrRestoreDm(c);
    expect(calls[0].status).toBe(404);
  });

  it("403s when the receiver has blocked me", async () => {
    const { c, calls } = mockContext({ body: { receiverId: BLOCKS_ME } });
    await findOrRestoreDm(c);
    expect(calls[0].status).toBe(403);
  });

  it("403s when I have blocked the receiver", async () => {
    const { c, calls } = mockContext({ body: { receiverId: BLOCKED_BY_ME } });
    await findOrRestoreDm(c);
    expect(calls[0].status).toBe(403);
  });

  it("403s when not friends", async () => {
    const { c, calls } = mockContext({ body: { receiverId: STRANGER } });
    await findOrRestoreDm(c);
    expect(calls[0].status).toBe(403);
    expect(calls[0].body.error).toMatch(/friends/i);
  });

  it("returns exists:false and does NOT create a conversation when none exists yet", async () => {
    (Conversation.findOne as any).mockResolvedValue(null);
    const { c, calls } = mockContext({ body: { receiverId: FRIEND } });
    await findOrRestoreDm(c);
    expect(calls[0].status).toBe(200);
    expect(calls[0].body).toEqual({ exists: false });
    expect(Conversation.create).not.toHaveBeenCalled();
  });

  it("restores a conversation the caller had hidden, and emits conversation:restored to their own room only", async () => {
    const conv: any = {
      _id: CONV_ID,
      hiddenFor: [ME],
      deletedFor: [],
      deletedAt: new Map(),
      save: vi.fn().mockResolvedValue(true),
    };
    (Conversation.findOne as any).mockResolvedValue(conv);
    const populated = {
      _id: CONV_ID,
      participants: [{ _id: FRIEND, name: "Friend", email: "f@x.com", profilePic: "pic.jpg", lastSeen: new Date() }],
      deletedAt: new Map(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    (Conversation.findById as any).mockReturnValue({ populate: vi.fn().mockResolvedValue(populated) });
    const { io, emitted } = makeIo();

    const { c, calls } = mockContext({ body: { receiverId: FRIEND }, io });
    await findOrRestoreDm(c);

    expect(conv.save).toHaveBeenCalled();
    expect(conv.hiddenFor).not.toContain(ME);
    expect(calls[0].status).toBe(200);
    expect(calls[0].body.exists).toBe(true);
    expect(calls[0].body.conversation._id).toBe(CONV_ID);
    expect(emitted).toEqual([
      { room: ME, event: "conversation:restored", payload: { conversationId: CONV_ID } },
    ]);
  });

  it("returns the existing conversation without touching hidden/deleted state when already visible", async () => {
    const conv: any = {
      _id: CONV_ID,
      hiddenFor: [],
      deletedFor: [],
      deletedAt: new Map(),
      save: vi.fn().mockResolvedValue(true),
    };
    (Conversation.findOne as any).mockResolvedValue(conv);
    const populated = {
      _id: CONV_ID,
      participants: [{ _id: FRIEND, name: "Friend" }],
      deletedAt: new Map(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    (Conversation.findById as any).mockReturnValue({ populate: vi.fn().mockResolvedValue(populated) });
    const { io, emitted } = makeIo();

    const { c, calls } = mockContext({ body: { receiverId: FRIEND }, io });
    await findOrRestoreDm(c);

    expect(conv.save).not.toHaveBeenCalled();
    expect(emitted).toEqual([]);
    expect(calls[0].body.exists).toBe(true);
  });
});

describe("getDm", () => {
  it("400s on an invalid conversationId", async () => {
    const { c, calls } = mockContext({ params: { conversationId: "bad" } });
    await getDm(c);
    expect(calls[0].status).toBe(400);
  });

  it("400s on an invalid cursor", async () => {
    const { c, calls } = mockContext({
      params: { conversationId: CONV_ID },
      query: { cursor: "bad" },
    });
    await getDm(c);
    expect(calls[0].status).toBe(400);
  });

  it("404s when the conversation doesn't exist", async () => {
    (Conversation.findById as any).mockReturnValue(selectResolves(null));
    const { c, calls } = mockContext({ params: { conversationId: CONV_ID } });
    await getDm(c);
    expect(calls[0].status).toBe(404);
  });

  it("403s when the caller is not a participant", async () => {
    (Conversation.findById as any).mockReturnValue(
      selectResolves({ _id: CONV_ID, participants: [FRIEND, STRANGER], deletedAt: new Map() })
    );
    const { c, calls } = mockContext({ params: { conversationId: CONV_ID } });
    await getDm(c);
    expect(calls[0].status).toBe(403);
  });

  it("excludes messages the caller deleted for themselves and returns the cursor shape", async () => {
    (Conversation.findById as any).mockReturnValue(
      selectResolves({ _id: CONV_ID, participants: [ME, FRIEND], deletedAt: new Map() })
    );
    (Message.find as any).mockReturnValue(chainable([]));
    const { c, calls } = mockContext({ params: { conversationId: CONV_ID } });
    await getDm(c);

    expect(Message.find).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: CONV_ID, deletedFor: { $ne: ME } })
    );
    expect(calls[0].status).toBe(200);
    expect(calls[0].body).toHaveProperty("messages");
    expect(calls[0].body).toHaveProperty("nextCursor");
    expect(calls[0].body).toHaveProperty("hasMore");
  });

  it("filters by cursor when provided", async () => {
    (Conversation.findById as any).mockReturnValue(
      selectResolves({ _id: CONV_ID, participants: [ME, FRIEND], deletedAt: new Map() })
    );
    (Message.find as any).mockReturnValue(chainable([]));
    const cursorId = "507f1f77bcf86cd799439077";
    const { c } = mockContext({
      params: { conversationId: CONV_ID },
      query: { cursor: cursorId },
    });
    await getDm(c);
    expect(Message.find).toHaveBeenCalledWith(
      expect.objectContaining({ _id: { $lt: cursorId } })
    );
  });

  it("still respects the caller's per-user deletedAt cutoff", async () => {
    const cutoff = new Date("2026-01-01T00:00:00Z");
    const deletedAt = new Map([[ME, cutoff]]);
    (Conversation.findById as any).mockReturnValue(
      selectResolves({ _id: CONV_ID, participants: [ME, FRIEND], deletedAt })
    );
    (Message.find as any).mockReturnValue(chainable([]));
    const { c } = mockContext({ params: { conversationId: CONV_ID } });
    await getDm(c);
    expect(Message.find).toHaveBeenCalledWith(
      expect.objectContaining({ createdAt: { $gt: cutoff } })
    );
  });

  it("computes hasMore and nextCursor from a limit+1 fetch", async () => {
    (Conversation.findById as any).mockReturnValue(
      selectResolves({ _id: CONV_ID, participants: [ME, FRIEND], deletedAt: new Map() })
    );
    const fakeMsgs = Array.from({ length: 51 }, (_, i) => ({
      _id: `msg-${50 - i}`,
      createdAt: new Date(),
    }));
    (Message.find as any).mockReturnValue(chainable(fakeMsgs));
    const { c, calls } = mockContext({ params: { conversationId: CONV_ID } });
    await getDm(c);

    expect(calls[0].body.hasMore).toBe(true);
    expect(calls[0].body.messages).toHaveLength(50);
    expect(calls[0].body.nextCursor).toBe("msg-1");
  });
});

describe("getConversationTheme", () => {
  it("400s on an invalid conversationId", async () => {
    const { c, calls } = mockContext({ params: { conversationId: "bad" } });
    await getConversationTheme(c);
    expect(calls[0].status).toBe(400);
  });

  it("returns theme:null when the caller has no override for this conversation", async () => {
    (User.findById as any).mockReturnValue(
      selectResolves({ settings: { conversationThemes: new Map() } })
    );
    const { c, calls } = mockContext({ params: { conversationId: CONV_ID } });
    await getConversationTheme(c);
    expect(calls[0].status).toBe(200);
    expect(calls[0].body).toEqual({ theme: null });
  });

  it("returns the caller's stored theme for this conversation", async () => {
    (User.findById as any).mockReturnValue(
      selectResolves({
        settings: { conversationThemes: new Map([[CONV_ID, "discord"]]) },
      })
    );
    const { c, calls } = mockContext({ params: { conversationId: CONV_ID } });
    await getConversationTheme(c);
    expect(calls[0].body).toEqual({ theme: "discord" });
  });
});

describe("setConversationTheme", () => {
  beforeEach(() => {
    (User.findByIdAndUpdate as any).mockResolvedValue({});
  });

  it("400s on an invalid conversationId", async () => {
    const { c, calls } = mockContext({
      params: { conversationId: "bad" },
      body: { theme: "discord" },
    });
    await setConversationTheme(c);
    expect(calls[0].status).toBe(400);
  });

  it("404s when the conversation doesn't exist", async () => {
    (Conversation.findById as any).mockReturnValue(selectResolves(null));
    const { c, calls } = mockContext({
      params: { conversationId: CONV_ID },
      body: { theme: "discord" },
    });
    await setConversationTheme(c);
    expect(calls[0].status).toBe(404);
  });

  it("403s when the caller is not a participant", async () => {
    (Conversation.findById as any).mockReturnValue(
      selectResolves({ participants: [FRIEND, STRANGER] })
    );
    const { c, calls } = mockContext({
      params: { conversationId: CONV_ID },
      body: { theme: "discord" },
    });
    await setConversationTheme(c);
    expect(calls[0].status).toBe(403);
  });

  it("400s on a theme that's neither a known preset nor a valid custom:#hex", async () => {
    (Conversation.findById as any).mockReturnValue(
      selectResolves({ participants: [ME, FRIEND] })
    );
    const { c, calls } = mockContext({
      params: { conversationId: CONV_ID },
      body: { theme: "not-a-real-theme" },
    });
    await setConversationTheme(c);
    expect(calls[0].status).toBe(400);
    expect(User.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("accepts a valid preset, persists it, and notifies only the caller's own room", async () => {
    (Conversation.findById as any).mockReturnValue(
      selectResolves({ participants: [ME, FRIEND] })
    );
    const { io, emitted } = makeIo();
    const { c, calls } = mockContext({
      params: { conversationId: CONV_ID },
      body: { theme: "discord" },
      io,
    });
    await setConversationTheme(c);

    expect(User.findByIdAndUpdate).toHaveBeenCalledWith(
      ME,
      { $set: { [`settings.conversationThemes.${CONV_ID}`]: "discord" } }
    );
    expect(calls[0].status).toBe(200);
    expect(calls[0].body).toEqual({ success: true, theme: "discord" });
    expect(emitted).toEqual([
      {
        room: ME,
        event: "conversation:themeChanged",
        payload: { conversationId: CONV_ID, theme: "discord" },
      },
    ]);
  });

  it("accepts a valid custom:#hex theme", async () => {
    (Conversation.findById as any).mockReturnValue(
      selectResolves({ participants: [ME, FRIEND] })
    );
    const { c, calls } = mockContext({
      params: { conversationId: CONV_ID },
      body: { theme: "custom:#8B5CF6" },
    });
    await setConversationTheme(c);
    expect(calls[0].status).toBe(200);
    expect(calls[0].body.theme).toBe("custom:#8B5CF6");
  });

  it("clears the override (theme: null) by $unset-ing just this conversation's key", async () => {
    (Conversation.findById as any).mockReturnValue(
      selectResolves({ participants: [ME, FRIEND] })
    );
    const { c, calls } = mockContext({
      params: { conversationId: CONV_ID },
      body: { theme: null },
    });
    await setConversationTheme(c);

    expect(User.findByIdAndUpdate).toHaveBeenCalledWith(
      ME,
      { $unset: { [`settings.conversationThemes.${CONV_ID}`]: "" } }
    );
    expect(calls[0].body).toEqual({ success: true, theme: null });
  });
});
