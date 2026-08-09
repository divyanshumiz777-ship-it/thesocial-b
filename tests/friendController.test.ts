import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/models/User.ts", () => ({
  default: { findById: vi.fn(), findOne: vi.fn(), findByIdAndUpdate: vi.fn() },
}));
vi.mock("../src/models/FriendRequest.ts", () => {
  const FriendRequestMock: any = vi.fn().mockImplementation((data: any) => ({
    ...data,
    _id: "newfr1",
    save: vi.fn().mockResolvedValue(true),
    populate: vi.fn().mockResolvedValue(true),
    toObject: () => data,
  }));
  FriendRequestMock.findOne = vi.fn();
  FriendRequestMock.findById = vi.fn();
  return { default: FriendRequestMock };
});
vi.mock("../src/models/Conversation.ts", () => ({ default: {} }));
vi.mock("../src/models/FriendNickname.ts", () => ({ default: {} }));
vi.mock("../src/models/Follow.ts", () => ({ default: {} }));
vi.mock("../src/models/Reel.ts", () => ({ Reel: {} }));
vi.mock("../src/lib/profilePrivacy.ts", () => ({
  buildProfileView: vi.fn(),
  getProfileVisibility: vi.fn(),
}));
vi.mock("../src/controllers/followController.ts", () => ({
  canViewRelationships: vi.fn(),
}));
vi.mock("../src/lib/serverPrivacy.ts", () => ({
  isFriendRequestBlocked: vi.fn().mockResolvedValue(false),
}));
vi.mock("../src/controllers/notificationController.ts", () => ({
  createNotification: vi.fn().mockResolvedValue({ _id: "notif1" }),
  sendNotificationViaSocket: vi.fn(),
}));

const emit = vi.fn();
vi.mock("../src/config/socket.ts", () => ({
  getIoInstance: vi.fn(() => ({ to: () => ({ emit }) })),
}));

import User from "../src/models/User.ts";
import FriendRequest from "../src/models/FriendRequest.ts";
import {
  createNotification,
  sendNotificationViaSocket,
} from "../src/controllers/notificationController.ts";
import {
  sendFriendRequest,
  acceptFriendRequest,
} from "../src/controllers/friendController.ts";

const SENDER_ID = "507f1f77bcf86cd799439001";
const RECEIVER_ID = "507f1f77bcf86cd799439002";
const REQUEST_ID = "507f1f77bcf86cd799439003";

function selectResolves(value: any) {
  return { select: vi.fn().mockResolvedValue(value) };
}

function mockContext(opts: { userId?: string; params?: Record<string, string>; body?: any }) {
  const calls: { body: any; status: number }[] = [];
  const c: any = {
    get: () => ({ id: opts.userId ?? SENDER_ID }),
    req: {
      param: (name: string) => opts.params?.[name],
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
});

describe("sendFriendRequest — push notification delivery", () => {
  it("creates a friend_request notification addressed to the receiver, not just a socket emit", async () => {
    (User.findById as any).mockResolvedValue({ _id: RECEIVER_ID });
    (User.findOne as any).mockResolvedValue(null); // not already friends
    (FriendRequest.findOne as any).mockResolvedValue(null); // no existing request

    const { c, calls } = mockContext({
      userId: SENDER_ID,
      body: { receiverId: RECEIVER_ID },
    });
    await sendFriendRequest(c);

    expect(calls[0].status).toBe(201);
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        recipient: RECEIVER_ID,
        sender: SENDER_ID,
        type: "friend_request",
        actionUrl: `/profile/${SENDER_ID}`,
      })
    );
    expect(sendNotificationViaSocket).toHaveBeenCalledWith(
      expect.anything(),
      RECEIVER_ID,
      { _id: "notif1" }
    );
    // The pre-existing realtime path must still fire too — this is additive,
    // not a replacement.
    expect(emit).toHaveBeenCalledWith(
      "friend_request_received",
      expect.anything()
    );
  });
});

describe("acceptFriendRequest — push notification delivery", () => {
  it("notifies the ORIGINAL sender (not the acceptor) that their request was accepted", async () => {
    const friendRequest: any = {
      _id: REQUEST_ID,
      sender: { toString: () => SENDER_ID },
      receiver: { toString: () => RECEIVER_ID },
      status: "pending",
      save: vi.fn().mockResolvedValue(true),
      populate: vi.fn().mockResolvedValue(true),
      toObject: () => ({ _id: REQUEST_ID }),
    };
    (FriendRequest.findById as any).mockResolvedValue(friendRequest);
    (User.findByIdAndUpdate as any).mockResolvedValue(true);
    (User.findById as any).mockImplementation((id: any) => {
      const idStr = id?.toString?.() ?? id;
      if (idStr === SENDER_ID) return selectResolves({ name: "Original Sender" });
      if (idStr === RECEIVER_ID) return selectResolves({ name: "Accepting User" });
      return selectResolves(null);
    });

    // Accepted BY the receiver.
    const { c, calls } = mockContext({
      userId: RECEIVER_ID,
      params: { requestId: REQUEST_ID },
    });
    await acceptFriendRequest(c);

    expect(calls[0].status).toBe(200);
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        recipient: SENDER_ID, // the original sender, not the acceptor
        sender: RECEIVER_ID,
        type: "friend_accepted",
        actionUrl: `/profile/${RECEIVER_ID}`,
      })
    );
    expect(sendNotificationViaSocket).toHaveBeenCalledWith(
      expect.anything(),
      SENDER_ID,
      { _id: "notif1" }
    );
  });
});
