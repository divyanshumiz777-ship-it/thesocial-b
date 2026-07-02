/**
 * Migration 005: Rebuild the User text index to include username + about
 *
 * Why: User.ts's text index changed from {name, email} to a weighted
 * {name, username, email, about} index (creator search — Batch 9). MongoDB
 * allows only ONE text index per collection, and mongoose's normal
 * connection-time index sync does not drop a conflicting index automatically
 * — it would just fail in the background, leaving the old index in place and
 * username/about silently unsearchable.
 *
 * Model.syncIndexes() diffs the schema's declared indexes against what's
 * actually in MongoDB and drops/creates as needed — the correct tool for an
 * index *shape* change (as opposed to the data backfills the other
 * migrations in this folder handle).
 *
 * Run once: npx tsx src/models/migrations/005_sync_user_text_index.ts
 * Safe to re-run: syncIndexes() is idempotent.
 */

import "dotenv/config";
import mongoose from "mongoose";
import User from "../User.ts";

async function run(): Promise<void> {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("[005] MONGO_URI is not set");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log("[005] Connected to MongoDB");

  const dropped = await User.syncIndexes();
  console.log("[005] syncIndexes result (indexes dropped):", dropped);

  const indexes = await User.collection.indexes();
  console.log("[005] Current indexes:", JSON.stringify(indexes, null, 2));

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error("[005] Migration failed:", err);
  process.exit(1);
});
