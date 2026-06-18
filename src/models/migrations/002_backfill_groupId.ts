/**
 * Migration 002: Backfill Message.groupId from Group.messages[]
 *
 * Why: P2-11 added groupId to MessageSchema. Existing group messages
 * already have their IDs stored in Group.messages[] but the Message
 * documents themselves have no groupId field. getGroupMessages now
 * queries by groupId, so old messages would be invisible until backfilled.
 *
 * Run once: npx tsx src/models/migrations/002_backfill_groupId.ts
 * Safe to re-run: only touches messages where groupId is not yet set.
 */

import mongoose from "mongoose";
import Group from "../Group.ts";
import Message from "../Message.ts";

const BATCH_SIZE = 1000;

async function run(): Promise<void> {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI is not set");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log("[002] Connected to MongoDB");

  const groups = await Group.find({}, "_id messages").lean();
  console.log(`[002] Found ${groups.length} groups to process`);

  let totalUpdated = 0;

  for (const group of groups) {
    const messageIds = (group.messages ?? []) as unknown as mongoose.Types.ObjectId[];
    if (messageIds.length === 0) continue;

    for (let i = 0; i < messageIds.length; i += BATCH_SIZE) {
      const batch = messageIds.slice(i, i + BATCH_SIZE);
      const result = await Message.updateMany(
        { _id: { $in: batch }, groupId: { $exists: false } },
        { $set: { groupId: group._id } }
      );
      totalUpdated += result.modifiedCount;
    }
  }

  const totalWithGroupId = await Message.countDocuments({
    groupId: { $exists: true },
  });

  console.log(`[002] Done. Messages updated: ${totalUpdated}`);
  console.log(`[002] Total messages with groupId: ${totalWithGroupId}`);

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error("[002] Migration failed:", err);
  process.exit(1);
});
