import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/models/User.ts", () => ({
  default: { findById: vi.fn(), findByIdAndUpdate: vi.fn() },
}));
vi.mock("../src/models/Conversation.ts", () => ({
  default: { findById: vi.fn() },
}));
vi.mock("../src/models/Group.ts", () => ({
  default: { findById: vi.fn() },
}));
vi.mock("../src/models/ServerMember.ts", () => ({
  default: { findOne: vi.fn() },
}));
vi.mock("../src/lib/cacheInvalidation.ts", () => ({
  invalidateAfterDM: vi.fn(),
  invalidateAfterFollowChange: vi.fn(),
}));

import User from "../src/models/User.ts";
import Conversation from "../src/models/Conversation.ts";
import Group from "../src/models/Group.ts";
import ServerMember from "../src/models/ServerMember.ts";
import { invalidateAfterDM } from "../src/lib/cacheInvalidation.ts";
import { getChatTheme, setChatTheme } from "../src/controllers/chatThemeController.ts";

const ME = "507f1f77bcf86cd799439001";
const FRIEND = "507f1f77bcf86cd799439002";
const STRANGER = "507f1f77bcf86cd799439003";
const CONV_ID = "507f1f77bcf86cd799439010";
const GROUP_ID = "507f1f77bcf86cd799439011";
const SERVER_ID = "507f1f77bcf86cd799439012";

function selectResolves(value: any) {
  return { select: vi.fn().mockResolvedValue(value) };
}

function leanResolves(value: any) {
  return { select: vi.fn(() => ({ lean: vi.fn().mockResolvedValue(value) })) };
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
  body?: any;
  io?: any;
}) {
  const calls: { body: any; status: number }[] = [];
  const c: any = {
    get: (key: string) =>
      key === "user" ? { id: opts.userId ?? ME } : key === "io" ? opts.io : undefined,
    req: {
      param: () => opts.params ?? {},
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
  (User.findByIdAndUpdate as any).mockResolvedValue({});
});

describe("getChatTheme", () => {
  it("400s on an invalid scope", async () => {
    const { c, calls } = mockContext({ params: { scope: "server", targetId: CONV_ID } });
    await getChatTheme(c);
    expect(calls[0].status).toBe(400);
  });

  it("400s on an invalid targetId", async () => {
    const { c, calls } = mockContext({ params: { scope: "dm", targetId: "bad" } });
    await getChatTheme(c);
    expect(calls[0].status).toBe(400);
  });

  it("returns theme:null with no stored override", async () => {
    (User.findById as any).mockReturnValue(
      selectResolves({ settings: { conversationThemes: new Map() } })
    );
    const { c, calls } = mockContext({ params: { scope: "dm", targetId: CONV_ID } });
    await getChatTheme(c);
    expect(calls[0].body).toEqual({ theme: null });
  });

  it("reads a DM theme under the RAW conversationId key — same key the legacy route used", async () => {
    (User.findById as any).mockReturnValue(
      selectResolves({ settings: { conversationThemes: new Map([[CONV_ID, "indigo"]]) } })
    );
    const { c, calls } = mockContext({ params: { scope: "dm", targetId: CONV_ID } });
    await getChatTheme(c);
    expect(calls[0].body).toEqual({ theme: "indigo" });
  });

  it("reads a group theme under the group:<id> namespaced key", async () => {
    (User.findById as any).mockReturnValue(
      selectResolves({
        settings: { conversationThemes: new Map([[`group:${GROUP_ID}`, "moss"]]) },
      })
    );
    const { c, calls } = mockContext({ params: { scope: "group", targetId: GROUP_ID } });
    await getChatTheme(c);
    expect(calls[0].body).toEqual({ theme: "moss" });
  });

  it("reads a community theme under the server:<id> namespaced key", async () => {
    (User.findById as any).mockReturnValue(
      selectResolves({
        settings: { conversationThemes: new Map([[`server:${SERVER_ID}`, "amber"]]) },
      })
    );
    const { c, calls } = mockContext({ params: { scope: "community", targetId: SERVER_ID } });
    await getChatTheme(c);
    expect(calls[0].body).toEqual({ theme: "amber" });
  });

  it("does NOT check membership on read (mirrors the legacy DM route)", async () => {
    (User.findById as any).mockReturnValue(
      selectResolves({ settings: { conversationThemes: new Map() } })
    );
    const { c, calls } = mockContext({ params: { scope: "community", targetId: SERVER_ID } });
    await getChatTheme(c);
    expect(ServerMember.findOne).not.toHaveBeenCalled();
    expect(calls[0].status).toBe(200);
  });
});

describe("setChatTheme — dm scope", () => {
  it("404s when the conversation doesn't exist", async () => {
    (Conversation.findById as any).mockReturnValue(selectResolves(null));
    const { c, calls } = mockContext({
      params: { scope: "dm", targetId: CONV_ID },
      body: { theme: "indigo" },
    });
    await setChatTheme(c);
    expect(calls[0].status).toBe(404);
  });

  it("403s when the caller is not a participant", async () => {
    (Conversation.findById as any).mockReturnValue(selectResolves({ participants: [FRIEND, STRANGER] }));
    const { c, calls } = mockContext({
      params: { scope: "dm", targetId: CONV_ID },
      body: { theme: "indigo" },
    });
    await setChatTheme(c);
    expect(calls[0].status).toBe(403);
  });

  it("400s on an invalid theme id", async () => {
    (Conversation.findById as any).mockReturnValue(selectResolves({ participants: [ME, FRIEND] }));
    const { c, calls } = mockContext({
      params: { scope: "dm", targetId: CONV_ID },
      body: { theme: "not-a-real-theme" },
    });
    await setChatTheme(c);
    expect(calls[0].status).toBe(400);
    expect(User.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("still accepts a legacy preset id (e.g. discord) for a stale client", async () => {
    (Conversation.findById as any).mockReturnValue(selectResolves({ participants: [ME, FRIEND] }));
    const { c, calls } = mockContext({
      params: { scope: "dm", targetId: CONV_ID },
      body: { theme: "discord" },
    });
    await setChatTheme(c);
    expect(calls[0].status).toBe(200);
  });

  it("persists under the raw conversationId key and emits BOTH the new and legacy socket events", async () => {
    (Conversation.findById as any).mockReturnValue(selectResolves({ participants: [ME, FRIEND] }));
    const { io, emitted } = makeIo();
    const { c, calls } = mockContext({
      params: { scope: "dm", targetId: CONV_ID },
      body: { theme: "indigo" },
      io,
    });
    await setChatTheme(c);

    expect(User.findByIdAndUpdate).toHaveBeenCalledWith(ME, {
      $set: { [`settings.conversationThemes.${CONV_ID}`]: "indigo" },
    });
    expect(calls[0].body).toEqual({ success: true, theme: "indigo" });
    expect(emitted).toEqual([
      { room: ME, event: "chat:themeChanged", payload: { scope: "dm", targetId: CONV_ID, theme: "indigo" } },
      { room: ME, event: "conversation:themeChanged", payload: { conversationId: CONV_ID, theme: "indigo" } },
    ]);
    expect(invalidateAfterDM).toHaveBeenCalledWith(CONV_ID, ME);
  });

  it("clears the override via $unset when theme is null", async () => {
    (Conversation.findById as any).mockReturnValue(selectResolves({ participants: [ME, FRIEND] }));
    const { c, calls } = mockContext({
      params: { scope: "dm", targetId: CONV_ID },
      body: { theme: null },
    });
    await setChatTheme(c);
    expect(User.findByIdAndUpdate).toHaveBeenCalledWith(ME, {
      $unset: { [`settings.conversationThemes.${CONV_ID}`]: "" },
    });
    expect(calls[0].body).toEqual({ success: true, theme: null });
  });
});

describe("setChatTheme — group scope", () => {
  it("404s when the group doesn't exist", async () => {
    (Group.findById as any).mockReturnValue(selectResolves(null));
    const { c, calls } = mockContext({
      params: { scope: "group", targetId: GROUP_ID },
      body: { theme: "moss" },
    });
    await setChatTheme(c);
    expect(calls[0].status).toBe(404);
  });

  it("403s when the caller is not a group participant", async () => {
    (Group.findById as any).mockReturnValue(selectResolves({ participants: [FRIEND] }));
    const { c, calls } = mockContext({
      params: { scope: "group", targetId: GROUP_ID },
      body: { theme: "moss" },
    });
    await setChatTheme(c);
    expect(calls[0].status).toBe(403);
  });

  it("persists a group theme under the group:<id> namespaced key and does not touch invalidateAfterDM", async () => {
    (Group.findById as any).mockReturnValue(selectResolves({ participants: [ME, FRIEND] }));
    const { io, emitted } = makeIo();
    const { c, calls } = mockContext({
      params: { scope: "group", targetId: GROUP_ID },
      body: { theme: "moss" },
      io,
    });
    await setChatTheme(c);

    expect(User.findByIdAndUpdate).toHaveBeenCalledWith(ME, {
      $set: { [`settings.conversationThemes.group:${GROUP_ID}`]: "moss" },
    });
    expect(calls[0].body).toEqual({ success: true, theme: "moss" });
    expect(emitted).toEqual([
      { room: ME, event: "chat:themeChanged", payload: { scope: "group", targetId: GROUP_ID, theme: "moss" } },
    ]);
    expect(invalidateAfterDM).not.toHaveBeenCalled();
  });
});

describe("setChatTheme — community scope", () => {
  it("403s when the caller has no ServerMember record", async () => {
    (ServerMember.findOne as any).mockReturnValue(leanResolves(null));
    const { c, calls } = mockContext({
      params: { scope: "community", targetId: SERVER_ID },
      body: { theme: "amber" },
    });
    await setChatTheme(c);
    expect(calls[0].status).toBe(403);
  });

  it("403s when the caller is banned from the server", async () => {
    (ServerMember.findOne as any).mockReturnValue(
      leanResolves({ banned: { isBanned: true } })
    );
    const { c, calls } = mockContext({
      params: { scope: "community", targetId: SERVER_ID },
      body: { theme: "amber" },
    });
    await setChatTheme(c);
    expect(calls[0].status).toBe(403);
  });

  it("persists a community theme under the server:<id> namespaced key for a valid, unbanned member", async () => {
    (ServerMember.findOne as any).mockReturnValue(leanResolves({ banned: { isBanned: false } }));
    const { c, calls } = mockContext({
      params: { scope: "community", targetId: SERVER_ID },
      body: { theme: "amber" },
    });
    await setChatTheme(c);

    expect(User.findByIdAndUpdate).toHaveBeenCalledWith(ME, {
      $set: { [`settings.conversationThemes.server:${SERVER_ID}`]: "amber" },
    });
    expect(calls[0].body).toEqual({ success: true, theme: "amber" });
  });

  it("ServerMember query is scoped to (server, user) — verifies the exact filter", async () => {
    (ServerMember.findOne as any).mockReturnValue(leanResolves({}));
    const { c } = mockContext({
      params: { scope: "community", targetId: SERVER_ID },
      body: { theme: "amber" },
    });
    await setChatTheme(c);
    expect(ServerMember.findOne).toHaveBeenCalledWith({ server: SERVER_ID, user: ME });
  });
});
