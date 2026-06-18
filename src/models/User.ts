import mongoose, { Schema, Document, Types } from "mongoose";

interface IUser extends Document {
  name: string;
  email: string;
  lastSeen: Date;
  servers?: Types.ObjectId[];
  roles?: Types.ObjectId[];
  password?: string;
  profilePic?: string;
  about?: string;
  dms?: Types.ObjectId[];
  friends?: Types.ObjectId[];
  blockedUsers?: Types.ObjectId[];
  provider: string;
  providerAccountId?: string;
  resetPasswordToken?: string;
  resetPasswordExpires?: Date;
  customStatus?: {
    text?: string;
    emoji?: string;
    expiresAt?: Date;
  };
  settings?: {
    privacy?: {
      profileVisibility?: "public" | "private" | "friends";
      allowDMRequests?: boolean;
    };
    notifications?: {
      email?: boolean;
      push?: boolean;
      level?: "all" | "mentions" | "none";
    };
    theme?: string;
    language?: string;
    connectedAccounts?: Array<{ provider: string; accountId: string }>;
    mutedServers?: Types.ObjectId[];
  };
}

const UserSchema = new Schema<IUser>({
  name: { type: String, trim: true, required: true },
  email: {
    type: String,
    required: [true, "Email is required"],
    unique: true,
    lowercase: true,
    match: [
      /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/,
      "Please provide a valid email address",
    ],
    index: true,
  },
  password: {
    type: String,
    required: [
      function (this: any) {
        return this.provider === "credentials";
      },
      "Password is required for local accounts",
    ],
    minlength: [6, "Password must be at least 6 characters long"],
    select: false,
  },
  profilePic: {
    type: String,
    default: "",
  },
  about: {
    type: String,
    default: "",
    maxlength: 190,
  },
  dms: [{ type: Schema.Types.ObjectId, ref: "DirectMessage" }],
  friends: [{ type: Schema.Types.ObjectId, ref: "User" }],
  blockedUsers: [{ type: Schema.Types.ObjectId, ref: "User" }],
  lastSeen: { type: Date, default: Date.now },
  provider: { type: String, default: "credentials" },
  providerAccountId: { type: String },
  servers: [{ type: Schema.Types.ObjectId, ref: "DiscordServer" }],
  roles: [{ type: Schema.Types.ObjectId, ref: "Role" }],
  resetPasswordToken: { type: String },
  resetPasswordExpires: { type: Date },
  customStatus: {
    text: { type: String, maxlength: 128 },
    emoji: { type: String, maxlength: 50 },
    expiresAt: { type: Date },
  },
  settings: {
    privacy: {
      profileVisibility: {
        type: String,
        enum: ["public", "private", "friends"],
        default: "public",
      },
      allowDMRequests: { type: Boolean, default: true },
    },
    notifications: {
      email: { type: Boolean, default: true },
      push: { type: Boolean, default: true },
      level: {
        type: String,
        enum: ["all", "mentions", "none"],
        default: "all",
      },
    },
    theme: { type: String, default: "light" },
    language: { type: String, default: "en" },
    connectedAccounts: [
      {
        provider: { type: String, required: true },
        accountId: { type: String, required: true },
      },
    ],
    mutedServers: [{ type: Schema.Types.ObjectId, ref: "DiscordServer" }],
  },
});
UserSchema.index({ email: 1 }, { unique: true });
UserSchema.index({ name: "text", email: "text" });
UserSchema.index({ lastSeen: 1 });
UserSchema.index({ provider: 1, providerAccountId: 1 });

const User = mongoose.model<IUser>("User", UserSchema);

export default User;
