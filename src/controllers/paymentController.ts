import { Context } from "hono";
import mongoose from "mongoose";
import DiscordServer from "../models/DiscordServer.ts";
import ServerMember from "../models/ServerMember.ts";
import User from "../models/User.ts";
import { StripeAccount } from "../models/StripeAccount.ts";
import { Tip } from "../models/Tip.ts";
import { ServerTier } from "../models/ServerTier.ts";
import { TierSubscription } from "../models/TierSubscription.ts";
import {
  centsToFeeCents,
  getFrontendUrl,
  getPlatformFeePercent,
  getStripeClient,
  getWebhookSecret,
  isStripeEnabled,
} from "../lib/stripeClient.ts";
import { createNotification, sendNotificationViaSocket } from "./notificationController.ts";
import { getIoInstance } from "../config/socket.ts";

const MIN_TIP_CENTS = 100; // $1.00 — Stripe's own practical minimum for a card charge

// ── Feature status ──────────────────────────────────────────────────────────

export const getPaymentsStatus = async (c: Context) => {
  return c.json({ enabled: isStripeEnabled(), platformFeePercent: getPlatformFeePercent() });
};

// ── Creator payout onboarding (Stripe Connect Express) ──────────────────────

export const startCreatorOnboarding = async (c: Context) => {
  if (!isStripeEnabled()) return c.json({ error: "Payments are not enabled" }, 503);
  try {
    const user = c.get("user");
    const stripe = getStripeClient();

    let account = await StripeAccount.findOne({ user: user.id });
    if (!account) {
      const userDoc = await User.findById(user.id).select("email name");
      const stripeAccount = await stripe.accounts.create({
        type: "express",
        email: userDoc?.email,
        business_type: "individual",
        metadata: { userId: user.id },
      });
      account = await StripeAccount.create({
        user: user.id,
        stripeAccountId: stripeAccount.id,
      });
    }

    const frontendUrl = getFrontendUrl();
    const accountLink = await stripe.accountLinks.create({
      account: account.stripeAccountId,
      refresh_url: `${frontendUrl}/community/settings?tab=payouts&refresh=true`,
      return_url: `${frontendUrl}/community/settings?tab=payouts&onboarded=true`,
      type: "account_onboarding",
    });

    return c.json({ url: accountLink.url }, 200);
  } catch (error) {
    console.error("Error starting creator onboarding:", error);
    return c.json({ error: "Failed to start onboarding" }, 500);
  }
};

export const getPayoutStatus = async (c: Context) => {
  if (!isStripeEnabled()) return c.json({ enabled: false }, 200);
  try {
    const user = c.get("user");
    const account = await StripeAccount.findOne({ user: user.id }).lean();
    if (!account) {
      return c.json({ enabled: true, connected: false }, 200);
    }

    const stripe = getStripeClient();
    const stripeAccount = await stripe.accounts.retrieve(account.stripeAccountId);
    const chargesEnabled = Boolean(stripeAccount.charges_enabled);
    const payoutsEnabled = Boolean(stripeAccount.payouts_enabled);
    const onboardingComplete = chargesEnabled && payoutsEnabled;

    if (
      chargesEnabled !== account.chargesEnabled ||
      payoutsEnabled !== account.payoutsEnabled ||
      onboardingComplete !== account.onboardingComplete
    ) {
      await StripeAccount.updateOne(
        { _id: account._id },
        { $set: { chargesEnabled, payoutsEnabled, onboardingComplete } },
      );
    }

    return c.json(
      { enabled: true, connected: true, chargesEnabled, payoutsEnabled, onboardingComplete },
      200,
    );
  } catch (error) {
    console.error("Error fetching payout status:", error);
    return c.json({ error: "Failed to fetch payout status" }, 500);
  }
};

// Public — lets a profile page decide whether to show a "Send a tip" button
// at all, without exposing the target user's full Stripe account status
// (only whether tips can currently be accepted).
export const getTipEligibility = async (c: Context) => {
  if (!isStripeEnabled()) return c.json({ eligible: false }, 200);
  try {
    const { userId } = c.req.param();
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return c.json({ eligible: false }, 200);
    }
    const account = await StripeAccount.findOne({ user: userId }).select("chargesEnabled").lean();
    return c.json({ eligible: Boolean(account?.chargesEnabled) }, 200);
  } catch (error) {
    console.error("Error checking tip eligibility:", error);
    return c.json({ eligible: false }, 200);
  }
};

// ── Tipping ──────────────────────────────────────────────────────────────────

export const createTipCheckout = async (c: Context) => {
  if (!isStripeEnabled()) return c.json({ error: "Payments are not enabled" }, 503);
  try {
    const user = c.get("user");
    const body = await c.req.json().catch(() => ({}));
    const { recipientUserId, amountCents, message } = body as {
      recipientUserId?: string;
      amountCents?: number;
      message?: string;
    };

    if (!recipientUserId || !mongoose.Types.ObjectId.isValid(recipientUserId)) {
      return c.json({ error: "Invalid recipient" }, 400);
    }
    if (recipientUserId === user.id) {
      return c.json({ error: "You can't tip yourself" }, 400);
    }
    if (!amountCents || !Number.isInteger(amountCents) || amountCents < MIN_TIP_CENTS) {
      return c.json({ error: `Minimum tip is $${(MIN_TIP_CENTS / 100).toFixed(2)}` }, 400);
    }

    const recipientAccount = await StripeAccount.findOne({ user: recipientUserId });
    if (!recipientAccount?.chargesEnabled) {
      return c.json({ error: "This creator hasn't set up payouts yet" }, 400);
    }

    const recipientUser = await User.findById(recipientUserId).select("name");
    const stripe = getStripeClient();
    const platformFeeCents = centsToFeeCents(amountCents);
    const frontendUrl = getFrontendUrl();

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            unit_amount: amountCents,
            product_data: {
              name: `Tip for ${recipientUser?.name || "a creator"}`,
              description: message?.slice(0, 200) || undefined,
            },
          },
          quantity: 1,
        },
      ],
      payment_intent_data: {
        application_fee_amount: platformFeeCents,
        transfer_data: { destination: recipientAccount.stripeAccountId },
      },
      success_url: `${frontendUrl}/profile/${recipientUserId}?tip=success`,
      cancel_url: `${frontendUrl}/profile/${recipientUserId}?tip=cancelled`,
      metadata: { senderId: user.id, recipientId: recipientUserId },
    });

    await Tip.create({
      sender: user.id,
      recipient: recipientUserId,
      amountCents,
      platformFeeCents,
      message: message?.slice(0, 280),
      stripeCheckoutSessionId: session.id,
      status: "pending",
    });

    return c.json({ url: session.url }, 200);
  } catch (error) {
    console.error("Error creating tip checkout:", error);
    return c.json({ error: "Failed to start tip checkout" }, 500);
  }
};

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
  if (!isStripeEnabled()) return c.json({ error: "Payments are not enabled" }, 503);
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

    const ownerAccount = await StripeAccount.findOne({ user: server.owner });
    if (!ownerAccount?.chargesEnabled) {
      return c.json({ error: "Connect a payout account before creating a paid tier." }, 400);
    }

    const body = await c.req.json().catch(() => ({}));
    const { name, description, amountCents, interval, roleName } = body as {
      name?: string;
      description?: string;
      amountCents?: number;
      interval?: "month" | "year";
      roleName?: string;
    };

    if (!name?.trim()) return c.json({ error: "Tier name is required" }, 400);
    if (!amountCents || !Number.isInteger(amountCents) || amountCents < MIN_TIP_CENTS) {
      return c.json({ error: `Minimum price is $${(MIN_TIP_CENTS / 100).toFixed(2)}` }, 400);
    }

    const stripe = getStripeClient();
    const product = await stripe.products.create({
      name: `${server.name} — ${name.trim()}`,
      description: description?.slice(0, 300),
      metadata: { serverId },
    });
    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: amountCents,
      currency: "usd",
      recurring: { interval: interval === "year" ? "year" : "month" },
    });

    const tier = await ServerTier.create({
      server: serverId,
      name: name.trim(),
      description: description?.slice(0, 300),
      amountCents,
      interval: interval === "year" ? "year" : "month",
      stripeProductId: product.id,
      stripePriceId: price.id,
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
      .sort({ amountCents: 1 })
      .lean();
    return c.json({ tiers, enabled: isStripeEnabled() }, 200);
  } catch (error) {
    console.error("Error listing server tiers:", error);
    return c.json({ error: "Failed to list tiers" }, 500);
  }
};

export const deactivateServerTier = async (c: Context) => {
  if (!isStripeEnabled()) return c.json({ error: "Payments are not enabled" }, 503);
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
    // isActive filter). Cancelling live Stripe subscriptions is a separate,
    // deliberate action, not a side effect of hiding a tier.
    await ServerTier.updateOne({ _id: tierId, server: serverId }, { $set: { isActive: false } });
    return c.json({ message: "Tier deactivated" }, 200);
  } catch (error) {
    console.error("Error deactivating server tier:", error);
    return c.json({ error: "Failed to deactivate tier" }, 500);
  }
};

export const createTierCheckout = async (c: Context) => {
  if (!isStripeEnabled()) return c.json({ error: "Payments are not enabled" }, 503);
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

    const server = await DiscordServer.findById(serverId).select("owner");
    if (!server) return c.json({ error: "Server not found" }, 404);

    const ownerAccount = await StripeAccount.findOne({ user: server.owner });
    if (!ownerAccount?.chargesEnabled) {
      return c.json({ error: "This server's payouts aren't set up right now." }, 400);
    }

    const userDoc = await User.findById(user.id).select("email");
    const stripe = getStripeClient();
    const frontendUrl = getFrontendUrl();

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      customer_email: userDoc?.email,
      line_items: [{ price: tier.stripePriceId, quantity: 1 }],
      subscription_data: {
        application_fee_percent: getPlatformFeePercent(),
        transfer_data: { destination: ownerAccount.stripeAccountId },
      },
      success_url: `${frontendUrl}/community/${serverId}?subscribed=true`,
      cancel_url: `${frontendUrl}/community/${serverId}?subscribed=cancelled`,
      metadata: { userId: user.id, serverId, tierId },
    });

    return c.json({ url: session.url }, 200);
  } catch (error) {
    console.error("Error creating tier checkout:", error);
    return c.json({ error: "Failed to start subscription checkout" }, 500);
  }
};

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

export const handleStripeWebhook = async (c: Context) => {
  if (!isStripeEnabled()) return c.json({ error: "Payments are not enabled" }, 503);

  const signature = c.req.header("stripe-signature");
  const webhookSecret = getWebhookSecret();
  if (!signature || !webhookSecret) {
    return c.json({ error: "Missing webhook signature" }, 400);
  }

  const rawBody = await c.req.text();
  const stripe = getStripeClient();

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    console.error("Stripe webhook signature verification failed:", err);
    return c.json({ error: "Invalid signature" }, 400);
  }

  try {
    const io = getIoInstance();
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as any;

        if (session.mode === "payment") {
          const tip = await Tip.findOneAndUpdate(
            { stripeCheckoutSessionId: session.id },
            { $set: { status: "succeeded", stripePaymentIntentId: session.payment_intent } },
            { new: true },
          );
          if (tip) {
            const sender = await User.findById(tip.sender).select("name");
            const notification = await createNotification({
              recipient: tip.recipient.toString(),
              sender: tip.sender.toString(),
              type: "tip_received",
              title: "You received a tip!",
              message: `${sender?.name || "Someone"} sent you a $${(tip.amountCents / 100).toFixed(2)} tip${tip.message ? `: "${tip.message}"` : ""}.`,
              metadata: { amountCents: tip.amountCents },
            });
            if (notification) sendNotificationViaSocket(io, tip.recipient.toString(), notification);
          }
        } else if (session.mode === "subscription") {
          const { userId, serverId, tierId } = session.metadata || {};
          if (userId && serverId && tierId) {
            const tier = await ServerTier.findById(tierId);
            if (tier) {
              await TierSubscription.findOneAndUpdate(
                { stripeSubscriptionId: session.subscription },
                {
                  $set: {
                    user: userId,
                    server: serverId,
                    tier: tierId,
                    stripeSubscriptionId: session.subscription,
                    stripeCustomerId: session.customer,
                    status: "active",
                  },
                },
                { upsert: true },
              );
              await grantTierRole(userId, serverId, tier.roleName);
            }
          }
        }
        break;
      }

      case "customer.subscription.updated": {
        const subscription = event.data.object as any;
        const record = await TierSubscription.findOne({ stripeSubscriptionId: subscription.id });
        if (record) {
          const status =
            subscription.status === "active" || subscription.status === "trialing"
              ? "active"
              : subscription.status === "canceled"
                ? "canceled"
                : "past_due";
          await TierSubscription.updateOne(
            { _id: record._id },
            {
              $set: {
                status,
                currentPeriodEnd: subscription.current_period_end
                  ? new Date(subscription.current_period_end * 1000)
                  : undefined,
              },
            },
          );
          if (status === "canceled") {
            const tier = await ServerTier.findById(record.tier);
            if (tier) await revokeTierRole(record.user.toString(), record.server.toString(), tier.roleName);
          }
        }
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object as any;
        const record = await TierSubscription.findOneAndUpdate(
          { stripeSubscriptionId: subscription.id },
          { $set: { status: "canceled" } },
        );
        if (record) {
          const tier = await ServerTier.findById(record.tier);
          if (tier) await revokeTierRole(record.user.toString(), record.server.toString(), tier.roleName);
        }
        break;
      }

      default:
        break;
    }
  } catch (err) {
    console.error("Error processing Stripe webhook event:", event.type, err);
    // Still 200 — Stripe retries on non-2xx, and a processing bug here
    // shouldn't cause Stripe to hammer this endpoint indefinitely for an
    // event that will fail the same way every retry.
  }

  return c.json({ received: true }, 200);
};
