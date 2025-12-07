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
  },
  { timestamps: true }
);

MessageSchema.index({ server: 1, channel: 1, thread: 1, createdAt: -1 });
MessageSchema.index({ plainText: "text", content: "text" });

const Message = mongoose.model<IMessage>("Message", MessageSchema);
export default Message;
