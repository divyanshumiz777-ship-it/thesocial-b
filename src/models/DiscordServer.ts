import mongoose, { Schema, Types } from "mongoose";

export interface IDiscordServer {
  _id: Types.ObjectId;
  owner: Types.ObjectId;
  categories: Types.ObjectId[];
  channels: Types.ObjectId[];
  name: string;
  members: Types.ObjectId[];
  onlineCount: number;
}

export interface IBanned {
  isBanned: boolean;
  reason: string;
  bannedBy: Types.ObjectId;
}

export interface IMuted {
  isMuted: boolean;
  reason: string;
  mutedBy: Types.ObjectId;
  expiresAt: Date;
}
export interface IMember {
  user: Types.ObjectId;
  roles: string[];
  banned: IBanned;
  muted: IMuted;
}

const muted = new Schema<IMuted>(
  {
    isMuted: {
      type: Boolean,
      default: false,
    },
    reason: {
      type: String,
      required: true,
    },
    mutedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  { timestamps: true }
);

const banned = new Schema<IBanned>(
  {
    isBanned: {
      type: Boolean,
      default: false,
    },
    reason: {
      type: String,
      required: true,
    },
    bannedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true }
);

const memberSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    roles: {
      type: [String],
      default: ["member"],
    },
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
