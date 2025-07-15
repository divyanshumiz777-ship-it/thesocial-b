import mongoose, { Schema, Types } from "mongoose";

export interface IChannel {
  _id: Types.ObjectId;
  name: string;
  category: Types.ObjectId;
  server: Types.ObjectId;
  type: "Text" | "Voice";
  createdAt: Date;
}

const ChannelSchema = new Schema<IChannel>({
  name: { type: String, required: true, maxLength: 100 },
  type: { type: String, enum: ["Text", "Voice"], required: true },
  category: { type: Schema.Types.ObjectId, ref: "Category", required: true },
  server: { type: Schema.Types.ObjectId, ref: "DiscordServer", required: true },
  createdAt: { type: Date, default: Date.now },
});

const Channel = mongoose.model<IChannel>("Channel", ChannelSchema);
export default Channel;
