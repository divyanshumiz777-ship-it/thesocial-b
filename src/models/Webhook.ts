import mongoose, { Schema, Document, Types } from "mongoose";

export interface IWebhook extends Document {
  url: string;
  owner: Types.ObjectId;
  events: string[];
  createdAt: Date;
}

const WebhookSchema = new Schema<IWebhook>({
  url: { type: String, required: true },
  owner: { type: Schema.Types.ObjectId, ref: "User", required: true },
  events: [{ type: String, required: true }],
  createdAt: { type: Date, default: Date.now },
});

export default mongoose.model<IWebhook>("Webhook", WebhookSchema);
