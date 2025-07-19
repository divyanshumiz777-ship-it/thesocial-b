import mongoose, { Schema, Types } from "mongoose";

export interface IDiscordServer {
  _id: Types.ObjectId;
  owner: Types.ObjectId;
  categories: Types.ObjectId[];
  channels: Types.ObjectId[];
  name: string;
  members: Types.ObjectId[];
  createdAt: Date;
}

export interface IMember {
  user: Types.ObjectId;
  roles: string[];
}

const memberSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    roles: {
      type: [String],
      default: ["Member"],
    },
  },
  { _id: false }
);

const DiscordServerSchema = new Schema<IDiscordServer>({
  owner: { type: Schema.Types.ObjectId, ref: "User", required: true },
  categories: [{ type: Schema.Types.ObjectId, ref: "Category" }],
  channels: [{ type: Schema.Types.ObjectId, ref: "Channel" }],
  name: { type: String, required: true, maxLength: 100 },
  members: [memberSchema],
  createdAt: { type: Date, default: Date.now },
});

const DiscordServer = mongoose.model<IDiscordServer>(
  "DiscordServer",
  DiscordServerSchema
);
export default DiscordServer;
