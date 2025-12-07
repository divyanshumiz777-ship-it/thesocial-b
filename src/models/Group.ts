import mongoose, { Schema } from "mongoose";

export interface IGroup extends Document {
  _id: Schema.Types.ObjectId;
  name: string;
  description?: string;
  icon?: string;
  owner: Schema.Types.ObjectId;
  admins: Schema.Types.ObjectId[];
  participants: Schema.Types.ObjectId[];
  messages: Schema.Types.ObjectId[];
  isGroupDM: boolean;
  isDisabled?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

const GroupSchema = new Schema<IGroup>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 500,
    },
    icon: {
      type: String,
      required: false,
    },
    owner: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    admins: [
      {
        type: Schema.Types.ObjectId,
        ref: "User",
      },
    ],
    participants: [
      {
        type: Schema.Types.ObjectId,
        ref: "User",
        required: true,
      },
    ],
    messages: [
      {
        type: Schema.Types.ObjectId,
        ref: "Message",
      },
    ],
    isGroupDM: {
      type: Boolean,
      default: true,
    },
    isDisabled: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

GroupSchema.index({ participants: 1 });
GroupSchema.index({ owner: 1 });
GroupSchema.index({ updatedAt: -1 });

const Group = mongoose.model<IGroup>("Group", GroupSchema);

export default Group;
