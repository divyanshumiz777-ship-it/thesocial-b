/**
 * Migration 007: Drop the stale stripeCheckoutSessionId unique index on tips
 *
 * Why: Tip.ts was migrated from Stripe Checkout to Razorpay Orders (see
 * razorpayClient.ts's header comment) and no longer declares a
 * stripeCheckoutSessionId field at all. The old unique index on that field
 * was never dropped, so every new Tip document — which naturally omits the
 * field — gets treated as { stripeCheckoutSessionId: null } by the
 * non-sparse unique index. The first tip ever created after the migration
 * claimed that null slot; every tip attempt since has failed with
 * E11000 duplicate key error on stripeCheckoutSessionId_1, breaking tipping
 * entirely in production.
 *
 * Model.syncIndexes() diffs the schema's declared indexes against what's
 * actually in MongoDB and drops what's no longer declared — same tool used
 * by migration 005 for the equivalent User text-index problem.
 *
 * Run once: npx tsx src/models/migrations/007_drop_stale_tip_index.ts
 * Safe to re-run: syncIndexes() is idempotent.
 */

import "dotenv/config";
import mongoose from "mongoose";
import { Tip } from "../Tip.ts";

async function run(): Promise<void> {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("[007] MONGO_URI is not set");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log("[007] Connected to MongoDB");

  const dropped = await Tip.syncIndexes();
  console.log("[007] syncIndexes result (indexes dropped):", dropped);

  const indexes = await Tip.collection.indexes();
  console.log("[007] Current indexes:", JSON.stringify(indexes, null, 2));

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error("[007] Migration failed:", err);
  process.exit(1);
});
