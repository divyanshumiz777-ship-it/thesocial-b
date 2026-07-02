import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/models/User.ts", () => ({
  default: { findById: vi.fn(), find: vi.fn() },
}));
vi.mock("../src/models/Follow.ts", () => ({
  default: {
    findOne: vi.fn(),
    findOneAndDelete: vi.fn(),
    create: vi.fn(),
    countDocuments: vi.fn(),
    exists: vi.fn(),
    find: vi.fn(),
  },
}));
vi.mock("../src/models/Reel.ts", () => ({ Reel: { distinct: vi.fn() } }));
vi.mock("../src/models/UserReelPreference.ts", () => ({
  UserReelPreference: { findOneAndUpdate: vi.fn(), findOne: vi.fn() },
}));
vi.mock("../src/controllers/notificationController.ts", () => ({
  createNotification: vi.fn().mockResolvedValue({ _id: "notif1" }),
  sendNotificationViaSocket: vi.fn(),
}));
vi.mock("../src/config/socket.ts", () => ({
  // No real Socket.IO server in a unit test — matches the "cold start" case
  // safeIo() is explicitly written to handle.
  getIoInstance: vi.fn(() => {
    throw new Error("Socket.IO instance not initialized yet!");
  }),
}));

import User from "../src/models/User.ts";
import Follow from "../src/models/Follow.ts";
import {
  followUser,
  unfollowUser,
  getFollowStatus,
} from "../src/controllers/followController";

const FOLLOWER_ID = "507f1f77bcf86cd799439011";
const PUBLIC_FOLLOWEE_ID = "507f1f77bcf86cd799439012";
const FOLLOWERS_TIER_FOLLOWEE_ID = "507f1f77bcf86cd799439013";
const BLOCKED_ID = "507f1f77bcf86cd799439014";

function selectResolves(value: any) {
  return { select: vi.fn().mockResolvedValue(value) };
}

function mockContext(opts: {
  userId?: string;
  params?: Record<string, string>;
}) {
  const calls: { body: any; status: number }[] = [];
  const c: any = {
    get: () => ({ id: opts.userId ?? FOLLOWER_ID, name: "Follower Name" }),
    req: {
      param: (name: string) => opts.params?.[name],
    },
    json: (body: any, status = 200) => {
      calls.push({ body, status });
      return { body, status };
    },
  };
  return { c, calls };
}

const USERS: Record<string, any> = {
  [FOLLOWER_ID]: { _id: FOLLOWER_ID, name: "Follower Name", profilePic: "", blockedUsers: [] },
  [PUBLIC_FOLLOWEE_ID]: {
    _id: PUBLIC_FOLLOWEE_ID,
    name: "Public Creator",
    settings: { privacy: { profileVisibility: "public" } },
    blockedUsers: [],
  },
  [FOLLOWERS_TIER_FOLLOWEE_ID]: {
    _id: FOLLOWERS_TIER_FOLLOWEE_ID,
    name: "Private Creator",
    settings: { privacy: { profileVisibility: "followers" } },
    blockedUsers: [],
  },
  [BLOCKED_ID]: {
    _id: BLOCKED_ID,
    name: "Blocker",
    settings: { privacy: { profileVisibility: "public" } },
    blockedUsers: [FOLLOWER_ID], // this user has blocked FOLLOWER_ID
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  (User.findById as any).mockImplementation((id: string) => selectResolves(USERS[id]));
  (Follow.countDocuments as any).mockResolvedValue(0);
});

describe("followUser", () => {
  it("rejects following yourself", async () => {
    const { c, calls } = mockContext({ params: { userId: FOLLOWER_ID } });
    await followUser(c);
    expect(calls[0].status).toBe(400);
    expect(calls[0].body.error).toMatch(/yourself/i);
  });

  it("rejects an invalid user id", async () => {
    const { c, calls } = mockContext({ params: { userId: "not-an-id" } });
    await followUser(c);
    expect(calls[0].status).toBe(400);
  });

  it("404s when the target user doesn't exist", async () => {
    (User.findById as any).mockImplementation((id: string) =>
      selectResolves(id === FOLLOWER_ID ? USERS[FOLLOWER_ID] : null)
    );
    const { c, calls } = mockContext({ params: { userId: PUBLIC_FOLLOWEE_ID } });
    await followUser(c);
    expect(calls[0].status).toBe(404);
  });

  it("403s when either side has blocked the other", async () => {
    (Follow.findOne as any).mockResolvedValue(null);
    const { c, calls } = mockContext({ params: { userId: BLOCKED_ID } });
    await followUser(c);
    expect(calls[0].status).toBe(403);
    expect(Follow.create).not.toHaveBeenCalled();
  });

  it("rejects a duplicate follow (already accepted)", async () => {
    (Follow.findOne as any).mockResolvedValue({ status: "accepted" });
    const { c, calls } = mockContext({ params: { userId: PUBLIC_FOLLOWEE_ID } });
    await followUser(c);
    expect(calls[0].status).toBe(400);
    expect(calls[0].body.status).toBe("accepted");
  });

  it("rejects a duplicate follow (already pending)", async () => {
    (Follow.findOne as any).mockResolvedValue({ status: "pending" });
    const { c, calls } = mockContext({ params: { userId: FOLLOWERS_TIER_FOLLOWEE_ID } });
    await followUser(c);
    expect(calls[0].status).toBe(400);
    expect(calls[0].body.status).toBe("pending");
  });

  it("public account → instant accepted follow", async () => {
    (Follow.findOne as any).mockResolvedValue(null);
    (Follow.create as any).mockResolvedValue({
      _id: "follow1",
      status: "accepted",
      createdAt: new Date("2026-01-01"),
    });
    const { c, calls } = mockContext({ params: { userId: PUBLIC_FOLLOWEE_ID } });
    await followUser(c);
    expect(Follow.create).toHaveBeenCalledWith(
      expect.objectContaining({ status: "accepted", follower: FOLLOWER_ID, followee: PUBLIC_FOLLOWEE_ID })
    );
    expect(calls[0].status).toBe(201);
    expect(calls[0].body.status).toBe("accepted");
  });

  it("followers-tier account → pending request, not an instant follow", async () => {
    (Follow.findOne as any).mockResolvedValue(null);
    (Follow.create as any).mockResolvedValue({
      _id: "follow2",
      status: "pending",
      createdAt: new Date("2026-01-01"),
    });
    const { c, calls } = mockContext({ params: { userId: FOLLOWERS_TIER_FOLLOWEE_ID } });
    await followUser(c);
    expect(Follow.create).toHaveBeenCalledWith(
      expect.objectContaining({ status: "pending" })
    );
    expect(calls[0].body.status).toBe("pending");
  });
});

describe("unfollowUser", () => {
  it("404s when there is nothing to unfollow", async () => {
    (Follow.findOneAndDelete as any).mockResolvedValue(null);
    const { c, calls } = mockContext({ params: { userId: PUBLIC_FOLLOWEE_ID } });
    await unfollowUser(c);
    expect(calls[0].status).toBe(404);
  });

  it("removes an accepted follow and reports 'Unfollowed'", async () => {
    (Follow.findOneAndDelete as any).mockResolvedValue({ status: "accepted" });
    const { c, calls } = mockContext({ params: { userId: PUBLIC_FOLLOWEE_ID } });
    await unfollowUser(c);
    expect(calls[0].body.message).toBe("Unfollowed");
  });

  it("cancels a pending request and reports it as cancelled, not unfollowed", async () => {
    (Follow.findOneAndDelete as any).mockResolvedValue({ status: "pending" });
    const { c, calls } = mockContext({ params: { userId: FOLLOWERS_TIER_FOLLOWEE_ID } });
    await unfollowUser(c);
    expect(calls[0].body.message).toBe("Follow request cancelled");
  });
});

describe("getFollowStatus", () => {
  it("reports isSelf and skips all queries when viewing your own status", async () => {
    const { c, calls } = mockContext({ params: { userId: FOLLOWER_ID } });
    await getFollowStatus(c);
    expect(calls[0].body).toEqual({
      isSelf: true,
      isFollowing: false,
      isFollowedBy: false,
      isPendingOutgoing: false,
      isPendingIncoming: false,
      isMutual: false,
    });
    expect(Follow.findOne).not.toHaveBeenCalled();
  });

  it("reports isMutual only when both directions are accepted", async () => {
    (Follow.findOne as any).mockImplementation((query: any) => {
      const resolved =
        query.follower === FOLLOWER_ID
          ? { select: vi.fn().mockResolvedValue({ status: "accepted" }) }
          : { select: vi.fn().mockResolvedValue({ status: "accepted" }) };
      return resolved;
    });
    const { c, calls } = mockContext({ params: { userId: PUBLIC_FOLLOWEE_ID } });
    await getFollowStatus(c);
    expect(calls[0].body.isFollowing).toBe(true);
    expect(calls[0].body.isFollowedBy).toBe(true);
    expect(calls[0].body.isMutual).toBe(true);
  });

  it("a pending outgoing request is not counted as following", async () => {
    (Follow.findOne as any).mockImplementation((query: any) => {
      if (query.follower === FOLLOWER_ID) {
        return { select: vi.fn().mockResolvedValue({ status: "pending" }) };
      }
      return { select: vi.fn().mockResolvedValue(null) };
    });
    const { c, calls } = mockContext({ params: { userId: FOLLOWERS_TIER_FOLLOWEE_ID } });
    await getFollowStatus(c);
    expect(calls[0].body.isFollowing).toBe(false);
    expect(calls[0].body.isPendingOutgoing).toBe(true);
  });
});
