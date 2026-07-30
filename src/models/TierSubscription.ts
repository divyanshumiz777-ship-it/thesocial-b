import mongoose, { Schema, Document, Types } from "mongoose";

// Tracks a member's subscription to a ServerTier. Lifecycle is entirely
// webhook-driven (paymentController.ts's handleRazorpayWebhook reacting to
// subscription.activated/charged/pending/halted/cancelled/completed/expired)
// — status here should always mirror Razorpay's own subscription status,
// never be set optimistically from a client request alone (the client-side
// verifyTierSubscription confirmation is allowed to set "active" for instant
// UX, but the webhook remains authoritative for every subsequent transition).
export interface ITierSubscription extends Document {
  user: Types.ObjectId;
  server: Types.ObjectId;
  tier: Types.ObjectId;
  razorpaySubscriptionId: string;
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
    razorpaySubscriptionId: { type: String, required: true, unique: true },
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
