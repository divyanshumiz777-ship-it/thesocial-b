import mongoose, { Schema, Document, Types } from "mongoose";

export interface INotification extends Document {
  recipient: Types.ObjectId;
  sender?: Types.ObjectId;
  type:
    | "join_request"
    | "join_approved"
    | "join_rejected"
    | "friend_request"
    | "friend_accepted"
    | "message_mention"
    | "server_invite"
    | "role_updated"
    | "member_joined"
    | "member_left"
    | "follow";
  title: string;
  message: string;
  metadata?: {
    serverId?: Types.ObjectId;
    serverName?: string;
    channelId?: Types.ObjectId;
    channelName?: string;
    messageId?: Types.ObjectId;
    requestId?: string;
    inviteCode?: string;
    [key: string]: any;
  };
  read: boolean;
  actionUrl?: string;
  createdAt: Date;
  updatedAt: Date;
}

const NotificationSchema = new Schema<INotification>(
  {
    recipient: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    sender: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    type: {
      type: String,
      enum: [
        "join_request",
        "join_approved",
        "join_rejected",
        "friend_request",
        "friend_accepted",
        "message_mention",
        "server_invite",
        "role_updated",
        "member_joined",
        "member_left",
        "follow",
      ],
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
    },
    message: {
      type: String,
      required: true,
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
    read: {
      type: Boolean,
      default: false,
      index: true,
    },
    actionUrl: {
      type: String,
    },
  },
  {
    timestamps: true,
  }
);

NotificationSchema.index({ recipient: 1, read: 1, createdAt: -1 });

NotificationSchema.index(
  { createdAt: 1 },
  {
    expireAfterSeconds: 30 * 24 * 60 * 60,
    partialFilterExpression: { read: true },
  }
);

const Notification = mongoose.model<INotification>(
  "Notification",
  NotificationSchema
);

export default Notification;
