import mongoose, { Schema, Types } from "mongoose";

export interface IChannel {
  _id: Types.ObjectId;
  name: string;
  category: Types.ObjectId;
  server: Types.ObjectId;
  messages: Types.ObjectId[];
  senders: Types.ObjectId[];
  type: "Text" | "Voice";
  thread: Types.ObjectId[];
  participants: Types.ObjectId[];
  // Per-channel, admin-opt-in only — defaults off. Gates whether joining this
  // Voice channel offers live transcription/captions at all. See
  // VoiceVideoChannel.tsx's consent banner, which reads this flag.
  transcriptionEnabled: boolean;
}

const ChannelSchema = new Schema<IChannel>(
  {
    name: { type: String, required: true, maxLength: 100 },
    type: { type: String, enum: ["Text", "Voice"], required: true },
    category: { type: Schema.Types.ObjectId, ref: "Category", required: true },
    server: {
      type: Schema.Types.ObjectId,
      ref: "DiscordServer",
      required: true,
    },
    messages: [{ type: Schema.Types.ObjectId, ref: "Message" }],
    senders: [{ type: Schema.Types.ObjectId, ref: "User" }],
    thread: [{ type: Schema.Types.ObjectId, ref: "Thread" }],
    participants: [{ type: Schema.Types.ObjectId, ref: "User" }],
    transcriptionEnabled: { type: Boolean, default: false },
  },
  { timestamps: true }
);
ChannelSchema.index({ server: 1, category: 1, name: 1 });
ChannelSchema.index({ name: "text" });

const Channel = mongoose.model<IChannel>("Channel", ChannelSchema);
export default Channel;
