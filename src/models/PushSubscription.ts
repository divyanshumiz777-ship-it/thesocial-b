import mongoose, { Schema, Document, Types } from "mongoose";

// One document per (user, browser/device) — a user can have several active
// subscriptions (phone + laptop + a second browser), all fanned out to on
// every push. `endpoint` is the natural per-device identity Web Push itself
// gives us (unique per browser install), so it's the unique key rather than
// a separately generated device id.
export interface IPushSubscription extends Document {
  user: Types.ObjectId;
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  userAgent?: string;
  createdAt: Date;
}

const PushSubscriptionSchema = new Schema<IPushSubscription>({
  user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  endpoint: { type: String, required: true },
  keys: {
    p256dh: { type: String, required: true },
    auth: { type: String, required: true },
  },
  userAgent: { type: String },
  createdAt: { type: Date, default: Date.now },
});

PushSubscriptionSchema.index({ user: 1, endpoint: 1 }, { unique: true });

export const PushSubscription = mongoose.model<IPushSubscription>(
  "PushSubscription",
  PushSubscriptionSchema,
);
