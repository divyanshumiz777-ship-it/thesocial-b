import mongoose, { Schema } from "mongoose";

export interface IConversation {
  participants: Schema.Types.ObjectId[];
  messages: Schema.Types.ObjectId[];
  hiddenFor?: Schema.Types.ObjectId[];
  deletedFor?: Schema.Types.ObjectId[];
  deletedAt?: Map<string, Date>;
}

const ConversationSchema = new Schema(
  {
    participants: [{ type: Schema.Types.ObjectId, ref: "User" }],
    messages: [{ type: Schema.Types.ObjectId, ref: "Message" }],
    hiddenFor: [{ type: Schema.Types.ObjectId, ref: "User" }],
    deletedFor: [{ type: Schema.Types.ObjectId, ref: "User" }],
    deletedAt: {
      type: Map,
      of: Date,
      default: new Map(),
    },
  },
  {
    timestamps: true,
  }
);

const Conversation = mongoose.model("Conversation", ConversationSchema);

export default Conversation;
