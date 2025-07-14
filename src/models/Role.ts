import mongoose, { Schema, Document, Types } from "mongoose";

interface IRole extends Document {
  user: Types.ObjectId;
  server: Types.ObjectId;
  role: "admin" | "member";
}

const RoleSchema = new Schema<IRole>({
  user: { type: Schema.Types.ObjectId, ref: "User", required: true },
  server: { type: Schema.Types.ObjectId, ref: "DiscordServer", required: true },
  role: {
    type: String,
    enum: ["admin", "member"],
    required: true,
  },
});

const Role = mongoose.model<IRole>("Role", RoleSchema);
export default Role;
