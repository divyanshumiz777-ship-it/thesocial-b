import mongoose, { Schema, Types } from "mongoose";

export interface IMessage {
  _id: Types.ObjectId;
  content: string;
  sender: Types.ObjectId;
  channel: Types.ObjectId;
}

const MessageSchema = new Schema(
  {
    content: { type: String, required: true },
    channel: { type: Schema.Types.ObjectId, ref: "Channel", required: true },
    sender: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

const Message = mongoose.model("Message", MessageSchema);

export default Message;
