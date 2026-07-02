import { cache } from "./redis.ts";

export class CacheInvalidator {
  static async invalidateServer(serverId: string) {
    const patterns = [
      `cache:*:/api/v1/server/get-server/${serverId}*`,
      `cache:*:/api/v1/user/user-servers*`,
    ];
    return sumDeleted(patterns);
  }

  static async invalidateChannel(channelId: string, serverId?: string) {
    const patterns = [`cache:*:/api/v1/channel/${channelId}*`];
    if (serverId) {
      patterns.push(`cache:*:/api/v1/server/get-server/${serverId}*`);
    }
    return sumDeleted(patterns);
  }

  /** FIX: corrected path to match /api/v1/message/get-messages/:channelId */
  static async invalidateMessages(channelId: string) {
    const patterns = [`cache:*:/api/v1/message/get-messages/${channelId}*`];
    return sumDeleted(patterns);
  }

  static async invalidateConversation(conversationId: string, userId?: string) {
    const patterns = [
      `cache:*:/api/v1/dm/get-dm/${conversationId}*`,
      `cache:*:/api/v1/user/conversations*`,
    ];
    if (userId) {
      patterns.push(`cache:${userId}:*`);
    }
    return sumDeleted(patterns);
  }

  static async invalidateUser(userId: string) {
    const patterns = [
      `cache:${userId}:*`,
      `cache:*:/api/v1/user/user-detail/${userId}*`,
      `cache:*:/api/v1/user/settings*`,
    ];
    return sumDeleted(patterns);
  }

  static async invalidateGroup(groupId: string) {
    const patterns = [
      `cache:*:/api/v1/dm/groups/${groupId}*`,
      `cache:*:/api/v1/dm/groups/my-groups*`,
    ];
    return sumDeleted(patterns);
  }

  /**
   * Follow-graph mutation (follow/unfollow/accept/reject, and block/unblock,
   * which changes what the pair may see of each other). Evicts, for BOTH
   * parties: their follow namespace (status/followers/following/mutual/
   * suggested/mute, under any viewer's key) and their profile view
   * (user-detail carries follower/following counts + privacy-gated fields).
   */
  static async invalidateFollowGraph(userA: string, userB: string) {
    const patterns = [
      `cache:*:/api/v1/follow/${userA}*`,
      `cache:*:/api/v1/follow/${userB}*`,
      `cache:${userA}:/api/v1/follow/*`,
      `cache:${userB}:/api/v1/follow/*`,
      `cache:*:/api/v1/user/user-detail/${userA}*`,
      `cache:*:/api/v1/user/user-detail/${userB}*`,
    ];
    return sumDeleted(patterns);
  }

  static async invalidateAll() {
    return cache.delPattern("cache:*");
  }

  static async invalidateKey(key: string) {
    return cache.del(key);
  }
}

async function sumDeleted(patterns: string[]): Promise<number> {
  let total = 0;
  for (const p of patterns) {
    total += await cache.delPattern(p);
  }
  return total;
}

// ── Convenience helpers (called from controllers after mutations) ─────────────

export async function invalidateAfterMessage(
  channelId: string,
  serverId?: string,
) {
  await CacheInvalidator.invalidateMessages(channelId);
  if (serverId) await CacheInvalidator.invalidateChannel(channelId, serverId);
}

export async function invalidateAfterDM(
  conversationId: string,
  userId: string,
) {
  await CacheInvalidator.invalidateConversation(conversationId, userId);
}

export async function invalidateAfterServerUpdate(serverId: string) {
  await CacheInvalidator.invalidateServer(serverId);
}

export async function invalidateAfterUserUpdate(userId: string) {
  await CacheInvalidator.invalidateUser(userId);
}

export async function invalidateAfterFollowChange(
  userA: string,
  userB: string,
) {
  await CacheInvalidator.invalidateFollowGraph(userA, userB);
}

export default CacheInvalidator;
