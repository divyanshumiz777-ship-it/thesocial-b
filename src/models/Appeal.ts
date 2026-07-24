import mongoose, { Schema, Document, Types } from "mongoose";

// A banned/muted user's request for a human to reconsider — reuses the same
// pending/reviewed/dismissed status vocabulary UserReport already has, so
// the admin queue UI patterns (adminController.ts's getAdminReports) extend
// to appeals with minimal new surface.
interface IAppeal extends Document {
  user: Types.ObjectId;
  server: Types.ObjectId;
  action: "ban" | "mute";
  reason: string;
  status: "pending" | "reviewed" | "dismissed";
  resolvedBy?: Types.ObjectId;
  resolvedAt?: Date;
  resolution?: "reversed" | "upheld";
  createdAt: Date;
  updatedAt: Date;
}

const AppealSchema = new Schema<IAppeal>(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    server: { type: Schema.Types.ObjectId, ref: "DiscordServer", required: true },
    action: { type: String, enum: ["ban", "mute"], required: true },
    reason: { type: String, required: true, maxlength: 1000 },
    status: {
      type: String,
      enum: ["pending", "reviewed", "dismissed"],
      default: "pending",
    },
    resolvedBy: { type: Schema.Types.ObjectId, ref: "User" },
    resolvedAt: { type: Date },
    resolution: { type: String, enum: ["reversed", "upheld"] },
  },
  { timestamps: true },
);

AppealSchema.index({ status: 1, createdAt: -1 });
AppealSchema.index({ user: 1, server: 1 });

export default mongoose.model<IAppeal>("Appeal", AppealSchema);
export type { IAppeal };
