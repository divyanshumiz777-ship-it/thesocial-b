import ServerMember from "../models/ServerMember.ts";
import DiscordServer from "../models/DiscordServer.ts";

/**
 * A server's "Allow members to X each other" privacy toggle only makes sense
 * relative to servers the two users actually share — two strangers who don't
 * share a server are never affected by it. When they DO share one or more
 * servers, the toggle is permissive-by-default: it only blocks the action if
 * EVERY shared server has it turned off, so being in one open community
 * together is enough to allow it even if another shared community restricts it.
 */
async function blockedByEverySharedServer(
  userAId: string,
  userBId: string,
  flag: "allowMemberDMs" | "allowFriendRequests"
): Promise<boolean> {
  const [aServerIds, bServerIds] = await Promise.all([
    ServerMember.find({ user: userAId }).distinct("server"),
    ServerMember.find({ user: userBId }).distinct("server"),
  ]);
  const bSet = new Set(bServerIds.map((id) => id.toString()));
  const sharedIds = aServerIds
    .map((id) => id.toString())
    .filter((id) => bSet.has(id));
  if (sharedIds.length === 0) return false;

  const servers = await DiscordServer.find({ _id: { $in: sharedIds } })
    .select("privacy")
    .lean();
  return servers.every((s: any) => s.privacy?.[flag] === false);
}

export const isMemberDmBlocked = (userAId: string, userBId: string) =>
  blockedByEverySharedServer(userAId, userBId, "allowMemberDMs");

export const isFriendRequestBlocked = (userAId: string, userBId: string) =>
  blockedByEverySharedServer(userAId, userBId, "allowFriendRequests");
