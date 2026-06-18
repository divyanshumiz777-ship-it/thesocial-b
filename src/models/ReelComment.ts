import { Schema, model, Types } from "mongoose";

const ReelCommentSchema = new Schema(
  {
    reel_id: {
      type: Schema.Types.ObjectId,
      ref: "Reel",
      required: true,
      index: true,
    },
    user_id: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    content: { type: String, required: true, maxlength: 500, trim: true },
    likeCount: { type: Number, default: 0, min: 0 },
    likedBy: [{ type: Schema.Types.ObjectId, ref: "User" }],
    parentCommentId: {
      type: Schema.Types.ObjectId,
      ref: "ReelComment",
      default: null,
    },
    isDeleted: { type: Boolean, default: false, index: true },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
  }
);

ReelCommentSchema.index({ reel_id: 1, isDeleted: 1, created_at: -1 });

export const ReelComment = model("ReelComment", ReelCommentSchema);
