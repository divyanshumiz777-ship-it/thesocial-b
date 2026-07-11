import mongoose, { Schema, Types } from "mongoose";

export interface IDMCall {
  _id: Types.ObjectId;
  conversationId: Types.ObjectId;
  caller: Types.ObjectId;
  callee: Types.ObjectId;
  type: "voice" | "video";
  status: "ringing" | "accepted" | "rejected" | "missed" | "cancelled" | "ended";
  // The specific socket that placed the call — only THAT socket (not every
  // tab/device the caller has open) is pulled into the call room on accept,
  // so a call doesn't create a redundant WebRTC mesh across all of one
  // person's devices. Ephemeral (a page reload invalidates it, same as any
  // live socket id), never read once the call leaves "ringing".
  callerSocketId: string;
  startedAt: Date;
  connectedAt?: Date;
  endedAt?: Date;
}

const DMCallSchema = new Schema<IDMCall>(
  {
    conversationId: { type: Schema.Types.ObjectId, ref: "Conversation", required: true },
    caller: { type: Schema.Types.ObjectId, ref: "User", required: true },
    callee: { type: Schema.Types.ObjectId, ref: "User", required: true },
    type: { type: String, enum: ["voice", "video"], required: true },
    status: {
      type: String,
      enum: ["ringing", "accepted", "rejected", "missed", "cancelled", "ended"],
      default: "ringing",
    },
    callerSocketId: { type: String, required: true },
    startedAt: { type: Date, required: true },
    connectedAt: { type: Date },
    endedAt: { type: Date },
  },
  { timestamps: true }
);

// "Is this user already on a call" busy-check (either role, either
// in-progress status) is the hottest read path — every call:invite hits it.
DMCallSchema.index({ caller: 1, status: 1 });
DMCallSchema.index({ callee: 1, status: 1 });
DMCallSchema.index({ conversationId: 1, createdAt: -1 });

const DMCall = mongoose.model<IDMCall>("DMCall", DMCallSchema);
export default DMCall;
