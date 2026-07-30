import { Context } from "hono";
import mongoose from "mongoose";
import DiscordServer from "../models/DiscordServer.ts";
import ServerMember from "../models/ServerMember.ts";
import User from "../models/User.ts";
import { Tip } from "../models/Tip.ts";
import { ServerTier } from "../models/ServerTier.ts";
import { TierSubscription } from "../models/TierSubscription.ts";
import { Reel } from "../models/Reel.ts";
import {
  paiseToFeePaise,
  getPlatformFeePercent,
  getRazorpayClient,
  getRazorpayKeyId,
  getWebhookSecret,
  isRazorpayEnabled,
  validatePaymentVerification,
  validateWebhookSignature,
} from "../lib/razorpayClient.ts";
import { createNotification, sendNotificationViaSocket } from "./notificationController.ts";
import { getIoInstance } from "../config/socket.ts";

const MIN_TIP_PAISE = 100; // ₹1.00 — Razorpay's practical minimum for a card/UPI payment

// ── Feature status ──────────────────────────────────────────────────────────

export const getPaymentsStatus = async (c: Context) => {
  return c.json({
    enabled: isRazorpayEnabled(),
    platformFeePercent: getPlatformFeePercent(),
    keyId: isRazorpayEnabled() ? getRazorpayKeyId() : "",
  });
};

// ── Tip opt-in (replaces Stripe Connect onboarding) ─────────────────────────
//
// Under the collect-only model (see razorpayClient.ts's header comment),
// there's no per-creator payout account to onboard — tips settle to the
// platform's own Razorpay account, tracked per-recipient in Mongo, and paid
// out separately. This is just an explicit opt-in flag a creator can toggle
// so a tip button doesn't appear on every profile unconditionally.

export const getTipsEnabledStatus = async (c: Context) => {
  if (!isRazorpayEnabled()) return c.json({ enabled: false, tipsEnabled: false }, 200);
  const user = c.get("user");
  const userDoc = await User.findById(user.id).select("tipsEnabled").lean();
  return c.json({ enabled: true, tipsEnabled: Boolean(userDoc?.tipsEnabled) }, 200);
};

export const setTipsEnabledStatus = async (c: Context) => {
  if (!isRazorpayEnabled()) return c.json({ error: "Payments are not enabled" }, 503);
  try {
    const user = c.get("user");
    const body = await c.req.json().catch(() => ({}));
    const tipsEnabled = Boolean((body as { tipsEnabled?: boolean }).tipsEnabled);
    await User.updateOne({ _id: user.id }, { $set: { tipsEnabled } });
    return c.json({ tipsEnabled }, 200);
  } catch (error) {
    console.error("Error updating tips-enabled status:", error);
    return c.json({ error: "Failed to update tip settings" }, 500);
  }
};

// Public — lets a profile page decide whether to show a "Send a tip" button
// at all.
export const getTipEligibility = async (c: Context) => {
  if (!isRazorpayEnabled()) return c.json({ eligible: false }, 200);
  try {
    const { userId } = c.req.param();
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return c.json({ eligible: false }, 200);
    }
    const userDoc = await User.findById(userId).select("tipsEnabled").lean();
    return c.json({ eligible: Boolean(userDoc?.tipsEnabled) }, 200);
  } catch (error) {
    console.error("Error checking tip eligibility:", error);
    return c.json({ eligible: false }, 200);
  }
};

// ── Tipping ──────────────────────────────────────────────────────────────────

export const createTipOrder = async (c: Context) => {
  if (!isRazorpayEnabled()) return c.json({ error: "Payments are not enabled" }, 503);
  try {
    const user = c.get("user");
    const body = await c.req.json().catch(() => ({}));
    const { recipientUserId, amountPaise, message } = body as {
      recipientUserId?: string;
      amountPaise?: number;
      message?: string;
    };

    if (!recipientUserId || !mongoose.Types.ObjectId.isValid(recipientUserId)) {
      return c.json({ error: "Invalid recipient" }, 400);
    }
    if (recipientUserId === user.id) {
      return c.json({ error: "You can't tip yourself" }, 400);
    }
    if (!amountPaise || !Number.isInteger(amountPaise) || amountPaise < MIN_TIP_PAISE) {
      return c.json({ error: `Minimum tip is ₹${(MIN_TIP_PAISE / 100).toFixed(2)}` }, 400);
    }

    const recipientUser = await User.findById(recipientUserId).select("name tipsEnabled");
    if (!recipientUser?.tipsEnabled) {
      return c.json({ error: "This creator isn't accepting tips right now" }, 400);
    }

    const razorpay = getRazorpayClient();
    const platformFeePaise = paiseToFeePaise(amountPaise);

    const order = await razorpay.orders.create({
      amount: amountPaise,
      currency: "INR",
      receipt: `tip_${user.id}_${Date.now()}`,
      notes: { senderId: user.id, recipientId: recipientUserId },
    });

    await Tip.create({
      sender: user.id,
      recipient: recipientUserId,
      amountPaise,
      platformFeePaise,
      message: message?.slice(0, 280),
      razorpayOrderId: order.id,
      status: "pending",
    });

    return c.json(
      {
        orderId: order.id,
        amount: amountPaise,
        currency: "INR",
        keyId: getRazorpayKeyId(),
        recipientName: recipientUser.name || "a creator",
      },
      200,
    );
  } catch (error) {
    console.error("Error creating tip order:", error);
    return c.json({ error: "Failed to start tip payment" }, 500);
  }
};

// Client-side confirmation, called right after Razorpay Checkout's success
// handler fires — verifies the signature Razorpay Checkout returned proves
// this really came from Razorpay (see razorpayClient.ts's re-export comment
// on why the exact HMAC construction is delegated to the SDK, not
// hand-rolled here). Optimistic, not authoritative: the status-scoped
// findOneAndUpdate makes this safe to race against the webhook below,
// which remains the source of truth if this call never lands (tab closed
// mid-redirect, network drop).
export const verifyTipPayment = async (c: Context) => {
  if (!isRazorpayEnabled()) return c.json({ error: "Payments are not enabled" }, 503);
  try {
    const body = await c.req.json().catch(() => ({}));
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = body as {
      razorpay_order_id?: string;
      razorpay_payment_id?: string;
      razorpay_signature?: string;
    };

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return c.json({ error: "Missing verification parameters" }, 400);
    }

    const valid = validatePaymentVerification(
      { order_id: razorpay_order_id, payment_id: razorpay_payment_id },
      razorpay_signature,
      process.env.RAZORPAY_KEY_SECRET || "",
    );
    if (!valid) {
      return c.json({ error: "Payment verification failed" }, 400);
    }

    const tip = await markTipSucceeded(razorpay_order_id, razorpay_payment_id);
    return c.json({ success: true, alreadyProcessed: !tip }, 200);
  } catch (error) {
    console.error("Error verifying tip payment:", error);
    return c.json({ error: "Failed to verify payment" }, 500);
  }
};

// Shared by verifyTipPayment and the payment.captured webhook — whichever
// arrives first wins the update (status: "pending" filter makes this
// atomic/idempotent); the loser gets tip: null back and skips the
// notification, so a tip is never announced twice.
async function markTipSucceeded(razorpayOrderId: string, razorpayPaymentId: string) {
  const tip = await Tip.findOneAndUpdate(
    { razorpayOrderId, status: "pending" },
    { $set: { status: "succeeded", razorpayPaymentId } },
    { new: true },
  );
  if (tip) {
    const io = getIoInstance();
    const sender = await User.findById(tip.sender).select("name");
    const notification = await createNotification({
      recipient: tip.recipient.toString(),
      sender: tip.sender.toString(),
      type: "tip_received",
      title: "You received a tip!",
      message: `${sender?.name || "Someone"} sent you a ₹${(tip.amountPaise / 100).toFixed(2)} tip${tip.message ? `: "${tip.message}"` : ""}.`,
      metadata: { amountPaise: tip.amountPaise },
    });
    if (notification) sendNotificationViaSocket(io, tip.recipient.toString(), notification);
  }
  return tip;
}

// ── Paid server tiers ────────────────────────────────────────────────────────

async function isServerOwnerOrAdmin(serverId: string, userId: string): Promise<boolean> {
  const server = await DiscordServer.findById(serverId).select("owner").lean();
  if (!server) return false;
  if (server.owner.toString() === userId) return true;
  return !!(await ServerMember.exists({
    server: serverId,
    user: userId,
    roles: { $in: ["admin", "owner"] },
  }));
}

export const createServerTier = async (c: Context) => {
  if (!isRazorpayEnabled()) return c.json({ error: "Payments are not enabled" }, 503);
  try {
    const user = c.get("user");
    const { serverId } = c.req.param();
    if (!mongoose.Types.ObjectId.isValid(serverId)) {
      return c.json({ error: "Invalid server ID" }, 400);
    }
    if (!(await isServerOwnerOrAdmin(serverId, user.id))) {
      return c.json({ error: "Permission denied" }, 403);
    }

    const server = await DiscordServer.findById(serverId).select("owner name");
    if (!server) return c.json({ error: "Server not found" }, 404);

    const body = await c.req.json().catch(() => ({}));
    const { name, description, amountPaise, interval, roleName } = body as {
      name?: string;
      description?: string;
      amountPaise?: number;
      interval?: "month" | "year";
      roleName?: string;
    };

    if (!name?.trim()) return c.json({ error: "Tier name is required" }, 400);
    if (!amountPaise || !Number.isInteger(amountPaise) || amountPaise < MIN_TIP_PAISE) {
      return c.json({ error: `Minimum price is ₹${(MIN_TIP_PAISE / 100).toFixed(2)}` }, 400);
    }

    const razorpay = getRazorpayClient();
    const plan = await razorpay.plans.create({
      period: interval === "year" ? "yearly" : "monthly",
      interval: 1,
      item: {
        name: `${server.name} — ${name.trim()}`,
        amount: amountPaise,
        currency: "INR",
        description: description?.slice(0, 300),
      },
      notes: { serverId },
    });

    const tier = await ServerTier.create({
      server: serverId,
      name: name.trim(),
      description: description?.slice(0, 300),
      amountPaise,
      interval: interval === "year" ? "year" : "month",
      razorpayPlanId: plan.id,
      roleName: roleName?.trim() || "supporter",
    });

    return c.json({ tier }, 201);
  } catch (error) {
    console.error("Error creating server tier:", error);
    return c.json({ error: "Failed to create tier" }, 500);
  }
};

export const listServerTiers = async (c: Context) => {
  try {
    const { serverId } = c.req.param();
    if (!mongoose.Types.ObjectId.isValid(serverId)) {
      return c.json({ error: "Invalid server ID" }, 400);
    }
    const tiers = await ServerTier.find({ server: serverId, isActive: true })
      .sort({ amountPaise: 1 })
      .lean();
    return c.json({ tiers, enabled: isRazorpayEnabled() }, 200);
  } catch (error) {
    console.error("Error listing server tiers:", error);
    return c.json({ error: "Failed to list tiers" }, 500);
  }
};

export const deactivateServerTier = async (c: Context) => {
  if (!isRazorpayEnabled()) return c.json({ error: "Payments are not enabled" }, 503);
  try {
    const user = c.get("user");
    const { serverId, tierId } = c.req.param();
    if (
      !mongoose.Types.ObjectId.isValid(serverId) ||
      !mongoose.Types.ObjectId.isValid(tierId)
    ) {
      return c.json({ error: "Invalid ID" }, 400);
    }
    if (!(await isServerOwnerOrAdmin(serverId, user.id))) {
      return c.json({ error: "Permission denied" }, 403);
    }

    // Deactivated only — existing subscribers keep their current billing
    // cycle; this just hides the tier from new signups (see listServerTiers'
    // isActive filter). Cancelling live Razorpay subscriptions is a separate,
    // deliberate action, not a side effect of hiding a tier.
    await ServerTier.updateOne({ _id: tierId, server: serverId }, { $set: { isActive: false } });
    return c.json({ message: "Tier deactivated" }, 200);
  } catch (error) {
    console.error("Error deactivating server tier:", error);
    return c.json({ error: "Failed to deactivate tier" }, 500);
  }
};

export const createTierSubscription = async (c: Context) => {
  if (!isRazorpayEnabled()) return c.json({ error: "Payments are not enabled" }, 503);
  try {
    const user = c.get("user");
    const { serverId, tierId } = c.req.param();
    if (
      !mongoose.Types.ObjectId.isValid(serverId) ||
      !mongoose.Types.ObjectId.isValid(tierId)
    ) {
      return c.json({ error: "Invalid ID" }, 400);
    }

    const tier = await ServerTier.findOne({ _id: tierId, server: serverId, isActive: true });
    if (!tier) return c.json({ error: "Tier not found" }, 404);

    const existing = await TierSubscription.findOne({
      user: user.id,
      server: serverId,
      status: "active",
    });
    if (existing) return c.json({ error: "You already support this server" }, 400);

    const razorpay = getRazorpayClient();
    // total_count is required by the Subscriptions API (no "until cancelled"
    // option) — 10 years' worth of cycles is used as a practical ceiling;
    // the subscriber cancels via revokeTierRole/webhook long before it would
    // ever naturally run out.
    const totalCount = tier.interval === "year" ? 10 : 120;

    const subscription = await razorpay.subscriptions.create({
      plan_id: tier.razorpayPlanId,
      total_count: totalCount,
      customer_notify: 1,
      notes: { userId: user.id, serverId, tierId },
    });

    return c.json({ subscriptionId: subscription.id, keyId: getRazorpayKeyId() }, 200);
  } catch (error) {
    console.error("Error creating tier subscription:", error);
    return c.json({ error: "Failed to start subscription" }, 500);
  }
};

// Client-side confirmation counterpart to verifyTipPayment — see that
// function's comment for why this is safe to race against the webhook.
export const verifyTierSubscription = async (c: Context) => {
  if (!isRazorpayEnabled()) return c.json({ error: "Payments are not enabled" }, 503);
  try {
    const user = c.get("user");
    const { serverId, tierId } = c.req.param();
    if (
      !mongoose.Types.ObjectId.isValid(serverId) ||
      !mongoose.Types.ObjectId.isValid(tierId)
    ) {
      return c.json({ error: "Invalid ID" }, 400);
    }

    const body = await c.req.json().catch(() => ({}));
    const { razorpay_subscription_id, razorpay_payment_id, razorpay_signature } = body as {
      razorpay_subscription_id?: string;
      razorpay_payment_id?: string;
      razorpay_signature?: string;
    };

    if (!razorpay_subscription_id || !razorpay_payment_id || !razorpay_signature) {
      return c.json({ error: "Missing verification parameters" }, 400);
    }

    const valid = validatePaymentVerification(
      { subscription_id: razorpay_subscription_id, payment_id: razorpay_payment_id },
      razorpay_signature,
      process.env.RAZORPAY_KEY_SECRET || "",
    );
    if (!valid) {
      return c.json({ error: "Subscription verification failed" }, 400);
    }

    const tier = await ServerTier.findById(tierId);
    if (!tier) return c.json({ error: "Tier not found" }, 404);

    await activateTierSubscription(razorpay_subscription_id, user.id, serverId, tierId, tier.roleName);
    return c.json({ success: true }, 200);
  } catch (error) {
    console.error("Error verifying tier subscription:", error);
    return c.json({ error: "Failed to verify subscription" }, 500);
  }
};

// Shared by verifyTierSubscription and the subscription.activated/charged
// webhook. Upsert + role-grant only happens once per subscription reaching
// "active" — re-running this for an already-active subscription is a no-op
// on the role grant (grantTierRole's $addToSet is itself idempotent too, so
// double-invocation from both paths racing is harmless either way).
async function activateTierSubscription(
  razorpaySubscriptionId: string,
  userId: string,
  serverId: string,
  tierId: string,
  roleName: string,
) {
  await TierSubscription.findOneAndUpdate(
    { razorpaySubscriptionId },
    { $set: { user: userId, server: serverId, tier: tierId, status: "active" } },
    { upsert: true },
  );
  await grantTierRole(userId, serverId, roleName);
}

// ── Webhook ──────────────────────────────────────────────────────────────────

async function grantTierRole(userId: string, serverId: string, roleName: string) {
  await DiscordServer.updateOne(
    { _id: serverId, "members.user": userId },
    { $addToSet: { "members.$.roles": roleName } },
  );
  await ServerMember.updateOne(
    { server: serverId, user: userId },
    { $addToSet: { roles: roleName } },
  );
}

async function revokeTierRole(userId: string, serverId: string, roleName: string) {
  await DiscordServer.updateOne(
    { _id: serverId, "members.user": userId },
    { $pull: { "members.$.roles": roleName } },
  );
  await ServerMember.updateOne(
    { server: serverId, user: userId },
    { $pull: { roles: roleName } },
  );
}

export const handleRazorpayWebhook = async (c: Context) => {
  if (!isRazorpayEnabled()) return c.json({ error: "Payments are not enabled" }, 503);

  const signature = c.req.header("x-razorpay-signature");
  const webhookSecret = getWebhookSecret();
  if (!signature || !webhookSecret) {
    return c.json({ error: "Missing webhook signature" }, 400);
  }

  const rawBody = await c.req.text();
  if (!validateWebhookSignature(rawBody, signature, webhookSecret)) {
    console.error("Razorpay webhook signature verification failed");
    return c.json({ error: "Invalid signature" }, 400);
  }

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "Invalid payload" }, 400);
  }

  try {
    switch (event.event) {
      case "payment.captured": {
        const payment = event.payload?.payment?.entity;
        if (payment?.order_id && payment?.id) {
          await markTipSucceeded(payment.order_id, payment.id);
        }
        break;
      }

      case "payment.failed": {
        const payment = event.payload?.payment?.entity;
        if (payment?.order_id) {
          await Tip.updateOne(
            { razorpayOrderId: payment.order_id, status: "pending" },
            { $set: { status: "failed" } },
          );
        }
        break;
      }

      // subscription.resumed included here (not just activated/charged) —
      // reactivating from a pause should re-affirm "active" the same way,
      // and activateTierSubscription's role grant is idempotent ($addToSet)
      // so re-running it on an already-granted role is harmless.
      case "subscription.activated":
      case "subscription.charged":
      case "subscription.resumed": {
        const subscription = event.payload?.subscription?.entity;
        const notes = subscription?.notes || {};
        if (subscription?.id && notes.userId && notes.serverId && notes.tierId) {
          const tier = await ServerTier.findById(notes.tierId);
          if (tier) {
            await activateTierSubscription(
              subscription.id,
              notes.userId,
              notes.serverId,
              notes.tierId,
              tier.roleName,
            );
          }
        }
        break;
      }

      // subscription.paused is a deliberate pause (resumable), not a failed
      // charge — treated the same as pending/halted (no role revocation,
      // just excluded from activeSubscriberCount/MRR) since it can resume
      // without the creator needing to re-grant anything.
      case "subscription.pending":
      case "subscription.halted":
      case "subscription.paused": {
        const subscription = event.payload?.subscription?.entity;
        if (subscription?.id) {
          await TierSubscription.updateOne(
            { razorpaySubscriptionId: subscription.id },
            { $set: { status: "past_due" } },
          );
        }
        break;
      }

      // Note: "subscription.expired" is NOT a real Razorpay webhook event —
      // it's a status value, not an event name (confirmed against Razorpay's
      // own webhook docs). Don't re-add a case for it; a subscription
      // reaching that status arrives via subscription.completed/cancelled
      // instead, or is only ever observed by fetching the subscription
      // directly, never pushed as its own webhook.
      case "subscription.cancelled":
      case "subscription.completed": {
        const subscription = event.payload?.subscription?.entity;
        if (subscription?.id) {
          const record = await TierSubscription.findOneAndUpdate(
            { razorpaySubscriptionId: subscription.id },
            { $set: { status: "canceled" } },
          );
          if (record) {
            const tier = await ServerTier.findById(record.tier);
            if (tier) await revokeTierRole(record.user.toString(), record.server.toString(), tier.roleName);
          }
        }
        break;
      }

      default:
        break;
    }
  } catch (err) {
    console.error("Error processing Razorpay webhook event:", event?.event, err);
    // Still 200 — Razorpay retries on non-2xx, and a processing bug here
    // shouldn't cause Razorpay to hammer this endpoint indefinitely for an
    // event that will fail the same way every retry.
  }

  return c.json({ received: true }, 200);
};

// ── Creator revenue/analytics dashboard ─────────────────────────────────────

// NOTE: refunds are not yet tracked anywhere in this codebase —
// handleRazorpayWebhook above only reacts to payment.captured/failed and
// subscription.* events, and Tip's status enum has no "refunded" value. A
// tip later refunded through Razorpay directly will still count toward
// netEarningsPaise below until a refund.* webhook handler + a Tip
// "refunded" status are added. Flagging here rather than silently
// overcounting without documentation.

export const getCreatorRevenueSummary = async (c: Context) => {
  try {
    const userId = c.get("user").id;
    const userObjId = new mongoose.Types.ObjectId(userId);

    const days = Math.min(Math.max(parseInt(c.req.query("days") || "30", 10) || 30, 7), 90);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const dayFormat = { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "UTC" } };

    const [tipTotals, tipTrend, ownedServers, reelTotals, topReels] = await Promise.all([
      // All-time net earnings — net of the platform fee, i.e. what's owed
      // to the creator once payouts are settled, not the raw tip amount.
      Tip.aggregate([
        { $match: { recipient: userObjId, status: "succeeded" } },
        {
          $group: {
            _id: null,
            netEarningsPaise: { $sum: { $subtract: ["$amountPaise", "$platformFeePaise"] } },
            tipCount: { $sum: 1 },
          },
        },
      ]),
      Tip.aggregate([
        { $match: { recipient: userObjId, status: "succeeded", createdAt: { $gte: since } } },
        {
          $group: {
            _id: dayFormat,
            netEarningsPaise: { $sum: { $subtract: ["$amountPaise", "$platformFeePaise"] } },
            tipCount: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      DiscordServer.find({ owner: userId }).select("_id"),
      Reel.aggregate([
        { $match: { creator_id: userObjId, isDeleted: false } },
        {
          $group: {
            _id: null,
            reelCount: { $sum: 1 },
            totalViews: { $sum: "$viewCount" },
            totalLikes: { $sum: "$likeCount" },
            totalShares: { $sum: "$shareCount" },
            totalComments: { $sum: "$commentCount" },
          },
        },
      ]),
      Reel.find({ creator_id: userObjId, isDeleted: false })
        .sort({ viewCount: -1 })
        .limit(5)
        .select("caption thumbnailUrl viewCount likeCount shareCount commentCount"),
    ]);

    const serverIds = ownedServers.map((s) => s._id);
    const tiers = serverIds.length
      ? await ServerTier.find({ server: { $in: serverIds } }).select(
          "name amountPaise currency interval isActive",
        )
      : [];
    const tierIds = tiers.map((t) => t._id);

    const subsByTierAndStatus = tierIds.length
      ? await TierSubscription.aggregate([
          { $match: { tier: { $in: tierIds } } },
          { $group: { _id: { tier: "$tier", status: "$status" }, count: { $sum: 1 } } },
        ])
      : [];

    // "past_due" is a lapsed-but-not-yet-canceled subscriber — deliberately
    // excluded from activeSubscriberCount/MRR (not reliable recurring
    // revenue yet), surfaced separately so it's still visible, not hidden.
    let activeSubscriberCount = 0;
    let pastDueSubscriberCount = 0;
    let mrrPaise = 0;
    const tierBreakdown = tiers.map((tier) => {
      const activeRow = subsByTierAndStatus.find(
        (r) => r._id.tier.toString() === tier._id.toString() && r._id.status === "active",
      );
      const pastDueRow = subsByTierAndStatus.find(
        (r) => r._id.tier.toString() === tier._id.toString() && r._id.status === "past_due",
      );
      const activeCount = activeRow?.count ?? 0;
      const pastDueCount = pastDueRow?.count ?? 0;
      activeSubscriberCount += activeCount;
      pastDueSubscriberCount += pastDueCount;
      // Normalize yearly tiers to a monthly-equivalent figure so mixed
      // month/year tiers can be summed into one MRR number.
      const monthlyEquivalentPaise =
        tier.interval === "year" ? Math.round(tier.amountPaise / 12) : tier.amountPaise;
      mrrPaise += activeCount * monthlyEquivalentPaise;
      return {
        tierId: tier._id.toString(),
        name: tier.name,
        amountPaise: tier.amountPaise,
        currency: tier.currency,
        interval: tier.interval,
        isActive: tier.isActive,
        activeSubscriberCount: activeCount,
        pastDueSubscriberCount: pastDueCount,
      };
    });

    return c.json(
      {
        tips: {
          netEarningsPaiseAllTime: tipTotals[0]?.netEarningsPaise ?? 0,
          tipCountAllTime: tipTotals[0]?.tipCount ?? 0,
          currency: "inr",
          trend: tipTrend.map((row) => ({
            date: row._id,
            netEarningsPaise: row.netEarningsPaise,
            tipCount: row.tipCount,
          })),
        },
        subscriptions: {
          activeSubscriberCount,
          pastDueSubscriberCount,
          mrrPaise,
          tiers: tierBreakdown,
        },
        reels: {
          reelCount: reelTotals[0]?.reelCount ?? 0,
          totalViews: reelTotals[0]?.totalViews ?? 0,
          totalLikes: reelTotals[0]?.totalLikes ?? 0,
          totalShares: reelTotals[0]?.totalShares ?? 0,
          totalComments: reelTotals[0]?.totalComments ?? 0,
          topReels: topReels.map((r) => ({
            id: r._id.toString(),
            caption: r.caption ?? "",
            thumbnailUrl: r.thumbnailUrl ?? "",
            viewCount: r.viewCount,
            likeCount: r.likeCount,
            shareCount: r.shareCount,
            commentCount: r.commentCount,
          })),
        },
      },
      200,
    );
  } catch (error) {
    console.error("Error fetching creator revenue summary:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};
