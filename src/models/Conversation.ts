import mongoose, { Schema } from "mongoose";

export interface IConversation {
  participants: Schema.Types.ObjectId[];
  messages: Schema.Types.ObjectId[];
}

const ConversationSchema = new Schema(
  {
    participants: [{ type: Schema.Types.ObjectId, ref: "User" }],
    messages: [{ type: Schema.Types.ObjectId, ref: "DirectMessage" }],
  },
  {
    timestamps: true,
  }
);

const Conversation = mongoose.model("Conversation", ConversationSchema);

export default Conversation;
