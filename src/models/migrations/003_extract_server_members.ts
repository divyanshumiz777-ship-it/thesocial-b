/**
 * Migration 003: Extract DiscordServer.members[] to ServerMember collection
 *
 * Why: DiscordServer.members[] is an embedded subdocument array that grows
 * unboundedly. Servers with large member counts approach the 16MB BSON document
 * limit. Every permission check requires loading the full server document.
 *
 * Prerequisites:
 *   - Phase A dual-write MUST be deployed and verified before running this script.
 *     New members added after deploy are already in ServerMember via dual-write.
 *     This script backfills members who existed before dual-write was deployed.
 *
 * Run once: MONGO_URI=... npx tsx src/models/migrations/003_extract_server_members.ts
 * Safe to re-run: $setOnInsert means already-migrated members are skipped (matched, not modified).
 *
 * DO NOT remove DiscordServer.members[] until Phase B reads from ServerMember and
 * Phase C removes the array. This script is Phase A backfill only.
 */

import mongoose from "mongoose";
import DiscordServer from "../DiscordServer.ts";
import ServerMember from "../ServerMember.ts";

const BATCH_SIZE = 1000;
const BATCH_DELAY_MS = 50;

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function run(): Promise<void> {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("[003] MONGO_URI is not set");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log("[003] Connected to MongoDB");

  const totalServers = await DiscordServer.countDocuments();
  console.log(`[003] Found ${totalServers} servers to process`);

  let serversProcessed = 0;
  let membersUpserted = 0;
  let membersSkipped = 0;
  let failedBatches = 0;

  const cursor = DiscordServer.find({}).select("_id members").lean().cursor();

  for await (const server of cursor) {
    serversProcessed++;
    const members: any[] = (server as any).members ?? [];
    if (members.length === 0) continue;

    for (let i = 0; i < members.length; i += BATCH_SIZE) {
      const batch = members.slice(i, i + BATCH_SIZE);

      const ops = batch.map((member: any) => ({
        updateOne: {
          filter: { server: server._id, user: member.user },
          update: {
            $setOnInsert: {
              server: server._id,
              user: member.user,
              roles: member.roles ?? ["member"],
              ...(member.banned?.isBanned ? { banned: member.banned } : {}),
              ...(member.muted?.isMuted ? { muted: member.muted } : {}),
            },
          },
          upsert: true,
        },
      }));

      try {
        const result = await ServerMember.bulkWrite(ops, { ordered: false });
        membersUpserted += result.upsertedCount;
        membersSkipped += result.matchedCount;
      } catch (err) {
        failedBatches++;
        console.error(
          `[003] Batch failed for server ${server._id} (batch offset ${i}):`,
          err
        );
      }

      if (i + BATCH_SIZE < members.length) {
        await sleep(BATCH_DELAY_MS);
      }
    }

    if (serversProcessed % 100 === 0 || serversProcessed === totalServers) {
      console.log(
        `[003] Progress: ${serversProcessed}/${totalServers} servers | ` +
          `inserted: ${membersUpserted}, skipped: ${membersSkipped}, failed batches: ${failedBatches}`
      );
    }
  }

  const totalInCollection = await ServerMember.countDocuments();

  console.log(`[003] Done.`);
  console.log(`[003]   Servers processed:    ${serversProcessed}`);
  console.log(`[003]   Members inserted:     ${membersUpserted}`);
  console.log(`[003]   Members already done: ${membersSkipped}`);
  console.log(`[003]   Failed batches:       ${failedBatches}`);
  console.log(`[003]   Total in collection:  ${totalInCollection}`);

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error("[003] Migration failed:", err);
  process.exit(1);
});
