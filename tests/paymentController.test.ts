import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/models/Tip.ts", () => ({
  Tip: { aggregate: vi.fn(), create: vi.fn(), findOneAndUpdate: vi.fn(), updateOne: vi.fn() },
}));
vi.mock("../src/models/DiscordServer.ts", () => ({
  default: { find: vi.fn(), findById: vi.fn(), updateOne: vi.fn() },
}));
vi.mock("../src/models/ServerMember.ts", () => ({
  default: { exists: vi.fn(), updateOne: vi.fn() },
}));
vi.mock("../src/models/ServerTier.ts", () => ({
  ServerTier: { find: vi.fn(), findOne: vi.fn(), findById: vi.fn(), create: vi.fn() },
}));
vi.mock("../src/models/TierSubscription.ts", () => ({
  TierSubscription: { aggregate: vi.fn(), findOne: vi.fn(), findOneAndUpdate: vi.fn(), updateOne: vi.fn() },
}));
vi.mock("../src/models/Reel.ts", () => ({
  Reel: { aggregate: vi.fn(), find: vi.fn() },
}));
vi.mock("../src/models/User.ts", () => ({
  default: { findById: vi.fn(), updateOne: vi.fn() },
}));
vi.mock("../src/controllers/notificationController.ts", () => ({
  createNotification: vi.fn(),
  sendNotificationViaSocket: vi.fn(),
}));
vi.mock("../src/config/socket.ts", () => ({
  getIoInstance: vi.fn(() => ({})),
}));
vi.mock("../src/lib/razorpayClient.ts", () => ({
  isRazorpayEnabled: vi.fn(() => true),
  getRazorpayClient: vi.fn(),
  getRazorpayKeyId: vi.fn(() => "rzp_test_key"),
  getWebhookSecret: vi.fn(() => "whsec_test"),
  getPlatformFeePercent: vi.fn(() => 10),
  paiseToFeePaise: vi.fn((amt: number) => Math.round(amt * 0.1)),
  getFrontendUrl: vi.fn(() => "http://localhost:3000"),
  validatePaymentVerification: vi.fn(() => true),
  validateWebhookSignature: vi.fn(() => true),
}));

import { Tip } from "../src/models/Tip.ts";
import DiscordServer from "../src/models/DiscordServer.ts";
import ServerMember from "../src/models/ServerMember.ts";
import { ServerTier } from "../src/models/ServerTier.ts";
import { TierSubscription } from "../src/models/TierSubscription.ts";
import { Reel } from "../src/models/Reel.ts";
import User from "../src/models/User.ts";
import {
  isRazorpayEnabled,
  getRazorpayClient,
  validatePaymentVerification,
  validateWebhookSignature,
} from "../src/lib/razorpayClient.ts";
import { createNotification } from "../src/controllers/notificationController.ts";
import {
  getCreatorRevenueSummary,
  getTipEligibility,
  getTipsEnabledStatus,
  setTipsEnabledStatus,
  createTipOrder,
  verifyTipPayment,
  createServerTier,
  createTierSubscription,
  verifyTierSubscription,
  handleRazorpayWebhook,
} from "../src/controllers/paymentController.ts";

const ME = "507f1f77bcf86cd799439001";
const OTHER = "507f1f77bcf86cd799439002";
const SERVER_ID = "507f1f77bcf86cd799439020";
const TIER_A = "507f1f77bcf86cd799439030";
const TIER_B = "507f1f77bcf86cd799439031";

function mockContext(opts: {
  query?: Record<string, string>;
  params?: Record<string, string>;
  body?: any;
  headers?: Record<string, string>;
  text?: string;
} = {}) {
  const calls: { body: any; status: number }[] = [];
  const c: any = {
    get: (key: string) => (key === "user" ? { id: ME } : undefined),
    req: {
      query: (name: string) => opts.query?.[name],
      param: () => opts.params ?? {},
      json: async () => opts.body ?? {},
      text: async () => opts.text ?? JSON.stringify(opts.body ?? {}),
      header: (name: string) => opts.headers?.[name.toLowerCase()],
    },
    json: (body: any, status = 200) => {
      calls.push({ body, status });
      return { body, status };
    },
  };
  return { c, calls };
}

// Supports both `await X.findById(...).select(...)` (awaited directly) and
// `await X.findById(...).select(...).lean()` — different call sites in
// paymentController.ts use each form.
function selectResolves(value: any) {
  const chain: any = {
    lean: vi.fn().mockResolvedValue(value),
    then: (resolve: any, reject: any) => Promise.resolve(value).then(resolve, reject),
  };
  return { select: vi.fn(() => chain) };
}

function selectSortLimitResolves(value: any) {
  const obj: any = {};
  obj.sort = vi.fn(() => obj);
  obj.limit = vi.fn(() => obj);
  obj.select = vi.fn().mockResolvedValue(value);
  return obj;
}

beforeEach(() => {
  vi.clearAllMocks();
  (isRazorpayEnabled as any).mockReturnValue(true);
  (validatePaymentVerification as any).mockReturnValue(true);
  (validateWebhookSignature as any).mockReturnValue(true);
  (DiscordServer.find as any).mockReturnValue(selectResolves([]));
  (ServerTier.find as any).mockReturnValue(selectResolves([]));
  (TierSubscription.aggregate as any).mockResolvedValue([]);
  (Reel.find as any).mockReturnValue(selectSortLimitResolves([]));
});

describe("getCreatorRevenueSummary — tip earnings", () => {
  it("sums NET earnings (amount minus platform fee), not gross", async () => {
    (Tip.aggregate as any)
      .mockResolvedValueOnce([{ _id: null, netEarningsPaise: 850, tipCount: 2 }]) // all-time
      .mockResolvedValueOnce([]); // trend
    (Reel.aggregate as any).mockResolvedValue([]);

    const { c, calls } = mockContext();
    await getCreatorRevenueSummary(c);

    const firstCallPipeline = (Tip.aggregate as any).mock.calls[0][0];
    const groupStage = firstCallPipeline.find((stage: any) => "$group" in stage);
    expect(groupStage.$group.netEarningsPaise.$sum).toEqual({
      $subtract: ["$amountPaise", "$platformFeePaise"],
    });

    expect(calls[0].status).toBe(200);
    expect(calls[0].body.tips.netEarningsPaiseAllTime).toBe(850);
    expect(calls[0].body.tips.tipCountAllTime).toBe(2);
    expect(calls[0].body.tips.currency).toBe("inr");
  });

  it("only matches status: succeeded — never pending/failed tips", async () => {
    (Tip.aggregate as any).mockResolvedValue([]);
    (Reel.aggregate as any).mockResolvedValue([]);

    const { c } = mockContext();
    await getCreatorRevenueSummary(c);

    const pipeline = (Tip.aggregate as any).mock.calls[0][0];
    const matchStage = pipeline.find((stage: any) => "$match" in stage);
    expect(matchStage.$match.status).toBe("succeeded");
  });

  it("defaults to zero earnings when the creator has no succeeded tips", async () => {
    (Tip.aggregate as any).mockResolvedValue([]);
    (Reel.aggregate as any).mockResolvedValue([]);

    const { c, calls } = mockContext();
    await getCreatorRevenueSummary(c);

    expect(calls[0].body.tips.netEarningsPaiseAllTime).toBe(0);
    expect(calls[0].body.tips.tipCountAllTime).toBe(0);
  });
});

describe("getCreatorRevenueSummary — subscriptions", () => {
  beforeEach(() => {
    (DiscordServer.find as any).mockReturnValue(selectResolves([{ _id: SERVER_ID }]));
    (ServerTier.find as any).mockReturnValue(
      selectResolves([
        { _id: TIER_A, name: "Supporter", amountPaise: 500, currency: "inr", interval: "month", isActive: true },
        { _id: TIER_B, name: "Yearly Supporter", amountPaise: 6000, currency: "inr", interval: "year", isActive: true },
      ]),
    );
    (Tip.aggregate as any).mockResolvedValue([]);
    (Reel.aggregate as any).mockResolvedValue([]);
  });

  it("excludes past_due subscribers from activeSubscriberCount and MRR", async () => {
    (TierSubscription.aggregate as any).mockResolvedValue([
      { _id: { tier: TIER_A, status: "active" }, count: 3 },
      { _id: { tier: TIER_A, status: "past_due" }, count: 2 },
    ]);

    const { c, calls } = mockContext();
    await getCreatorRevenueSummary(c);

    expect(calls[0].body.subscriptions.activeSubscriberCount).toBe(3);
    expect(calls[0].body.subscriptions.pastDueSubscriberCount).toBe(2);
    expect(calls[0].body.subscriptions.mrrPaise).toBe(1500);
  });

  it("normalizes a yearly tier's price to a monthly-equivalent for MRR", async () => {
    (TierSubscription.aggregate as any).mockResolvedValue([
      { _id: { tier: TIER_B, status: "active" }, count: 1 },
    ]);

    const { c, calls } = mockContext();
    await getCreatorRevenueSummary(c);

    expect(calls[0].body.subscriptions.mrrPaise).toBe(500);
  });

  it("returns a zero-value breakdown when the creator owns no servers", async () => {
    (DiscordServer.find as any).mockReturnValue(selectResolves([]));

    const { c, calls } = mockContext();
    await getCreatorRevenueSummary(c);

    expect(calls[0].body.subscriptions.activeSubscriberCount).toBe(0);
    expect(calls[0].body.subscriptions.mrrPaise).toBe(0);
    expect(calls[0].body.subscriptions.tiers).toEqual([]);
    expect(TierSubscription.aggregate).not.toHaveBeenCalled();
  });
});

describe("getCreatorRevenueSummary — reels", () => {
  it("returns reel totals and top reels from the aggregation/query results", async () => {
    (Tip.aggregate as any).mockResolvedValue([]);
    (Reel.aggregate as any).mockResolvedValue([
      { _id: null, reelCount: 4, totalViews: 400, totalLikes: 40, totalShares: 4, totalComments: 8 },
    ]);
    (Reel.find as any).mockReturnValue(
      selectSortLimitResolves([
        { _id: "r1", caption: "Hi", thumbnailUrl: "", viewCount: 100, likeCount: 10, shareCount: 1, commentCount: 2 },
      ]),
    );

    const { c, calls } = mockContext();
    await getCreatorRevenueSummary(c);

    expect(calls[0].body.reels).toEqual({
      reelCount: 4,
      totalViews: 400,
      totalLikes: 40,
      totalShares: 4,
      totalComments: 8,
      topReels: [
        { id: "r1", caption: "Hi", thumbnailUrl: "", viewCount: 100, likeCount: 10, shareCount: 1, commentCount: 2 },
      ],
    });
  });
});

describe("getTipEligibility / tips-enabled toggle", () => {
  it("is ineligible when Razorpay isn't enabled, regardless of the flag", async () => {
    (isRazorpayEnabled as any).mockReturnValue(false);
    const { c, calls } = mockContext({ params: { userId: OTHER } });
    await getTipEligibility(c);
    expect(calls[0].body).toEqual({ eligible: false });
  });

  it("is eligible only when the target user has tipsEnabled: true", async () => {
    (User.findById as any).mockReturnValue(selectResolves({ tipsEnabled: true }));
    const { c, calls } = mockContext({ params: { userId: OTHER } });
    await getTipEligibility(c);
    expect(calls[0].body).toEqual({ eligible: true });
  });

  it("setTipsEnabledStatus persists the toggle", async () => {
    (User.updateOne as any).mockResolvedValue({});
    const { c, calls } = mockContext({ body: { tipsEnabled: true } });
    await setTipsEnabledStatus(c);
    expect(User.updateOne).toHaveBeenCalledWith({ _id: ME }, { $set: { tipsEnabled: true } });
    expect(calls[0].body).toEqual({ tipsEnabled: true });
  });

  it("getTipsEnabledStatus reports the current flag", async () => {
    (User.findById as any).mockReturnValue(selectResolves({ tipsEnabled: true }));
    const { c, calls } = mockContext();
    await getTipsEnabledStatus(c);
    expect(calls[0].body).toEqual({ enabled: true, tipsEnabled: true });
  });
});

describe("createTipOrder", () => {
  const ordersCreate = vi.fn();

  beforeEach(() => {
    (getRazorpayClient as any).mockReturnValue({ orders: { create: ordersCreate } });
    ordersCreate.mockResolvedValue({ id: "order_abc123" });
    (User.findById as any).mockReturnValue(selectResolves({ name: "Creator", tipsEnabled: true }));
    (Tip.create as any).mockResolvedValue({});
  });

  it("400s when tipping yourself", async () => {
    const { c, calls } = mockContext({ body: { recipientUserId: ME, amountPaise: 500 } });
    await createTipOrder(c);
    expect(calls[0].status).toBe(400);
  });

  it("400s below the minimum tip amount", async () => {
    const { c, calls } = mockContext({ body: { recipientUserId: OTHER, amountPaise: 50 } });
    await createTipOrder(c);
    expect(calls[0].status).toBe(400);
  });

  it("400s when the recipient hasn't enabled tips", async () => {
    (User.findById as any).mockReturnValue(selectResolves({ name: "Creator", tipsEnabled: false }));
    const { c, calls } = mockContext({ body: { recipientUserId: OTHER, amountPaise: 500 } });
    await createTipOrder(c);
    expect(calls[0].status).toBe(400);
  });

  it("creates a Razorpay order in INR and a pending Tip record", async () => {
    const { c, calls } = mockContext({ body: { recipientUserId: OTHER, amountPaise: 500, message: "nice!" } });
    await createTipOrder(c);

    expect(ordersCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 500, currency: "INR" }),
    );
    expect(Tip.create).toHaveBeenCalledWith(
      expect.objectContaining({
        sender: ME,
        recipient: OTHER,
        amountPaise: 500,
        razorpayOrderId: "order_abc123",
        status: "pending",
      }),
    );
    expect(calls[0].status).toBe(200);
    expect(calls[0].body.orderId).toBe("order_abc123");
    expect(calls[0].body.currency).toBe("INR");
  });
});

describe("verifyTipPayment", () => {
  it("400s when the signature is invalid", async () => {
    (validatePaymentVerification as any).mockReturnValue(false);
    const { c, calls } = mockContext({
      body: { razorpay_order_id: "order_1", razorpay_payment_id: "pay_1", razorpay_signature: "bad" },
    });
    await verifyTipPayment(c);
    expect(calls[0].status).toBe(400);
    expect(Tip.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("marks the tip succeeded via a status-scoped findOneAndUpdate and notifies the recipient", async () => {
    (Tip.findOneAndUpdate as any).mockResolvedValue({
      sender: ME, recipient: OTHER, amountPaise: 500, message: "hi",
    });
    (User.findById as any).mockReturnValue(selectResolves({ name: "Sender" }));
    (createNotification as any).mockResolvedValue({ _id: "notif1" });

    const { c, calls } = mockContext({
      body: { razorpay_order_id: "order_1", razorpay_payment_id: "pay_1", razorpay_signature: "sig" },
    });
    await verifyTipPayment(c);

    expect(Tip.findOneAndUpdate).toHaveBeenCalledWith(
      { razorpayOrderId: "order_1", status: "pending" },
      { $set: { status: "succeeded", razorpayPaymentId: "pay_1" } },
      { new: true },
    );
    expect(createNotification).toHaveBeenCalled();
    expect(calls[0].body).toEqual({ success: true, alreadyProcessed: false });
  });

  it("is a safe no-op (no duplicate notification) when the webhook already marked it succeeded first", async () => {
    (Tip.findOneAndUpdate as any).mockResolvedValue(null); // status filter matched nothing — already succeeded
    const { c, calls } = mockContext({
      body: { razorpay_order_id: "order_1", razorpay_payment_id: "pay_1", razorpay_signature: "sig" },
    });
    await verifyTipPayment(c);

    expect(createNotification).not.toHaveBeenCalled();
    expect(calls[0].body).toEqual({ success: true, alreadyProcessed: true });
  });
});

describe("createServerTier", () => {
  const plansCreate = vi.fn();

  beforeEach(() => {
    (getRazorpayClient as any).mockReturnValue({ plans: { create: plansCreate } });
    plansCreate.mockResolvedValue({ id: "plan_xyz" });
    (DiscordServer.findById as any).mockReturnValue(selectResolves({ owner: ME, name: "My Server" }));
    (ServerMember.exists as any).mockResolvedValue(true);
    (ServerTier.create as any).mockResolvedValue({ _id: TIER_A });
  });

  it("creates a Razorpay Plan in INR and stores razorpayPlanId — no per-owner payout account check", async () => {
    const { c, calls } = mockContext({
      params: { serverId: SERVER_ID },
      body: { name: "Supporter", amountPaise: 50000, interval: "month" },
    });
    await createServerTier(c);

    expect(plansCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        period: "monthly",
        item: expect.objectContaining({ amount: 50000, currency: "INR" }),
      }),
    );
    expect(ServerTier.create).toHaveBeenCalledWith(
      expect.objectContaining({ razorpayPlanId: "plan_xyz", amountPaise: 50000 }),
    );
    expect(calls[0].status).toBe(201);
  });

  it("403s when the caller isn't an owner/admin", async () => {
    (ServerMember.exists as any).mockResolvedValue(false);
    (DiscordServer.findById as any).mockReturnValue(selectResolves({ owner: OTHER, name: "My Server" }));
    const { c, calls } = mockContext({
      params: { serverId: SERVER_ID },
      body: { name: "Supporter", amountPaise: 50000 },
    });
    await createServerTier(c);
    expect(calls[0].status).toBe(403);
    expect(plansCreate).not.toHaveBeenCalled();
  });
});

describe("createTierSubscription", () => {
  const subscriptionsCreate = vi.fn();

  beforeEach(() => {
    (getRazorpayClient as any).mockReturnValue({ subscriptions: { create: subscriptionsCreate } });
    subscriptionsCreate.mockResolvedValue({ id: "sub_abc" });
    (ServerTier.findOne as any).mockResolvedValue({
      _id: TIER_A, razorpayPlanId: "plan_xyz", interval: "month",
    });
    (TierSubscription.findOne as any).mockResolvedValue(null);
  });

  it("creates a Razorpay Subscription with a finite total_count", async () => {
    const { c, calls } = mockContext({ params: { serverId: SERVER_ID, tierId: TIER_A } });
    await createTierSubscription(c);

    expect(subscriptionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ plan_id: "plan_xyz", total_count: 120, customer_notify: 1 }),
    );
    expect(calls[0].body.subscriptionId).toBe("sub_abc");
  });

  it("400s when the caller already has an active subscription to this server", async () => {
    (TierSubscription.findOne as any).mockResolvedValue({ status: "active" });
    const { c, calls } = mockContext({ params: { serverId: SERVER_ID, tierId: TIER_A } });
    await createTierSubscription(c);
    expect(calls[0].status).toBe(400);
    expect(subscriptionsCreate).not.toHaveBeenCalled();
  });
});

describe("verifyTierSubscription", () => {
  beforeEach(() => {
    (ServerTier.findById as any).mockResolvedValue({ _id: TIER_A, roleName: "supporter" });
    (TierSubscription.findOneAndUpdate as any).mockResolvedValue({});
    (DiscordServer.updateOne as any).mockResolvedValue({});
    (ServerMember.updateOne as any).mockResolvedValue({});
  });

  it("400s on an invalid signature", async () => {
    (validatePaymentVerification as any).mockReturnValue(false);
    const { c, calls } = mockContext({
      params: { serverId: SERVER_ID, tierId: TIER_A },
      body: { razorpay_subscription_id: "sub_1", razorpay_payment_id: "pay_1", razorpay_signature: "bad" },
    });
    await verifyTierSubscription(c);
    expect(calls[0].status).toBe(400);
  });

  it("activates the subscription and grants the tier role", async () => {
    const { c, calls } = mockContext({
      params: { serverId: SERVER_ID, tierId: TIER_A },
      body: { razorpay_subscription_id: "sub_1", razorpay_payment_id: "pay_1", razorpay_signature: "sig" },
    });
    await verifyTierSubscription(c);

    expect(TierSubscription.findOneAndUpdate).toHaveBeenCalledWith(
      { razorpaySubscriptionId: "sub_1" },
      { $set: { user: ME, server: SERVER_ID, tier: TIER_A, status: "active" } },
      { upsert: true },
    );
    expect(DiscordServer.updateOne).toHaveBeenCalled(); // grantTierRole
    expect(calls[0].body).toEqual({ success: true });
  });
});

describe("handleRazorpayWebhook", () => {
  it("400s on an invalid signature", async () => {
    (validateWebhookSignature as any).mockReturnValue(false);
    const { c, calls } = mockContext({
      headers: { "x-razorpay-signature": "bad" },
      text: JSON.stringify({ event: "payment.captured" }),
    });
    await handleRazorpayWebhook(c);
    expect(calls[0].status).toBe(400);
  });

  it("payment.captured marks the matching pending Tip succeeded", async () => {
    (Tip.findOneAndUpdate as any).mockResolvedValue({
      sender: ME, recipient: OTHER, amountPaise: 500,
    });
    (User.findById as any).mockReturnValue(selectResolves({ name: "Sender" }));

    const payload = {
      event: "payment.captured",
      payload: { payment: { entity: { id: "pay_1", order_id: "order_1" } } },
    };
    const { c, calls } = mockContext({
      headers: { "x-razorpay-signature": "sig" },
      text: JSON.stringify(payload),
    });
    await handleRazorpayWebhook(c);

    expect(Tip.findOneAndUpdate).toHaveBeenCalledWith(
      { razorpayOrderId: "order_1", status: "pending" },
      { $set: { status: "succeeded", razorpayPaymentId: "pay_1" } },
      { new: true },
    );
    expect(calls[0].status).toBe(200);
  });

  it("subscription.cancelled marks the subscription canceled and revokes the role", async () => {
    (TierSubscription.findOneAndUpdate as any).mockResolvedValue({
      user: ME, server: SERVER_ID, tier: TIER_A,
    });
    (ServerTier.findById as any).mockResolvedValue({ roleName: "supporter" });
    (DiscordServer.updateOne as any).mockResolvedValue({});
    (ServerMember.updateOne as any).mockResolvedValue({});

    const payload = {
      event: "subscription.cancelled",
      payload: { subscription: { entity: { id: "sub_1" } } },
    };
    const { c, calls } = mockContext({
      headers: { "x-razorpay-signature": "sig" },
      text: JSON.stringify(payload),
    });
    await handleRazorpayWebhook(c);

    expect(TierSubscription.findOneAndUpdate).toHaveBeenCalledWith(
      { razorpaySubscriptionId: "sub_1" },
      { $set: { status: "canceled" } },
    );
    expect(DiscordServer.updateOne).toHaveBeenCalled(); // revokeTierRole
    expect(calls[0].status).toBe(200);
  });

  it("subscription.activated upserts an active TierSubscription and grants the role", async () => {
    (ServerTier.findById as any).mockResolvedValue({ roleName: "supporter" });
    (TierSubscription.findOneAndUpdate as any).mockResolvedValue({});
    (DiscordServer.updateOne as any).mockResolvedValue({});
    (ServerMember.updateOne as any).mockResolvedValue({});

    const payload = {
      event: "subscription.activated",
      payload: {
        subscription: {
          entity: { id: "sub_1", notes: { userId: ME, serverId: SERVER_ID, tierId: TIER_A } },
        },
      },
    };
    const { c, calls } = mockContext({
      headers: { "x-razorpay-signature": "sig" },
      text: JSON.stringify(payload),
    });
    await handleRazorpayWebhook(c);

    expect(TierSubscription.findOneAndUpdate).toHaveBeenCalledWith(
      { razorpaySubscriptionId: "sub_1" },
      { $set: { user: ME, server: SERVER_ID, tier: TIER_A, status: "active" } },
      { upsert: true },
    );
    expect(calls[0].status).toBe(200);
  });

  it("subscription.resumed reactivates the same way as activated/charged", async () => {
    (ServerTier.findById as any).mockResolvedValue({ roleName: "supporter" });
    (TierSubscription.findOneAndUpdate as any).mockResolvedValue({});
    (DiscordServer.updateOne as any).mockResolvedValue({});
    (ServerMember.updateOne as any).mockResolvedValue({});

    const payload = {
      event: "subscription.resumed",
      payload: {
        subscription: {
          entity: { id: "sub_1", notes: { userId: ME, serverId: SERVER_ID, tierId: TIER_A } },
        },
      },
    };
    const { c, calls } = mockContext({
      headers: { "x-razorpay-signature": "sig" },
      text: JSON.stringify(payload),
    });
    await handleRazorpayWebhook(c);

    expect(TierSubscription.findOneAndUpdate).toHaveBeenCalledWith(
      { razorpaySubscriptionId: "sub_1" },
      { $set: { user: ME, server: SERVER_ID, tier: TIER_A, status: "active" } },
      { upsert: true },
    );
    expect(calls[0].status).toBe(200);
  });

  it("subscription.paused marks past_due WITHOUT revoking the role (resumable)", async () => {
    (TierSubscription.updateOne as any).mockResolvedValue({});

    const payload = {
      event: "subscription.paused",
      payload: { subscription: { entity: { id: "sub_1" } } },
    };
    const { c, calls } = mockContext({
      headers: { "x-razorpay-signature": "sig" },
      text: JSON.stringify(payload),
    });
    await handleRazorpayWebhook(c);

    expect(TierSubscription.updateOne).toHaveBeenCalledWith(
      { razorpaySubscriptionId: "sub_1" },
      { $set: { status: "past_due" } },
    );
    expect(DiscordServer.updateOne).not.toHaveBeenCalled();
    expect(calls[0].status).toBe(200);
  });
});
