import mongoose, { Schema, Types } from "mongoose";

// A group call has no single "callee" to ring-and-accept the way DMCall
// does — anyone in `joinedParticipants` is actively in the WebRTC mesh, and
// anyone else in the group can join at any time while status is "active"
// (there's no formal ringing/accepted state machine per participant; not
// joining is an implicit decline, same as a community voice channel). The
// call becomes "ended" the moment the last participant leaves.
export interface IGroupCall {
  _id: Types.ObjectId;
  groupId: Types.ObjectId;
  initiator: Types.ObjectId;
  type: "voice" | "video";
  status: "active" | "ended";
  joinedParticipants: Types.ObjectId[];
  startedAt: Date;
  endedAt?: Date;
}

const GroupCallSchema = new Schema<IGroupCall>(
  {
    groupId: { type: Schema.Types.ObjectId, ref: "Group", required: true },
    initiator: { type: Schema.Types.ObjectId, ref: "User", required: true },
    type: { type: String, enum: ["voice", "video"], required: true },
    status: { type: String, enum: ["active", "ended"], default: "active" },
    joinedParticipants: [{ type: Schema.Types.ObjectId, ref: "User" }],
    startedAt: { type: Date, required: true },
    endedAt: { type: Date },
  },
  { timestamps: true }
);

// "Is there already an active call in this group" is the hot path — every
// group-call:start hits it before deciding start-vs-join.
GroupCallSchema.index({ groupId: 1, status: 1 });

const GroupCall = mongoose.model<IGroupCall>("GroupCall", GroupCallSchema);
export default GroupCall;
