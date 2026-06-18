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

const ServerMember = mongoose.model<IServerMember>(
  "ServerMember",
  ServerMemberSchema
);
export default ServerMember;
