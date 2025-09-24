import mongoose, { Schema } from "mongoose";
import { IDiscordServer, IMuted, IBanned } from "./discordServer.types";

const muted = new Schema<IMuted>(
  {
    isMuted: { type: Boolean, default: false },
    reason: { type: String, required: true },
    mutedBy: { type: Schema.Types.ObjectId, ref: "User" },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

const banned = new Schema<IBanned>(
  {
    isBanned: { type: Boolean, default: false },
    reason: { type: String, required: true },
    bannedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

const memberSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    roles: { type: [String], default: ["member"] },
    banned: banned,
    muted: muted,
  },
  { _id: false }
);

const DiscordServerSchema = new Schema<IDiscordServer>(
  {
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true },
    categories: [{ type: Schema.Types.ObjectId, ref: "Category" }],
    channels: [{ type: Schema.Types.ObjectId, ref: "Channel" }],
    name: { type: String, required: true, maxLength: 100 },
    description: { type: String, maxLength: 500 },
    imageUrl: { type: String },
    members: [memberSchema],
    onlineCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

const DiscordServer = mongoose.model<IDiscordServer>(
  "DiscordServer",
  DiscordServerSchema
);

export default DiscordServer;
