import mongoose, { Schema, Types } from "mongoose";

export interface IInvite {
  code: string;
  server: Types.ObjectId;
  createdBy: Types.ObjectId;
  expiresAt: Date;
}

const InviteSchema = new Schema<IInvite>({
  code: { type: String, required: true, unique: true },
  server: { type: Schema.Types.ObjectId, ref: "DiscordServer", required: true },
  createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  expiresAt: { type: Date, required: true },
});

const Invite = mongoose.model<IInvite>("Invite", InviteSchema);
export default Invite;
