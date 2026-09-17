import mongoose, { Schema, Document, Types } from "mongoose";
import { IBanned, IMuted } from "./discordServer.types.ts";

export interface IServerMember extends Document {
  server: Types.ObjectId;
  user: Types.ObjectId;
  roles: string[];
  banned?: Partial<IBanned>;
  muted?: Partial<IMuted>;
}

const ServerMemberSchema = new Schema<IServerMember>(
  {
    server: {
      type: Schema.Types.ObjectId,
      ref: "DiscordServer",
      required: true,
    },
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    roles: { type: [String], default: ["member"] },
    banned: {
      isBanned: { type: Boolean },
      reason: { type: String },
      bannedBy: { type: Schema.Types.ObjectId, ref: "User" },
    },
    muted: {
      isMuted: { type: Boolean },
      reason: { type: String },
      mutedBy: { type: Schema.Types.ObjectId, ref: "User" },
      expiresAt: { type: Date },
    },
  },
  { timestamps: true }
);

ServerMemberSchema.index({ server: 1, user: 1 }, { unique: true });

// The compound index above is keyed server-first, so it cannot serve a query
// filtered on `user` alone — those collection-scan instead (confirmed via
// explain: COLLSCAN). That shape is not rare: serverPrivacy.ts's
// blockedByEverySharedServer runs TWO `ServerMember.find({ user }).distinct()`
// calls, and it sits on the critical path of EVERY 1:1 DM send (the
// "are DMs disabled between members of a community you share" check). It is
// cheap today only because this collection is small; it grows linearly with
// total memberships across the platform, and it grows on the one path users
// feel most directly. This index keeps that lookup O(matching rows).
ServerMemberSchema.index({ user: 1 });

const ServerMember = mongoose.model<IServerMember>(
  "ServerMember",
  ServerMemberSchema
);
export default ServerMember;
