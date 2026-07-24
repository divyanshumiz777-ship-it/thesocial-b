import mongoose, { Schema, Document, Types } from "mongoose";

export type SavedItemType = "message" | "reel";

interface ISavedItem extends Document {
  user: Types.ObjectId;
  itemType: SavedItemType;
  itemId: Types.ObjectId;
  serverId?: Types.ObjectId;
  channelId?: Types.ObjectId;
  conversationId?: Types.ObjectId;
  // Denormalized snapshot so the "Saved" page can render without N+1
  // lookups into Message/Reel (and still shows something sensible if the
  // original is later deleted) — purely user-curated, private to the saver,
  // deliberately never surfaced to anyone else (no algorithmic resurfacing).
  snippet: string;
  savedAt: Date;
}

const SavedItemSchema = new Schema<ISavedItem>({
  user: { type: Schema.Types.ObjectId, ref: "User", required: true },
  itemType: { type: String, enum: ["message", "reel"], required: true },
  itemId: { type: Schema.Types.ObjectId, required: true },
  serverId: { type: Schema.Types.ObjectId, ref: "DiscordServer" },
  channelId: { type: Schema.Types.ObjectId, ref: "Channel" },
  conversationId: { type: Schema.Types.ObjectId, ref: "Group" },
  snippet: { type: String, required: true, maxlength: 500 },
  savedAt: { type: Date, default: Date.now },
});

SavedItemSchema.index({ user: 1, savedAt: -1 });
SavedItemSchema.index({ user: 1, itemType: 1, itemId: 1 }, { unique: true });

export default mongoose.model<ISavedItem>("SavedItem", SavedItemSchema);
export type { ISavedItem };
