import mongoose, { Schema, Document, Types } from "mongoose";

export interface IUserReelPreference extends Document {
  _id: Types.ObjectId;
  user_id: Types.ObjectId;
  preferred_tags: string[];
  preferred_language: string;
  followed_creators: Types.ObjectId[];
  muted_creators: Types.ObjectId[];
  preferred_audio_ids: string[];
  created_at: Date;
  updated_at: Date;
}

const UserReelPreferenceSchema = new Schema<IUserReelPreference>({
  user_id: {
    type: Schema.Types.ObjectId,
    ref: "User",
    required: true,
    unique: true,
    index: true,
  },
  preferred_tags: {
    type: [String],
    default: [],
    index: true,
  },
  preferred_language: {
    type: String,
    default: "en",
  },
  followed_creators: [
    {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
  ],
  muted_creators: [
    {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
  ],
  preferred_audio_ids: {
    type: [String],
    default: [],
  },
  created_at: {
    type: Date,
    default: Date.now,
  },
  updated_at: {
    type: Date,
    default: Date.now,
  },
});

export const UserReelPreference = mongoose.model<IUserReelPreference>(
  "UserReelPreference",
  UserReelPreferenceSchema,
);
