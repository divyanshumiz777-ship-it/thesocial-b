import mongoose, { Schema } from "mongoose";
import {
  IDiscordServer,
  IMuted,
  IBanned,
  IJoinRequest,
  IPrivacy,
} from "./discordServer.types.ts";

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

const joinRequestSchema = new Schema<IJoinRequest>(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    requestedAt: { type: Date, default: Date.now },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
    },
  },
  { _id: false }
);

const privacySchema = new Schema<IPrivacy>(
  {
    showInSearch: { type: Boolean, default: true },
    allowMemberDMs: { type: Boolean, default: true },
    allowFriendRequests: { type: Boolean, default: true },
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
    visibility: {
      type: String,
      enum: ["public", "private", "invite-only"],
      default: "public",
    },
    imageUrl: { type: String },
    members: [memberSchema],
    joinRequests: [joinRequestSchema],
    onlineCount: { type: Number, default: 0 },
    privacy: { type: privacySchema, default: () => ({}) },
  },
  { timestamps: true }
);

DiscordServerSchema.index({ name: "text" });
DiscordServerSchema.index({ owner: 1 });
DiscordServerSchema.index({ "members.user": 1 });
DiscordServerSchema.index({ updatedAt: -1 });

const DiscordServer = mongoose.model<IDiscordServer>(
  "DiscordServer",
  DiscordServerSchema
);
export default DiscordServer;
