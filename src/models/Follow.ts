import mongoose, { Schema, Document, Types } from "mongoose";

interface IFollow extends Document {
  follower: Types.ObjectId;
  followee: Types.ObjectId;
  status: "pending" | "accepted";
  createdAt: Date;
  updatedAt: Date;
}

const FollowSchema = new Schema<IFollow>(
  {
    follower: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Follower is required"],
    },
    followee: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Followee is required"],
    },
    status: {
      type: String,
      enum: {
        values: ["pending", "accepted"],
        message: "{VALUE} is not a valid status",
      },
      default: "accepted",
    },
  },
  {
    timestamps: true,
  }
);

FollowSchema.index({ follower: 1, followee: 1 }, { unique: true });
FollowSchema.index({ followee: 1, status: 1 });
FollowSchema.index({ follower: 1, status: 1 });

const Follow = mongoose.model<IFollow>("Follow", FollowSchema);

export default Follow;
export type { IFollow };
