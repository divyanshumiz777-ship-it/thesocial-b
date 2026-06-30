import mongoose, { Schema, Document, Types } from "mongoose";

/**
 * Append-only raw reel engagement event log.
 *
 * Distinct from UserReelInteraction, which holds the aggregated per-user /
 * per-reel state. ReelEvent is the immutable training/analytics log populated
 * by the Recommendation Service consumer from the Redis Stream. `event_id` is
 * the Redis Stream entry id and is unique, giving the consumer idempotency
 * (re-delivering the same stream entry never creates a duplicate).
 */
export interface IReelEvent extends Document {
  _id: Types.ObjectId;
  event_id?: string;
  user_id: Types.ObjectId;
  reel_id: Types.ObjectId;
  event_type: string;
  watch_time?: number;
  completion_rate?: number;
  session_id?: string;
  source?: string;
  ts: Date;
}

const ReelEventSchema = new Schema<IReelEvent>({
  event_id: {
    type: String,
  },
  user_id: {
    type: Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  reel_id: {
    type: Schema.Types.ObjectId,
    ref: "Reel",
    required: true,
  },
  event_type: {
    type: String,
    required: true,
  },
  watch_time: {
    type: Number,
    min: 0,
  },
  completion_rate: {
    type: Number,
    min: 0,
    max: 1,
  },
  session_id: {
    type: String,
  },
  source: {
    type: String,
  },
  ts: {
    type: Date,
    default: Date.now,
  },
});

ReelEventSchema.index({ ts: -1 });
ReelEventSchema.index({ user_id: 1, ts: -1 });
ReelEventSchema.index({ reel_id: 1, ts: -1 });
ReelEventSchema.index({ event_id: 1 }, { unique: true, sparse: true });

export const ReelEvent = mongoose.model<IReelEvent>("ReelEvent", ReelEventSchema);
