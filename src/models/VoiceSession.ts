import mongoose, { Schema, Types } from "mongoose";

export interface IVoiceSession {
  _id: Types.ObjectId;
  channel: Types.ObjectId;
  server: Types.ObjectId;
  participants: Types.ObjectId[];
  startedAt: Date;
  endedAt?: Date;
  status: "active" | "ended" | "processing" | "summarized" | "failed";
  // Populated once chat-service's /internal/v1/voice/summarize responds.
  // Kept directly on the session (not a separate collection) — a session
  // only ever has one summary, so there's no relationship a join would earn
  // its keep for, and chat-service's batch RAG re-ingestion (ingest_sync.py's
  // ingest_voice_sessions) can read it straight off this document.
  summary?: string;
  keyPoints?: string[];
  actionItems?: string[];
}

const VoiceSessionSchema = new Schema<IVoiceSession>(
  {
    channel: { type: Schema.Types.ObjectId, ref: "Channel", required: true },
    server: { type: Schema.Types.ObjectId, ref: "DiscordServer", required: true },
    participants: [{ type: Schema.Types.ObjectId, ref: "User" }],
    startedAt: { type: Date, required: true },
    endedAt: { type: Date },
    status: {
      type: String,
      enum: ["active", "ended", "processing", "summarized", "failed"],
      default: "active",
    },
    summary: { type: String },
    keyPoints: [{ type: String }],
    actionItems: [{ type: String }],
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
