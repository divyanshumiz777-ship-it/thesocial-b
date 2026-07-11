import mongoose, { Schema, Types } from "mongoose";

export interface ITranscriptSegment {
  speaker: Types.ObjectId;
  text: string;
  timestamp: Date;
}

export interface IVoiceSessionTranscript {
  _id: Types.ObjectId;
  session: Types.ObjectId;
  segments: ITranscriptSegment[];
}

const TranscriptSegmentSchema = new Schema<ITranscriptSegment>(
  {
    speaker: { type: Schema.Types.ObjectId, ref: "User", required: true },
    text: { type: String, required: true },
    timestamp: { type: Date, required: true },
  },
  { _id: false }
);

const VoiceSessionTranscriptSchema = new Schema<IVoiceSessionTranscript>(
  {
    session: {
      type: Schema.Types.ObjectId,
      ref: "VoiceSession",
      required: true,
      unique: true,
    },
    segments: [TranscriptSegmentSchema],
  },
  { timestamps: true }
);

const VoiceSessionTranscript = mongoose.model<IVoiceSessionTranscript>(
  "VoiceSessionTranscript",
  VoiceSessionTranscriptSchema
);
export default VoiceSessionTranscript;
