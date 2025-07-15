import mongoose, { Schema, Types } from "mongoose";

export interface ICategory {
  _id: Types.ObjectId;
  name: string;
  server: Types.ObjectId;
  channels: Types.ObjectId[];
  createdAt: Date;
}

const CategorySchema = new Schema<ICategory>({
  name: { type: String, required: true },
  server: { type: Schema.Types.ObjectId, ref: "DiscordServer", required: true },
  channels: [{ type: Schema.Types.ObjectId, ref: "Channel" }],
  createdAt: { type: Date, default: Date.now },
});

const Category = mongoose.model<ICategory>("Category", CategorySchema);
export default Category;
