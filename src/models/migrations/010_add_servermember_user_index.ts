/**
 * Migration 010: Add a standalone `{ user: 1 }` index to ServerMember
 *
 * Why: the only non-_id index on this collection was `{ server: 1, user: 1 }`.
 * A compound index can only serve queries that use a PREFIX of its keys, so a
 * query filtered on `user` alone cannot use it — confirmed against the live
 * database with an explain, which reported `stage: "COLLSCAN"` for
 * `servermembers.distinct("server", { user })`.
 *
 * That exact query shape is not incidental: serverPrivacy.ts's
 * `blockedByEverySharedServer` issues TWO of them (one per participant), and it
 * sits on the critical path of every single 1:1 DM send — it is the
 * "are DMs disabled between members of a community you share" check. A full
 * collection scan there is cheap while the collection is small and becomes a
 * per-message tax that grows with total memberships across the whole platform.
 *
 * Verified before writing this: the live collection currently holds exactly two
 * indexes, `{_id:1}` and `{server:1,user:1}` (unique), both of which are still
 * declared on the schema — so syncIndexes() here only CREATES the new index and
 * drops nothing. The before/after index dumps below make that auditable.
 *
 * Model.syncIndexes() diffs the schema's declared indexes against what's
 * actually in MongoDB — same tool used by migrations 005, 007 and 008.
 *
 * Run once: npx tsx src/models/migrations/010_add_servermember_user_index.ts
 * Safe to re-run: syncIndexes() is idempotent.
 */

import "dotenv/config";
import mongoose from "mongoose";
import ServerMember from "../ServerMember.ts";

async function run(): Promise<void> {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("[010] MONGO_URI is not set");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log("[010] Connected to MongoDB");

  const before = await ServerMember.collection.indexes();
  console.log("[010] Indexes BEFORE:", JSON.stringify(before.map((i) => i.key)));

  const dropped = await ServerMember.syncIndexes();
  console.log("[010] syncIndexes result (indexes dropped):", dropped);

  const after = await ServerMember.collection.indexes();
  console.log("[010] Indexes AFTER:", JSON.stringify(after.map((i) => i.key)));

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error("[010] Migration failed:", err);
  process.exit(1);
});
