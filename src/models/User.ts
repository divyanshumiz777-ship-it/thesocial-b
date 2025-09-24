import mongoose, { Schema, Document, Types } from "mongoose";

interface IUser extends Document {
  name: string;
  email: string;
  lastSeen: Date;
  servers?: Types.ObjectId[];
  roles?: Types.ObjectId[];
  password?: string;
  profilePic?: string;
  dms?: Types.ObjectId[];
  provider: string;
  providerAccountId?: string;
  resetPasswordToken?: string;
  resetPasswordExpires?: Date;
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
  dms: [{ type: Schema.Types.ObjectId, ref: "DirectMessage" }],
  lastSeen: { type: Date, default: Date.now },
  provider: { type: String, default: "credentials" },
  providerAccountId: { type: String },
  servers: [{ type: Schema.Types.ObjectId, ref: "DiscordServer" }],
  roles: [{ type: Schema.Types.ObjectId, ref: "Role" }],
  resetPasswordToken: { type: String },
  resetPasswordExpires: { type: Date },
});

const User = mongoose.model<IUser>("User", UserSchema);

export default User;
