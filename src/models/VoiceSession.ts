import mongoose, { Schema, Types } from "mongoose";

export interface IVoiceSession {
  _id: Types.ObjectId;
  channel: Types.ObjectId;
  server: Types.ObjectId;
  participants: Types.ObjectId[];
  startedAt: Date;
  endedAt?: Date;
  status: "active" | "ended";
}

const VoiceSessionSchema = new Schema<IVoiceSession>(
  {
    channel: { type: Schema.Types.ObjectId, ref: "Channel", required: true },
    server: { type: Schema.Types.ObjectId, ref: "DiscordServer", required: true },
    participants: [{ type: Schema.Types.ObjectId, ref: "User" }],
    startedAt: { type: Date, required: true },
    endedAt: { type: Date },
    status: { type: String, enum: ["active", "ended"], default: "active" },
  },
  { timestamps: true }
);

// One lookup this model needs constantly: "is there an active session for
// this channel right now" (webrtc:join/leave handlers) and "most recent
// sessions for this channel" (session history list).
VoiceSessionSchema.index({ channel: 1, status: 1 });
VoiceSessionSchema.index({ channel: 1, startedAt: -1 });

const VoiceSession = mongoose.model<IVoiceSession>(
  "VoiceSession",
  VoiceSessionSchema
);
export default VoiceSession;
