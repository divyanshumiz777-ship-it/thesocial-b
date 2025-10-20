import mongoose, { Schema } from "mongoose";

const WebhookEventLogSchema = new Schema({
  webhookId: { type: Schema.Types.ObjectId, ref: "Webhook", required: true },
  event: { type: String, required: true },
  payload: { type: Schema.Types.Mixed },
  triggeredAt: { type: Date, default: Date.now },
  status: { type: String, default: "success" },
  error: { type: String },
});
WebhookEventLogSchema.index({ webhookId: 1, event: 1, triggeredAt: -1 });
WebhookEventLogSchema.index(
  { triggeredAt: 1 },
  { expireAfterSeconds: 60 * 60 * 24 * 7 }
);

export default mongoose.model("WebhookEventLog", WebhookEventLogSchema);
