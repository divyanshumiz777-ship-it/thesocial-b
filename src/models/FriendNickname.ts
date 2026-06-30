import mongoose, { Schema, Document } from "mongoose";

export interface IFriendNickname extends Document {
  owner: mongoose.Types.ObjectId;
  friend: mongoose.Types.ObjectId;
  nickname: string;
}

const FriendNicknameSchema = new Schema<IFriendNickname>(
  {
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true },
    friend: { type: Schema.Types.ObjectId, ref: "User", required: true },
    nickname: { type: String, required: true, trim: true, maxlength: 32 },
  },
  { timestamps: true }
);

FriendNicknameSchema.index({ owner: 1, friend: 1 }, { unique: true });

export default mongoose.model<IFriendNickname>(
  "FriendNickname",
  FriendNicknameSchema
);
