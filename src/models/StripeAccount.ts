import mongoose, { Schema, Document, Types } from "mongoose";

// A creator's Stripe Connect Express account — created once via the
// onboarding flow (paymentController.ts's startCreatorOnboarding), then
// reused for every tip/tier-subscription payout to that creator. One per
// user; a user only ever needs one connected account regardless of how
// many servers/tiers they later create.
export interface IStripeAccount extends Document {
  user: Types.ObjectId;
  stripeAccountId: string;
  onboardingComplete: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const StripeAccountSchema = new Schema<IStripeAccount>(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    stripeAccountId: { type: String, required: true, unique: true },
    onboardingComplete: { type: Boolean, default: false },
    chargesEnabled: { type: Boolean, default: false },
    payoutsEnabled: { type: Boolean, default: false },
  },
  { timestamps: true },
);

export const StripeAccount = mongoose.model<IStripeAccount>("StripeAccount", StripeAccountSchema);
