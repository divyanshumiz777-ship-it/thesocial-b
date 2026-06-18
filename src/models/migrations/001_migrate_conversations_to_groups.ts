/**
 * Migration 001: Convert multi-participant Conversations to Group documents
 *
 * Why: getUserGroups called migrateConversationToGroup() on every request,
 * running O(n) DB writes per page load. This migration runs once to do
 * the conversion up-front. After running, remove the on-request migration
 * call from getUserGroups.
 *
 * Run once: MONGO_URI=... npx tsx src/models/migrations/001_migrate_conversations_to_groups.ts
 * Safe to re-run: Group.findById check skips already-migrated conversations.
 */

import mongoose from "mongoose";
import Conversation from "../Conversation.ts";
import Group from "../Group.ts";

const BATCH_SIZE = 500;
const BATCH_DELAY_MS = 100;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run(): Promise<void> {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI is not set");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log("[001] Connected to MongoDB");

  const total = await Conversation.countDocuments({
    $expr: { $gte: [{ $size: "$participants" }, 2] },
  });
  console.log(`[001] Found ${total} multi-participant conversations to process`);

  let processed = 0;
  let created = 0;
  let skipped = 0;
  let failed = 0;

  const cursor = Conversation.find({
    $expr: { $gte: [{ $size: "$participants" }, 2] },
  })
    .populate("participants")
    .cursor();

  const batch: typeof Group.prototype[] = [];

  for await (const conv of cursor) {
    processed++;

    try {
      const existing = await Group.findById(conv._id);
      if (existing) {
        skipped++;
        continue;
      }

      const participants = conv.participants as any[];
      if (!participants || participants.length < 2) {
        skipped++;
        continue;
      }

      const firstParticipant = participants[0];

      const group = new Group({
        _id: conv._id,
        name: `Group - ${participants.length} members`,
        icon: "https://res.cloudinary.com/dv4wxcduy/image/upload/v1234567890/default-group-icon.png",
        owner: firstParticipant._id,
        admins: [firstParticipant._id],
        participants: participants.map((p: any) => p._id),
        messages: (conv as any).messages || [],
        isGroupDM: true,
        isDisabled: false,
        createdAt: (conv as any).createdAt,
        updatedAt: (conv as any).updatedAt,
      });

      await group.save();
      created++;

      if (processed % BATCH_SIZE === 0) {
        console.log(`[001] Progress: ${processed}/${total} (created: ${created}, skipped: ${skipped}, failed: ${failed})`);
        await sleep(BATCH_DELAY_MS);
      }
    } catch (err) {
      failed++;
      console.error(`[001] Failed to migrate conversation ${conv._id}:`, err);
    }
  }

  console.log(`[001] Done.`);
  console.log(`[001]   Processed: ${processed}`);
  console.log(`[001]   Created:   ${created}`);
  console.log(`[001]   Skipped:   ${skipped}`);
  console.log(`[001]   Failed:    ${failed}`);

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error("[001] Migration failed:", err);
  process.exit(1);
});
