import mongoose, { Schema, Types } from "mongoose";

export interface IChannelReadStatus {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  channel: Types.ObjectId;
  lastReadMessage: Types.ObjectId;
  lastReadAt: Date;
}

const ChannelReadStatusSchema = new Schema<IChannelReadStatus>(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    channel: { type: Schema.Types.ObjectId, ref: "Channel", required: true },
    lastReadMessage: { type: Schema.Types.ObjectId, ref: "Message" },
    lastReadAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

ChannelReadStatusSchema.index({ user: 1, channel: 1 }, { unique: true });

const ChannelReadStatus = mongoose.model<IChannelReadStatus>(
  "ChannelReadStatus",
  ChannelReadStatusSchema
);

export default ChannelReadStatus;
