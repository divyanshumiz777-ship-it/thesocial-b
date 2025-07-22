import mongoose, { Schema, Document, Types } from "mongoose";

export interface IThread extends Document {
  title: string;
  channel: Types.ObjectId;
  server: Types.ObjectId;
  messages: Types.ObjectId[];
  senders: Types.ObjectId[];
  creator: Types.ObjectId;
}

const ThreadSchema = new Schema<IThread>(
  {
    title: { type: String, required: true, maxLength: 100 },
    channel: { type: Schema.Types.ObjectId, ref: "Channel", required: true },
    server: {
      type: Schema.Types.ObjectId,
      ref: "DiscordServer",
      required: true,
    },
    messages: [{ type: Schema.Types.ObjectId, ref: "Message" }],
    creator: { type: Schema.Types.ObjectId, ref: "User", required: true },
    senders: [{ type: Schema.Types.ObjectId, ref: "User" }],
  },
  { timestamps: true }
);

const Thread = mongoose.model<IThread>("Thread", ThreadSchema);
export default Thread;
