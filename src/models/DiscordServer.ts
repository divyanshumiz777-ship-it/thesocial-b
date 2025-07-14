import mongoose, { Schema } from "mongoose";

interface IDiscordServer {
  owner: Schema.Types.ObjectId;
  categories: Schema.Types.ObjectId[];
  channels: Schema.Types.ObjectId[];
  name: string;
  members: Schema.Types.ObjectId[];
  createdAt: Date;
}

const DiscordServerSchema = new Schema<IDiscordServer>({
  owner: { type: Schema.Types.ObjectId, ref: "User", required: true },
  categories: [{ type: Schema.Types.ObjectId, ref: "Category" }],
  channels: [{ type: Schema.Types.ObjectId, ref: "Channel" }],
  name: { type: String, required: true, maxLength: 100 },
  members: [{ type: Schema.Types.ObjectId, ref: "User" }],
  createdAt: { type: Date, default: Date.now },
});

const DiscordServer = mongoose.model("DiscordServer", DiscordServerSchema);
export default DiscordServer;
