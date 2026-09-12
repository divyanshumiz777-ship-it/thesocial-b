/**
 * Migration 009: Sync Message.ts's clientMessageId idempotency indexes
 *
 * Why: Message.ts declares three unique indexes for send-idempotency
 * ({conversationId,sender,clientMessageId}, {groupId,...}, {channel,...}),
 * each with a partialFilterExpression (not `sparse: true` — see that
 * schema's own comment for why sparse alone doesn't work here, since
 * `sender` is a required field). MongoDB treats a changed/new index
 * specification as a different index from whatever's already built in
 * production — same class of drift as migrations 007 and 008 — so a plain
 * app restart with autoIndex is not guaranteed to have created these yet on
 * every environment this code has run against. Every idempotency comment in
 * dmController.ts/messageController.ts/groupDmController.ts explicitly
 * relies on this DB-level unique constraint as the real safety net for a
 * genuine concurrent-retry race (the controller-side pre-check alone can't
 * close that race); without the index actually existing, two truly
 * concurrent identical retries would both pass the pre-check and both
 * insert successfully — a silent duplicate message, with no error and
 * nothing logged.
 *
 * Model.syncIndexes() diffs the schema's declared indexes against what's
 * actually in MongoDB and drops/rebuilds what changed — same tool used by
 * migrations 005, 007, and 008.
 *
 * Run once: npx tsx src/models/migrations/009_sync_message_clientid_indexes.ts
 * Safe to re-run: syncIndexes() is idempotent.
 */

import "dotenv/config";
import mongoose from "mongoose";
import Message from "../Message.ts";

async function run(): Promise<void> {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("[009] MONGO_URI is not set");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log("[009] Connected to MongoDB");

  const dropped = await Message.syncIndexes();
  console.log("[009] syncIndexes result (indexes dropped):", dropped);

  const indexes = await Message.collection.indexes();
  console.log("[009] Current indexes:", JSON.stringify(indexes, null, 2));

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error("[009] Migration failed:", err);
  process.exit(1);
});
