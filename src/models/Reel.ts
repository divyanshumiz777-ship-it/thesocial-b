import mongoose, { Schema, Document, Types } from "mongoose";

export interface IReel extends Document {
  _id: Types.ObjectId;
  creator_id: Types.ObjectId;
  videoUrl: string;
  thumbnailUrl?: string;
  caption?: string;
  tags: string[];
  language: string;
  audio_id?: string;
  audioName?: string;
  duration: number;
  viewCount: number;
  likeCount: number;
  shareCount: number;
  commentCount: number;
  created_at: Date;
  updated_at: Date;
  isPublic: boolean;
  isDeleted: boolean;
  isPinned: boolean;
  pinnedAt?: Date;
  captionsVtt?: string;
  captionsStatus: "pending" | "ready" | "unavailable";
}

const ReelSchema = new Schema<IReel>({
  creator_id: {
    type: Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true,
  },
  videoUrl: {
    type: String,
    required: true,
  },
  thumbnailUrl: {
    type: String,
  },
  caption: {
    type: String,
    maxlength: 500,
  },
  tags: {
    type: [String],
    index: true,
    default: [],
  },
  language: {
    type: String,
    default: "en",
    index: true,
  },
  audio_id: {
    type: String,
    index: true,
  },
  audioName: {
    type: String,
  },
  duration: {
    type: Number,
    required: true,
  },
  viewCount: {
    type: Number,
    default: 0,
  },
  likeCount: {
    type: Number,
    default: 0,
  },
  shareCount: {
    type: Number,
    default: 0,
  },
  commentCount: {
    type: Number,
    default: 0,
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
  isPublic: {
    type: Boolean,
    default: true,
  },
  isDeleted: {
    type: Boolean,
    default: false,
    index: true,
  },
  isPinned: {
    type: Boolean,
    default: false,
  },
  pinnedAt: {
    type: Date,
  },
  captionsVtt: {
    type: String,
  },
  captionsStatus: {
    type: String,
    enum: ["pending", "ready", "unavailable"],
    default: "pending",
  },
});

ReelSchema.index({ isDeleted: 1, created_at: -1 });
ReelSchema.index({ creator_id: 1, isDeleted: 1 });
ReelSchema.index({ tags: 1, language: 1 });
ReelSchema.index({ creator_id: 1, isPinned: -1, created_at: -1 });

export const Reel = mongoose.model<IReel>("Reel", ReelSchema);
