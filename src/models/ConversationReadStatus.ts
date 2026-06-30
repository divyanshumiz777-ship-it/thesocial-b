import mongoose, { Schema, Types } from "mongoose";

export interface IConversationReadStatus {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  conversation: Types.ObjectId;
  lastReadMessage?: Types.ObjectId;
  lastReadAt: Date;
  lastDeliveredMessage?: Types.ObjectId;
  lastDeliveredAt?: Date;
}

const ConversationReadStatusSchema = new Schema<IConversationReadStatus>(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    conversation: {
      type: Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
    },
    lastReadMessage: { type: Schema.Types.ObjectId, ref: "Message" },
    lastReadAt: { type: Date, default: Date.now },
    lastDeliveredMessage: { type: Schema.Types.ObjectId, ref: "Message" },
    lastDeliveredAt: { type: Date },
  },
  { timestamps: true }
);

ConversationReadStatusSchema.index(
  { user: 1, conversation: 1 },
  { unique: true }
);

const ConversationReadStatus = mongoose.model<IConversationReadStatus>(
  "ConversationReadStatus",
  ConversationReadStatusSchema
);

export default ConversationReadStatus;
