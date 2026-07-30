import mongoose, { Schema, Document, Types } from "mongoose";

// One row per tip attempt — created "pending" the moment a Razorpay Order is
// created, flipped to "succeeded" by the webhook handler
// (paymentController.ts's handleRazorpayWebhook reacting to
// payment.captured) confirming the actual charge, or optimistically by the
// client-side signature-verified confirmation (verifyTipPayment) — either
// path is idempotent (a status-scoped findOneAndUpdate), never by the
// client-side redirect alone.
export interface ITip extends Document {
  sender: Types.ObjectId;
  recipient: Types.ObjectId;
  // Smallest currency subunit — paise for INR (100 paise = ₹1), same
  // concept "cents" named for USD.
  amountPaise: number;
  currency: string;
  platformFeePaise: number;
  message?: string;
  razorpayOrderId: string;
  razorpayPaymentId?: string;
  status: "pending" | "succeeded" | "failed";
  createdAt: Date;
}

const TipSchema = new Schema<ITip>(
  {
    sender: { type: Schema.Types.ObjectId, ref: "User", required: true },
    recipient: { type: Schema.Types.ObjectId, ref: "User", required: true },
    amountPaise: { type: Number, required: true, min: 100 },
    currency: { type: String, default: "inr" },
    platformFeePaise: { type: Number, required: true },
    message: { type: String, maxlength: 280 },
    razorpayOrderId: { type: String, required: true, unique: true },
    razorpayPaymentId: { type: String },
    status: { type: String, enum: ["pending", "succeeded", "failed"], default: "pending" },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

TipSchema.index({ recipient: 1, status: 1, createdAt: -1 });

export const Tip = mongoose.model<ITip>("Tip", TipSchema);
