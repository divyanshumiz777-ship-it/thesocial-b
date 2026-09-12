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
  type: "member_added" | "member_removed" | "member_left";
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
  // Added by the schema's `{ timestamps: true }` option below, not declared
  // here until now — every existing controller that reads createdAt off a
  // Message either sorted by it (schema-level, type-agnostic) or read it off
  // a `.lean()` result (a plain object, not this interface), so nothing hit
  // this gap before a 24h-delete-window check needed it on a live Document.
  createdAt: Date;
  updatedAt: Date;
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
  // Client-generated idempotency key for a 1:1 DM send (dmController.ts's
  // createDm) — lets a client that never received its own send's response
  // (a timed-out/aborted request that actually succeeded server-side, a
  // real, confirmed occurrence — see that controller's own comment) safely
  // retry with the SAME key instead of either silently double-posting or
  // refusing to retry at all. Optional and unindexed-by-absence (sparse
  // index below): only DM sends set this; channel/group messages, call-log
  // entries, etc. never do.
  clientMessageId?: string;
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
      enum: ["member_added", "member_removed", "member_left"],
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
    clientMessageId: { type: String },
  },
  { timestamps: true }
);

// Enforces createDm's idempotency guarantee at the DB level, not just via
// the controller's own pre-check (which alone would still race two truly
// concurrent identical retries) — a real duplicate insert attempt fails
// with E11000 instead of creating a second message, and the controller
// treats that failure as "someone else already won this exact retry" (see
// its own comment).
//
// partialFilterExpression, NOT `sparse: true` — a compound sparse index
// only skips a document when ALL of its indexed fields are missing, not
// when just one is. `sender` is `required: true` on this schema, so it is
// NEVER missing; a plain `sparse: true` here would therefore index EVERY
// message (clientMessageId standing in as literal `null` when absent), and
// any two messages from the same sender in the same conversation that both
// lack a clientMessageId — which describes every message sent from a
// client that has never set this field, e.g. the web app today — would
// collide as duplicate keys and fail to insert. A partial index actually
// restricts the index to documents matching the filter, giving the "only
// constrain a real idempotency key" semantics these indexes need.
//
// The filter ALSO requires the index's own scoping field (conversationId/
// groupId/channel) to exist, not just clientMessageId — without that, a
// message with neither field set (e.g. a group message, which never sets
// conversationId) still gets an index entry on THIS index with that field
// standing in as `null`, same root problem as the sparse bug above, just
// one level down: two messages in two DIFFERENT groups (both leaving
// conversationId AND channel unset) from the same sender, sharing whatever
// clientMessageId value a client happens to submit (fully client-supplied,
// e.g. mobile/src/hooks/useGroupMessages.ts's tempId — nothing stops a
// client from ever reusing one), would collide on this DM-scoped index even
// though neither message has anything to do with a DM.
MessageSchema.index(
  { conversationId: 1, sender: 1, clientMessageId: 1 },
  {
    unique: true,
    partialFilterExpression: { conversationId: { $exists: true }, clientMessageId: { $exists: true } },
  }
);
// Same idempotency mechanism as the DM index directly above, for the other
// two message surfaces — group DM sends and channel sends. The
// controller-side dedupe logic for these is implemented separately; these
// are schema-level indexes only. Same partialFilterExpression reasoning as
// above — only a message that actually supplies a clientMessageId, AND
// actually belongs to this index's own room type, is subject to the
// uniqueness constraint at all.
MessageSchema.index(
  { groupId: 1, sender: 1, clientMessageId: 1 },
  {
    unique: true,
    partialFilterExpression: { groupId: { $exists: true }, clientMessageId: { $exists: true } },
  }
);
MessageSchema.index(
  { channel: 1, sender: 1, clientMessageId: 1 },
  {
    unique: true,
    partialFilterExpression: { channel: { $exists: true }, clientMessageId: { $exists: true } },
  }
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
