import mongoose, { Schema, Document } from "mongoose";

interface IUser extends Document {
  name: string;
  email: string;
  password?: string;
  profilePic?: string;
  provider: string;
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
        return this.provider === "local";
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
  provider: { type: String, default: "local" },
  resetPasswordToken: { type: String },
  resetPasswordExpires: { type: Date },
});

const User = mongoose.model<IUser>("User", UserSchema);
export default User;
