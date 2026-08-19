/**
 * Migration 008: Sync PushSubscription indexes for the native FCM fields
 *
 * Why: PushSubscription.ts's unique index on `endpoint` gained a
 * `partialFilterExpression` (so a future FCM-token subscription, which has
 * no `endpoint` at all, doesn't collide with every other doc on
 * `endpoint: null`), plus a new sparse-equivalent unique index on
 * `fcmToken`. MongoDB treats a changed index specification as a different
 * index from the one already built in production — same class of drift as
 * migration 007's stripeCheckoutSessionId fix — so the old
 * `{user:1, endpoint:1}` index (no partial filter) must be dropped and
 * rebuilt, not left in place.
 *
 * Model.syncIndexes() diffs the schema's declared indexes against what's
 * actually in MongoDB and drops/rebuilds what changed — same tool used by
 * migrations 005 and 007.
 *
 * Run once: npx tsx src/models/migrations/008_sync_push_subscription_index.ts
 * Safe to re-run: syncIndexes() is idempotent.
 */

import "dotenv/config";
import mongoose from "mongoose";
import { PushSubscription } from "../PushSubscription.ts";

async function run(): Promise<void> {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("[008] MONGO_URI is not set");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log("[008] Connected to MongoDB");

  const dropped = await PushSubscription.syncIndexes();
  console.log("[008] syncIndexes result (indexes dropped):", dropped);

  const indexes = await PushSubscription.collection.indexes();
  console.log("[008] Current indexes:", JSON.stringify(indexes, null, 2));

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error("[008] Migration failed:", err);
  process.exit(1);
});
