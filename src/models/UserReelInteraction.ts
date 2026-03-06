import mongoose, { Schema, Document, Types } from "mongoose";

export interface IUserReelInteraction extends Document {
  _id: Types.ObjectId;
  user_id: Types.ObjectId;
  reel_id: Types.ObjectId;
  watch_time: number; // in seconds
  liked: boolean;
  shared: boolean;
  skipped: boolean;
  commented: boolean;
  follow_creator: boolean;
  completed: boolean; // watched till end
  created_at: Date;
  updated_at: Date;
  last_interaction_at: Date;
}

const UserReelInteractionSchema = new Schema<IUserReelInteraction>({
  user_id: {
    type: Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true,
  },
  reel_id: {
    type: Schema.Types.ObjectId,
    ref: "Reel",
    required: true,
    index: true,
  },
  watch_time: {
    type: Number,
    default: 0,
    min: 0,
  },
  liked: {
    type: Boolean,
    default: false,
  },
  shared: {
    type: Boolean,
    default: false,
  },
  skipped: {
    type: Boolean,
    default: false,
  },
  commented: {
    type: Boolean,
    default: false,
  },
  follow_creator: {
    type: Boolean,
    default: false,
  },
  completed: {
    type: Boolean,
    default: false,
  },
  created_at: {
    type: Date,
    default: Date.now,
    index: true,
  },
  updated_at: {
    type: Date,
    default: Date.now,
  },
  last_interaction_at: {
    type: Date,
    default: Date.now,
  },
});

// Unique index to prevent duplicate interactions for same user-reel pair
UserReelInteractionSchema.index({ user_id: 1, reel_id: 1 }, { unique: true });

// Index for querying user interactions
UserReelInteractionSchema.index({ user_id: 1, created_at: -1 });

// Index for querying reel interactions
UserReelInteractionSchema.index({ reel_id: 1, created_at: -1 });

export const UserReelInteraction = mongoose.model<IUserReelInteraction>(
  "UserReelInteraction",
  UserReelInteractionSchema,
);
