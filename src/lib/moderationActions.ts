import type { Server } from "socket.io";
import DiscordServer from "../models/DiscordServer.ts";
import ServerMember from "../models/ServerMember.ts";
import User from "../models/User.ts";
import { invalidateAfterServerUpdate } from "./cacheInvalidation.ts";
import { fireWebhooksForEvent } from "./webhookEvents.ts";

// Extracted from serverController.ts's banMember/muteMember so the same DB
// mutation can be driven from two different authority checks: a server
// moderator's role-based `checkPermission` (the existing per-server routes)
// and the platform admin's report-resolution bridge (adminController.ts's
// resolveReport), which has platform-wide authority and isn't necessarily a
// member/moderator of the server it's acting in at all.

export async function applyBan(
  serverId: string,
  userId: string,
  reason: string,
  actorId: string,
  io: Server,
): Promise<void> {
  await DiscordServer.findOneAndUpdate(
    { _id: serverId, "members.user": userId },
    { $set: { "members.$.banned": { isBanned: true, reason, bannedBy: actorId } } },
  );
  await ServerMember.updateOne(
    { server: serverId, user: userId },
    { $set: { banned: { isBanned: true, reason, bannedBy: actorId } } },
  );
  await User.findOneAndUpdate({ _id: userId }, { $pull: { servers: serverId } });
  io.to(serverId.toString()).emit("memberBanned", { userToBanId: userId, serverId });
  void fireWebhooksForEvent(serverId.toString(), "member_banned", { userId, reason }, io);
  await invalidateAfterServerUpdate(serverId);
}

export async function applyMute(
  serverId: string,
  userId: string,
  reason: string,
  durationMs: number,
  actorId: string,
  io: Server,
): Promise<Date> {
  const expiresAt = new Date(Date.now() + durationMs);
  await DiscordServer.findOneAndUpdate(
    { _id: serverId, "members.user": userId },
    {
      $set: {
        "members.$.muted": { isMuted: true, reason, mutedBy: actorId, expiresAt },
      },
    },
  );
  await ServerMember.updateOne(
    { server: serverId, user: userId },
    { $set: { muted: { isMuted: true, reason, mutedBy: actorId, expiresAt } } },
  );
  await invalidateAfterServerUpdate(serverId);
  io.to(serverId.toString()).emit("memberMuted", { userToMuteId: userId, serverId, expiresAt });
  void fireWebhooksForEvent(serverId.toString(), "member_muted", { userId, reason, expiresAt }, io);
  return expiresAt;
}
