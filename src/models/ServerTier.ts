import mongoose, { Schema, Document, Types } from "mongoose";

// A paid supporter tier a server owner defines (e.g. "$5/month Supporter").
// One Stripe Product+Price is created up front when the tier is created
// (paymentController.ts's createServerTier) — members then subscribe via a
// Checkout session in "subscription" mode against that same priceId.
export interface IServerTier extends Document {
  server: Types.ObjectId;
  name: string;
  description?: string;
  amountCents: number;
  currency: string;
  interval: "month" | "year";
  stripeProductId: string;
  stripePriceId: string;
  roleName: string;
  isActive: boolean;
  createdAt: Date;
}

const ServerTierSchema = new Schema<IServerTier>(
  {
    server: { type: Schema.Types.ObjectId, ref: "DiscordServer", required: true, index: true },
    name: { type: String, required: true, maxlength: 60 },
    description: { type: String, maxlength: 300 },
    amountCents: { type: Number, required: true, min: 100 },
    currency: { type: String, default: "usd" },
    interval: { type: String, enum: ["month", "year"], default: "month" },
    stripeProductId: { type: String, required: true },
    stripePriceId: { type: String, required: true },
    // Auto-granted to a member's `roles` array (see ServerMember/DiscordServer.members)
    // the moment their subscription becomes active — reuses the existing role
    // system rather than inventing a parallel "supporter" concept.
    roleName: { type: String, default: "supporter" },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export const ServerTier = mongoose.model<IServerTier>("ServerTier", ServerTierSchema);
