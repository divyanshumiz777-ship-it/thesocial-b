import mongoose, { Schema, Document, Types } from "mongoose";

// One row per tip attempt — created "pending" the moment a Checkout session
// is opened, flipped to "succeeded" only by the webhook handler
// (paymentController.ts's handleStripeWebhook) confirming the actual
// charge, never by the client-side redirect alone (which merely means the
// user reached Stripe's success URL, not that payment cleared).
export interface ITip extends Document {
  sender: Types.ObjectId;
  recipient: Types.ObjectId;
  amountCents: number;
  currency: string;
  platformFeeCents: number;
  message?: string;
  stripeCheckoutSessionId: string;
  stripePaymentIntentId?: string;
  status: "pending" | "succeeded" | "failed";
  createdAt: Date;
}

const TipSchema = new Schema<ITip>(
  {
    sender: { type: Schema.Types.ObjectId, ref: "User", required: true },
    recipient: { type: Schema.Types.ObjectId, ref: "User", required: true },
    amountCents: { type: Number, required: true, min: 100 },
    currency: { type: String, default: "usd" },
    platformFeeCents: { type: Number, required: true },
    message: { type: String, maxlength: 280 },
    stripeCheckoutSessionId: { type: String, required: true, unique: true },
    stripePaymentIntentId: { type: String },
    status: { type: String, enum: ["pending", "succeeded", "failed"], default: "pending" },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

TipSchema.index({ recipient: 1, status: 1, createdAt: -1 });

export const Tip = mongoose.model<ITip>("Tip", TipSchema);
