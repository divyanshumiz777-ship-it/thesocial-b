import mongoose, { Schema, Document, Types } from "mongoose";

export interface IReaction {
  emoji: string;
  users: Types.ObjectId[];
}

export interface IMessage extends Document {
  content: string;
  sender: Types.ObjectId;
  edited: boolean;
  channel?: Types.ObjectId;
  conversationId?: Types.ObjectId;
  reactions: IReaction[];
}

const ReactionSchema = new Schema<IReaction>(
  {
    emoji: { type: String, required: true },
    users: [{ type: Schema.Types.ObjectId, ref: "User" }],
  },
  { _id: false }
);

const MessageSchema = new Schema<IMessage>(
  {
    content: { type: String, required: true },
    sender: { type: Schema.Types.ObjectId, ref: "User", required: true },
    edited: { type: Boolean, default: false },
    channel: { type: Schema.Types.ObjectId, ref: "Channel" },
    conversationId: { type: Schema.Types.ObjectId, ref: "Conversation" },
    reactions: [ReactionSchema],
  },
  { timestamps: true }
);

const Message = mongoose.model<IMessage>("Message", MessageSchema);

export default Message;
