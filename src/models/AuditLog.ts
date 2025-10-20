import mongoose, { Schema, Types, Document } from "mongoose";

export interface IAuditLog extends Document {
  server: Types.ObjectId;
  action: string;
  performedBy: Types.ObjectId;
  targetUser?: Types.ObjectId;
  details?: string;
  createdAt: Date;
}

const AuditLogSchema = new Schema<IAuditLog>({
  server: { type: Schema.Types.ObjectId, ref: "DiscordServer", required: true },
  action: { type: String, required: true },
  performedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  targetUser: { type: Schema.Types.ObjectId, ref: "User" },
  details: { type: String },
  createdAt: { type: Date, default: Date.now },
});

export default mongoose.model<IAuditLog>("AuditLog", AuditLogSchema);
