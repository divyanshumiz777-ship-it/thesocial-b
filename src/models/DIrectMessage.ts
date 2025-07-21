import mongoose, { Schema } from "mongoose";

export interface IDirectMessage {
  content: string;
  sender: Schema.Types.ObjectId;
  receiver: Schema.Types.ObjectId;
}

const DirectMessageSchema = new Schema(
  {
    content: { type: String, required: true },
    sender: { type: Schema.Types.ObjectId, ref: "User", required: true },
    receiver: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

const DirectMessage = mongoose.model("DirectMessage", DirectMessageSchema);

export default DirectMessage;
