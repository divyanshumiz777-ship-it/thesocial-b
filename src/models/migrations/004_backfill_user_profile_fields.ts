/**
 * Migration 004: Backfill User.username and User.createdAt
 *
 * Why: the Creator ecosystem build adds `username` (unique, sparse) and
 * `{timestamps:true}` to User.ts. Existing users have neither — mongoose
 * only auto-sets createdAt on brand-new document inserts, and username has
 * no default. This backfills both for every user that predates the change.
 *
 * username: slugified from `name`, deduplicated in-process against every
 * username already in use; collisions get a 6-hex-char suffix taken from
 * the user's own _id (deterministic, no randomness — safe to re-run).
 * createdAt/updatedAt: read from `_id.getTimestamp()` (ObjectId embeds the
 * real creation time) — exact, not a guess.
 *
 * Run once (reads MONGO_URI from backend/.env): npx tsx src/models/migrations/004_backfill_user_profile_fields.ts
 * Safe to re-run: only touches users missing username or createdAt.
 */

import "dotenv/config";
import mongoose from "mongoose";
import User from "../User.ts";

const BATCH_SIZE = 500;

const DIACRITICS_RE = new RegExp("[\\u0300-\\u036f]", "g");

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(DIACRITICS_RE, "")
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 20);
  return base || "user";
}

async function run(): Promise<void> {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("[004] MONGO_URI is not set");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log("[004] Connected to MongoDB");

  const existingUsernames = new Set(
    (await User.distinct("username", {
      username: { $nin: [null, ""] },
    })) as string[]
  );
  console.log(`[004] ${existingUsernames.size} usernames already assigned`);

  const cursor = User.find(
    {
      $or: [
        { username: { $exists: false } },
        { username: null },
        { username: "" },
        { createdAt: { $exists: false } },
      ],
    },
    "_id name username createdAt"
  )
    .lean()
    .cursor();

  let processed = 0;
  let ops: any[] = [];

  const flush = async () => {
    if (ops.length === 0) return;
    try {
      await User.bulkWrite(ops, { ordered: false });
    } catch (err) {
      console.error("[004] Batch write failed:", err);
    }
    ops = [];
  };

  for await (const raw of cursor) {
    const doc = raw as any;
    const set: Record<string, unknown> = {};

    if (!doc.username) {
      const base = slugify(doc.name || "user");
      let candidate = base;
      if (existingUsernames.has(candidate)) {
        candidate = `${base}_${String(doc._id).slice(-6)}`;
      }
      existingUsernames.add(candidate);
      set.username = candidate;
    }

    if (!doc.createdAt) {
      const ts = (doc._id as mongoose.Types.ObjectId).getTimestamp();
      set.createdAt = ts;
      set.updatedAt = ts;
    }

    if (Object.keys(set).length > 0) {
      ops.push({
        updateOne: { filter: { _id: doc._id }, update: { $set: set } },
      });
    }

    processed++;
    if (ops.length >= BATCH_SIZE) await flush();
    if (processed % 2000 === 0) console.log(`[004] Processed ${processed}`);
  }

  await flush();

  console.log(`[004] Done. Processed ${processed} users.`);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error("[004] Migration failed:", err);
  process.exit(1);
});
