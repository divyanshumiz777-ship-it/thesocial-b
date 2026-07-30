import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/models/User.ts", () => ({
  default: { findById: vi.fn() },
}));
vi.mock("../src/models/DiscordServer.ts", () => ({
  default: { find: vi.fn() },
}));
vi.mock("../src/models/Conversation.ts", () => ({
  default: { find: vi.fn() },
}));
vi.mock("../src/models/Group.ts", () => ({
  default: { find: vi.fn() },
}));
vi.mock("../src/models/Message.ts", () => ({
  default: { exists: vi.fn() },
}));
vi.mock("../src/models/Reel.ts", () => ({
  Reel: { exists: vi.fn() },
}));
vi.mock("../src/models/Follow.ts", () => ({
  default: { find: vi.fn() },
}));
vi.mock("../src/lib/chatServiceClient.ts", () => ({
  forwardCatchMeUpDigest: vi.fn(),
  isChatServiceEnabled: vi.fn(),
}));

import User from "../src/models/User.ts";
import DiscordServer from "../src/models/DiscordServer.ts";
import Conversation from "../src/models/Conversation.ts";
import Group from "../src/models/Group.ts";
import Message from "../src/models/Message.ts";
import { Reel } from "../src/models/Reel.ts";
import Follow from "../src/models/Follow.ts";
import { forwardCatchMeUpDigest, isChatServiceEnabled } from "../src/lib/chatServiceClient.ts";
import {
  getCatchMeUpEligibility,
  getCatchMeUpDigest,
  ackCatchMeUpDigest,
} from "../src/controllers/digestController.ts";

const ME = "507f1f77bcf86cd799439001";

function selectResolves(value: any) {
  return { select: vi.fn().mockResolvedValue(value) };
}

function distinctResolves(value: any[]) {
  return { distinct: vi.fn().mockResolvedValue(value) };
}

function mockContext() {
  const calls: { body: any; status: number }[] = [];
  const c: any = {
    get: (key: string) => (key === "user" ? { id: ME } : undefined),
    json: (body: any, status = 200) => {
      calls.push({ body, status });
      return { body, status };
    },
  };
  return { c, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
  (DiscordServer.find as any).mockReturnValue(distinctResolves([]));
  (Conversation.find as any).mockReturnValue(distinctResolves([]));
  (Group.find as any).mockReturnValue(distinctResolves([]));
  (Follow.find as any).mockReturnValue(distinctResolves([]));
  (Message.exists as any).mockResolvedValue(false);
  (Reel.exists as any).mockResolvedValue(false);
});

describe("getCatchMeUpEligibility", () => {
  it("is ineligible with no session boundary yet (lastDisconnectedAt never set)", async () => {
    (User.findById as any).mockReturnValue(selectResolves({ lastDisconnectedAt: null, catchMeUpSeenAt: null }));

    const { c, calls } = mockContext();
    await getCatchMeUpEligibility(c);

    expect(calls[0].body).toEqual({ eligible: false, reason: "no-session-boundary-yet" });
  });

  it("is ineligible when away for less than the minimum threshold", async () => {
    const recentDisconnect = new Date(Date.now() - 10 * 60 * 1000); // 10 min ago
    (User.findById as any).mockReturnValue(selectResolves({ lastDisconnectedAt: recentDisconnect, catchMeUpSeenAt: null }));

    const { c, calls } = mockContext();
    await getCatchMeUpEligibility(c);

    expect(calls[0].body.eligible).toBe(false);
    expect(calls[0].body.reason).toBe("not-away-long-enough");
  });

  it("is ineligible when re-prompted within the reprompt interval, even after a long absence", async () => {
    const longAgoDisconnect = new Date(Date.now() - 10 * 60 * 60 * 1000); // 10h ago
    const recentPrompt = new Date(Date.now() - 30 * 60 * 1000); // 30 min ago
    (User.findById as any).mockReturnValue(
      selectResolves({ lastDisconnectedAt: longAgoDisconnect, catchMeUpSeenAt: recentPrompt }),
    );

    const { c, calls } = mockContext();
    await getCatchMeUpEligibility(c);

    expect(calls[0].body.eligible).toBe(false);
    expect(calls[0].body.reason).toBe("reprompt-interval-not-elapsed");
  });

  it("is ineligible when away long enough but there's no new content anywhere", async () => {
    const longAgoDisconnect = new Date(Date.now() - 10 * 60 * 60 * 1000);
    (User.findById as any).mockReturnValue(selectResolves({ lastDisconnectedAt: longAgoDisconnect, catchMeUpSeenAt: null }));
    // all four content probes stay at their default "nothing new" mocks

    const { c, calls } = mockContext();
    await getCatchMeUpEligibility(c);

    expect(calls[0].body.eligible).toBe(false);
    expect(calls[0].body.reason).toBe("no-new-content");
  });

  it("is eligible when away long enough, reprompt interval elapsed, and new content exists", async () => {
    const longAgoDisconnect = new Date(Date.now() - 10 * 60 * 60 * 1000);
    const oldPrompt = new Date(Date.now() - 8 * 60 * 60 * 1000); // 8h ago, past the 4h reprompt floor
    (User.findById as any).mockReturnValue(selectResolves({ lastDisconnectedAt: longAgoDisconnect, catchMeUpSeenAt: oldPrompt }));
    (DiscordServer.find as any).mockReturnValue(distinctResolves(["server1"]));
    (Message.exists as any).mockResolvedValue(true);

    const { c, calls } = mockContext();
    await getCatchMeUpEligibility(c);

    expect(calls[0].body.eligible).toBe(true);
    expect(calls[0].body).toHaveProperty("since");
  });

  it("skips the Message.exists probe entirely when the user belongs to no servers/conversations/groups/follows", async () => {
    const longAgoDisconnect = new Date(Date.now() - 10 * 60 * 60 * 1000);
    (User.findById as any).mockReturnValue(selectResolves({ lastDisconnectedAt: longAgoDisconnect, catchMeUpSeenAt: null }));

    const { c } = mockContext();
    await getCatchMeUpEligibility(c);

    expect(Message.exists).not.toHaveBeenCalled();
    expect(Reel.exists).not.toHaveBeenCalled();
  });
});

describe("getCatchMeUpDigest — no longer mutates state on GET", () => {
  it("does not touch catchMeUpSeenAt or call save", async () => {
    const userDoc: any = { catchMeUpSeenAt: null, save: vi.fn() };
    (User.findById as any).mockReturnValue(selectResolves(userDoc));
    (isChatServiceEnabled as any).mockReturnValue(true);
    (forwardCatchMeUpDigest as any).mockResolvedValue({
      digest: "hi", since: "2026-01-01T00:00:00.000Z", totalMessageCount: 1, totalMentionCount: 0, servers: [],
    });

    const { c, calls } = mockContext();
    await getCatchMeUpDigest(c);

    expect(userDoc.save).not.toHaveBeenCalled();
    expect(calls[0].body.available).toBe(true);
  });

  it("returns an empty-but-valid shape when the chat service is disabled", async () => {
    (User.findById as any).mockReturnValue(selectResolves({ catchMeUpSeenAt: null, save: vi.fn() }));
    (isChatServiceEnabled as any).mockReturnValue(false);

    const { c, calls } = mockContext();
    await getCatchMeUpDigest(c);

    expect(calls[0].body).toEqual(
      expect.objectContaining({ available: false, dmHighlights: [], reelHighlights: [] }),
    );
  });
});

describe("ackCatchMeUpDigest", () => {
  it("advances catchMeUpSeenAt and saves", async () => {
    const userDoc: any = { catchMeUpSeenAt: null, save: vi.fn().mockResolvedValue(true) };
    (User.findById as any).mockReturnValue(selectResolves(userDoc));

    const { c, calls } = mockContext();
    await ackCatchMeUpDigest(c);

    expect(userDoc.catchMeUpSeenAt).toBeInstanceOf(Date);
    expect(userDoc.save).toHaveBeenCalled();
    expect(calls[0].body).toEqual({ success: true });
  });
});
