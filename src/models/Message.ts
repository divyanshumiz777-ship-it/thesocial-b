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

// Present only on a system-generated group-membership entry (see
// groupDmController.ts's createGroupSystemMessage) — rendered as a distinct
// pill in the group thread, same convention as callInfo above.
export interface ISystemInfo {
  type: "member_added" | "member_removed";
  actor: Types.ObjectId;
  targets: Types.ObjectId[];
}

// Denormalized (name copied at forward time) so a "Forwarded from X" label
// still renders sensibly even if the original sender later changes their
// name or the original message/conversation becomes inaccessible to the
// viewer — this is attribution metadata on a brand-new message the forwarder
// owns, not a live reference the original author could retract.
export interface IForwardedFrom {
  messageId: Types.ObjectId;
  senderId: Types.ObjectId;
  senderName: string;
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
  // Group-DM delivery tracking (parallel to readBy, but membership-only — no
  // per-user timestamp needed for tick derivation). 1:1 DMs track delivery as
  // a single conversation-level high-water-mark (Conversation.lastDeliveredAt
  // via dmController); a group has multiple recipients, so "delivered to all"
  // has to be derived per-message instead. Populated by
  // groupDmController.markGroupDelivered, called when a member opens the
  // group chat.
  deliveredTo?: Types.ObjectId[];
  // Present only on a system-generated 1:1 call-log entry (see
  // lib/dmCallService.ts) — rendered as a distinct pill in the DM thread
  // instead of a normal bubble. `content` is still set to a plain-text
  // fallback for search/notifications, but callInfo is what the UI checks.
  callInfo?: ICallInfo;
  systemInfo?: ISystemInfo;
  forwardedFrom?: IForwardedFrom;
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

const SystemInfoSchema = new Schema<ISystemInfo>(
  {
    type: {
      type: String,
      enum: ["member_added", "member_removed"],
      required: true,
    },
    actor: { type: Schema.Types.ObjectId, ref: "User", required: true },
    targets: [{ type: Schema.Types.ObjectId, ref: "User" }],
  },
  { _id: false }
);

const ForwardedFromSchema = new Schema<IForwardedFrom>(
  {
    messageId: { type: Schema.Types.ObjectId, ref: "Message", required: true },
    senderId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    senderName: { type: String, required: true },
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
    deliveredTo: [{ type: Schema.Types.ObjectId, ref: "User" }],
    callInfo: { type: CallInfoSchema },
    systemInfo: { type: SystemInfoSchema },
    forwardedFrom: { type: ForwardedFromSchema },
  },
  { timestamps: true }
);

MessageSchema.index({ server: 1, channel: 1, thread: 1, createdAt: -1 });
MessageSchema.index({ plainText: "text", content: "text" });
MessageSchema.index({ conversationId: 1, createdAt: -1 });
MessageSchema.index({ conversationId: 1, _id: -1 });
MessageSchema.index({ groupId: 1, createdAt: -1 });
// getGroupMessages (groupDmController.ts) filters/sorts by {groupId, _id} for
// cursor pagination, not createdAt — the index above has createdAt as its
// second key, so it can only serve the groupId equality prefix and still
// needs an in-memory sort for every "load older" call. This is the exact
// second index conversationId already has (line above vs. two lines up).
MessageSchema.index({ groupId: 1, _id: -1 });
MessageSchema.index({ sender: 1, createdAt: -1 });
MessageSchema.index({ pinned: 1, channel: 1 });
// getMessagesByChannelId (messageController.ts) filters ONLY on {channel},
// sorted by createdAt — the only prior index covering channel is
// {server, channel, thread, createdAt}, where channel is the SECOND key, so
// a channel-only query can't use it as an equality-seek prefix. This is the
// busiest read path in the app; this index lets it seek directly.
MessageSchema.index({ channel: 1, createdAt: -1 });

const Message = mongoose.model<IMessage>("Message", MessageSchema);
export default Message;
