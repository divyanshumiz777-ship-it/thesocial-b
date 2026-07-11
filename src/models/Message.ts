import mongoose, { Schema, Document, Types } from "mongoose";

export interface IReaction {
  emoji: string;
  users: Types.ObjectId[];
}

export interface IAttachment {
  url: string;
  type: "image" | "video" | "gif" | "sticker" | "document" | "audio";
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
}

export interface ICallInfo {
  type: "voice" | "video";
  outcome: "completed" | "missed" | "rejected" | "cancelled";
  // Only set for a "completed" call — the others never connected.
  durationSeconds?: number;
  caller: Types.ObjectId;
}

export interface IMessage extends Document {
  content: string;
  formattedContent?: string;
  plainText?: string;
  sender: Types.ObjectId;
  edited: boolean;
  channel?: Types.ObjectId;
  server: Types.ObjectId;
  thread?: Types.ObjectId;
  conversationId?: Types.ObjectId;
  groupId?: Types.ObjectId;
  replyTo?: Types.ObjectId;
  reactions: IReaction[];
  mentions: Types.ObjectId[];
  attachments: string[];
  attachmentsV2?: IAttachment[];
  deletedFor?: Types.ObjectId[];
  deletedForEveryone?: boolean;
  pinned?: boolean;
  pinnedBy?: Types.ObjectId;
  pinnedAt?: Date;
  readBy?: Array<{
    user: Types.ObjectId;
    readAt: Date;
  }>;
  // Present only on a system-generated 1:1 call-log entry (see
  // lib/dmCallService.ts) — rendered as a distinct pill in the DM thread
  // instead of a normal bubble. `content` is still set to a plain-text
  // fallback for search/notifications, but callInfo is what the UI checks.
  callInfo?: ICallInfo;
}

const ReactionSchema = new Schema<IReaction>(
  {
    emoji: { type: String, required: true },
    users: [{ type: Schema.Types.ObjectId, ref: "User" }],
  },
  { _id: false }
);

const AttachmentSchema = new Schema<IAttachment>(
  {
    url: { type: String, required: true },
    type: {
      type: String,
      enum: ["image", "video", "gif", "sticker", "document", "audio"],
      required: true,
    },
    fileName: { type: String },
    fileSize: { type: Number },
    mimeType: { type: String },
  },
  { _id: false }
);

const CallInfoSchema = new Schema<ICallInfo>(
  {
    type: { type: String, enum: ["voice", "video"], required: true },
    outcome: {
      type: String,
      enum: ["completed", "missed", "rejected", "cancelled"],
      required: true,
    },
    durationSeconds: { type: Number },
    caller: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { _id: false }
);

const MessageSchema = new Schema<IMessage>(
  {
    content: { type: String },
    formattedContent: { type: String },
    plainText: { type: String },
    sender: { type: Schema.Types.ObjectId, ref: "User", required: true },
    edited: { type: Boolean, default: false },
    channel: { type: Schema.Types.ObjectId, ref: "Channel" },
    server: { type: Schema.Types.ObjectId, ref: "DiscordServer" },
    conversationId: { type: Schema.Types.ObjectId, ref: "Conversation" },
    groupId: { type: Schema.Types.ObjectId, ref: "Group" },
    thread: { type: Schema.Types.ObjectId, ref: "Thread" },
    replyTo: { type: Schema.Types.ObjectId, ref: "Message" },
    reactions: [ReactionSchema],
    mentions: [{ type: Schema.Types.ObjectId, ref: "User" }],
    attachments: [{ type: String }],
    attachmentsV2: [AttachmentSchema],
    deletedFor: [{ type: Schema.Types.ObjectId, ref: "User" }],
    deletedForEveryone: { type: Boolean, default: false },
    pinned: { type: Boolean, default: false },
    pinnedBy: { type: Schema.Types.ObjectId, ref: "User" },
    pinnedAt: { type: Date },
    readBy: [
      {
        user: { type: Schema.Types.ObjectId, ref: "User" },
        readAt: { type: Date, default: Date.now },
      },
    ],
    callInfo: { type: CallInfoSchema },
  },
  { timestamps: true }
);

MessageSchema.index({ server: 1, channel: 1, thread: 1, createdAt: -1 });
MessageSchema.index({ plainText: "text", content: "text" });
MessageSchema.index({ conversationId: 1, createdAt: -1 });
MessageSchema.index({ conversationId: 1, _id: -1 });
MessageSchema.index({ groupId: 1, createdAt: -1 });
MessageSchema.index({ sender: 1, createdAt: -1 });
MessageSchema.index({ pinned: 1, channel: 1 });

const Message = mongoose.model<IMessage>("Message", MessageSchema);
export default Message;
