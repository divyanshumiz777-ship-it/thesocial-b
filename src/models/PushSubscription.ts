import mongoose, { Schema, Document, Types } from "mongoose";

// One document per (user, browser/device) — a user can have several active
// subscriptions (phone + laptop + a second browser), all fanned out to on
// every push. `endpoint` is the natural per-device identity Web Push itself
// gives us (unique per browser install), so it's the unique key rather than
// a separately generated device id.
//
// `platform`/`fcmToken` support a second, non-web subscription shape (native
// Capacitor apps, which can't use the browser Push API and register an FCM
// device token instead) alongside the original one — `endpoint`/`keys` stay
// required only for `platform: "web"` docs.
export interface IPushSubscription extends Document {
  user: Types.ObjectId;
  platform: "web" | "android" | "ios";
  endpoint?: string;
  keys?: {
    p256dh: string;
    auth: string;
  };
  fcmToken?: string;
  userAgent?: string;
  createdAt: Date;
}

const isWebPlatform = function (this: IPushSubscription) {
  return this.platform === "web" || !this.platform;
};

const PushSubscriptionSchema = new Schema<IPushSubscription>({
  user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  platform: { type: String, enum: ["web", "android", "ios"], default: "web" },
  endpoint: { type: String, required: isWebPlatform },
  keys: {
    p256dh: { type: String, required: isWebPlatform },
    auth: { type: String, required: isWebPlatform },
  },
  fcmToken: { type: String, required: function (this: IPushSubscription) { return !isWebPlatform.call(this); } },
  userAgent: { type: String },
  createdAt: { type: Date, default: Date.now },
});

PushSubscriptionSchema.index({ user: 1, endpoint: 1 }, { unique: true, partialFilterExpression: { endpoint: { $exists: true } } });
PushSubscriptionSchema.index({ user: 1, fcmToken: 1 }, { unique: true, partialFilterExpression: { fcmToken: { $exists: true } } });

export const PushSubscription = mongoose.model<IPushSubscription>(
  "PushSubscription",
  PushSubscriptionSchema,
);
