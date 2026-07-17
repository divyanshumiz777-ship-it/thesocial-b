import mongoose, { Schema, Document, Types } from "mongoose";

export interface IBot extends Document {
  name: string;
  owner: Types.ObjectId;
  server: Types.ObjectId;
  permissions: string[];
  createdAt: Date;
}

const BotSchema = new Schema<IBot>({
  name: { type: String, required: true, trim: true },
  owner: { type: Schema.Types.ObjectId, ref: "User", required: true },
  server: { type: Schema.Types.ObjectId, ref: "DiscordServer", required: true },
  permissions: [{ type: String, required: true }],
  createdAt: { type: Date, default: Date.now },
});

BotSchema.index({ owner: 1 });
BotSchema.index({ server: 1 });

export default mongoose.model<IBot>("Bot", BotSchema);
