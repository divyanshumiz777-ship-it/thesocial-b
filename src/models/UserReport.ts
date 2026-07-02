import mongoose, { Schema, Document, Types } from "mongoose";

export type ReportReason =
  | "spam"
  | "harassment"
  | "impersonation"
  | "inappropriate_content"
  | "other";

export const REPORT_REASONS: ReportReason[] = [
  "spam",
  "harassment",
  "impersonation",
  "inappropriate_content",
  "other",
];

interface IUserReport extends Document {
  reporter: Types.ObjectId;
  reportedUser: Types.ObjectId;
  reason: ReportReason;
  details?: string;
  status: "pending" | "reviewed" | "dismissed";
  createdAt: Date;
  updatedAt: Date;
}

const UserReportSchema = new Schema<IUserReport>(
  {
    reporter: { type: Schema.Types.ObjectId, ref: "User", required: true },
    reportedUser: { type: Schema.Types.ObjectId, ref: "User", required: true },
    reason: { type: String, enum: REPORT_REASONS, required: true },
    details: { type: String, maxlength: 500 },
    status: {
      type: String,
      enum: ["pending", "reviewed", "dismissed"],
      default: "pending",
    },
  },
  { timestamps: true }
);

UserReportSchema.index({ reportedUser: 1, status: 1 });
UserReportSchema.index({ reporter: 1, createdAt: -1 });

const UserReport = mongoose.model<IUserReport>("UserReport", UserReportSchema);

export default UserReport;
export type { IUserReport };
