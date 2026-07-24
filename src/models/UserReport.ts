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

export type ReportContentType = "profile" | "message" | "reel" | "comment" | "call";
export const REPORT_CONTENT_TYPES: ReportContentType[] = [
  "profile",
  "message",
  "reel",
  "comment",
  "call",
];

export type ReportSeverity = "low" | "medium" | "high";

interface ITriage {
  severity: ReportSeverity;
  rationale: string;
  suggestedAction: "none" | "warn" | "mute" | "ban" | "escalate";
  generatedAt: Date;
}

interface IResolution {
  action: "ban" | "mute" | "dismiss";
  server?: Types.ObjectId;
  resolvedBy: Types.ObjectId;
  resolvedAt: Date;
  auditLog?: Types.ObjectId;
}

interface IUserReport extends Document {
  reporter: Types.ObjectId;
  reportedUser: Types.ObjectId;
  reason: ReportReason;
  details?: string;
  status: "pending" | "reviewed" | "dismissed";
  // Content-in-context — a report used to carry only reporter/reportedUser/
  // reason, no evidence of what was actually said or posted. Optional
  // because the original profile-page report flow still has none of this.
  contentType?: ReportContentType;
  contentId?: Types.ObjectId;
  serverId?: Types.ObjectId;
  channelId?: Types.ObjectId;
  snippet?: string;
  // Filled in by an async, non-blocking chat-service call after creation —
  // never gates the report itself, only prioritizes the admin queue.
  triage?: ITriage;
  resolution?: IResolution;
  createdAt: Date;
  updatedAt: Date;
}

const TriageSchema = new Schema<ITriage>(
  {
    severity: { type: String, enum: ["low", "medium", "high"], required: true },
    rationale: { type: String, required: true, maxlength: 300 },
    suggestedAction: {
      type: String,
      enum: ["none", "warn", "mute", "ban", "escalate"],
      required: true,
    },
    generatedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const ResolutionSchema = new Schema<IResolution>(
  {
    action: { type: String, enum: ["ban", "mute", "dismiss"], required: true },
    server: { type: Schema.Types.ObjectId, ref: "DiscordServer" },
    resolvedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    resolvedAt: { type: Date, default: Date.now },
    auditLog: { type: Schema.Types.ObjectId, ref: "AuditLog" },
  },
  { _id: false },
);

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
    contentType: { type: String, enum: REPORT_CONTENT_TYPES },
    contentId: { type: Schema.Types.ObjectId },
    serverId: { type: Schema.Types.ObjectId, ref: "DiscordServer" },
    channelId: { type: Schema.Types.ObjectId, ref: "Channel" },
    snippet: { type: String, maxlength: 2000 },
    triage: { type: TriageSchema },
    resolution: { type: ResolutionSchema },
  },
  { timestamps: true }
);

UserReportSchema.index({ reportedUser: 1, status: 1 });
UserReportSchema.index({ reporter: 1, createdAt: -1 });
UserReportSchema.index({ "triage.severity": 1, status: 1 });

const UserReport = mongoose.model<IUserReport>("UserReport", UserReportSchema);

export default UserReport;
export type { IUserReport };
