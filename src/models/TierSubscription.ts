import mongoose, { Schema, Document, Types } from "mongoose";

// Tracks a member's subscription to a ServerTier. Lifecycle is entirely
// webhook-driven (paymentController.ts's handleStripeWebhook reacting to
// customer.subscription.updated/deleted) — status here should always mirror
// Stripe's own subscription status, never be set optimistically from a
// client request.
export interface ITierSubscription extends Document {
  user: Types.ObjectId;
  server: Types.ObjectId;
  tier: Types.ObjectId;
  stripeSubscriptionId: string;
  stripeCustomerId: string;
  status: "active" | "past_due" | "canceled";
  currentPeriodEnd?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const TierSubscriptionSchema = new Schema<ITierSubscription>(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    server: { type: Schema.Types.ObjectId, ref: "DiscordServer", required: true },
    tier: { type: Schema.Types.ObjectId, ref: "ServerTier", required: true },
    stripeSubscriptionId: { type: String, required: true, unique: true },
    stripeCustomerId: { type: String, required: true },
    status: { type: String, enum: ["active", "past_due", "canceled"], default: "active" },
    currentPeriodEnd: { type: Date },
  },
  { timestamps: true },
);

TierSubscriptionSchema.index({ user: 1, server: 1 });

export const TierSubscription = mongoose.model<ITierSubscription>(
  "TierSubscription",
  TierSubscriptionSchema,
);
