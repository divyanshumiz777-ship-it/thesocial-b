import mongoose, { Schema, Document, Types } from "mongoose";

export interface IChannel extends Document {
  name: string;
  categories: Types.ObjectId[];
  server: Types.ObjectId;
  type: "Text" | "Voice";
  createdAt: Date;
}

const ChannelSchema = new Schema<IChannel>({
  name: { type: String, required: true, maxLength: 100 },
  categories: [{ type: Schema.Types.ObjectId, ref: "Category" }],
  server: { type: Schema.Types.ObjectId, ref: "DiscordServer", required: true },
  type: { type: String, enum: ["Text", "Voice"], required: true },
  createdAt: { type: Date, default: Date.now },
});

const Channel = mongoose.model<IChannel>("Channel", ChannelSchema);
export default Channel;
