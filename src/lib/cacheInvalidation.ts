import { cache } from "./redis.ts";

export class CacheInvalidator {
  static async invalidateServer(serverId: string) {
    const patterns = [
      `cache:*:/api/v1/server/get-server/${serverId}*`,
      `cache:*:/api/v1/server/${serverId}/*`,
      `cache:*:/api/v1/user/user-servers*`,
    ];

    let totalDeleted = 0;
    for (const pattern of patterns) {
      const deleted = await cache.delPattern(pattern);
      totalDeleted += deleted;
    }

    console.log(
      `🗑️  Invalidated ${totalDeleted} server cache keys for server: ${serverId}`
    );
    return totalDeleted;
  }

  static async invalidateChannel(channelId: string, serverId?: string) {
    const patterns = [
      `cache:*:/api/v1/channel/${channelId}/*`,
      `cache:*:/api/v1/channel/get-channel/${channelId}*`,
    ];

    if (serverId) {
      patterns.push(`cache:*:/api/v1/server/get-server/${serverId}*`);
    }

    let totalDeleted = 0;
    for (const pattern of patterns) {
      const deleted = await cache.delPattern(pattern);
      totalDeleted += deleted;
    }

    console.log(
      `🗑️  Invalidated ${totalDeleted} channel cache keys for channel: ${channelId}`
    );
    return totalDeleted;
  }

  static async invalidateMessages(channelId: string) {
    const patterns = [
      `cache:*:/api/v1/channel/${channelId}/messages*`,
      `cache:*:/api/v1/channel/messages/${channelId}*`,
    ];

    let totalDeleted = 0;
    for (const pattern of patterns) {
      const deleted = await cache.delPattern(pattern);
      totalDeleted += deleted;
    }

    console.log(
      `🗑️  Invalidated ${totalDeleted} message cache keys for channel: ${channelId}`
    );
    return totalDeleted;
  }

  static async invalidateConversation(conversationId: string, userId?: string) {
    const patterns = [
      `cache:*:/api/v1/dm/get-dm/${conversationId}*`,
      `cache:*:/api/v1/user/conversations*`,
    ];

    if (userId) {
      patterns.push(`cache:${userId}:*`);
    }

    let totalDeleted = 0;
    for (const pattern of patterns) {
      const deleted = await cache.delPattern(pattern);
      totalDeleted += deleted;
    }

    console.log(`🗑️  Invalidated ${totalDeleted} conversation cache keys`);
    return totalDeleted;
  }

  static async invalidateUser(userId: string) {
    const patterns = [
      `cache:${userId}:*`,
      `cache:*:/api/v1/user/user-detail/${userId}*`,
      `cache:*:/api/v1/user/settings*`,
    ];

    let totalDeleted = 0;
    for (const pattern of patterns) {
      const deleted = await cache.delPattern(pattern);
      totalDeleted += deleted;
    }

    console.log(
      `🗑️  Invalidated ${totalDeleted} user cache keys for user: ${userId}`
    );
    return totalDeleted;
  }

  static async invalidateGroup(groupId: string) {
    const patterns = [
      `cache:*:/api/v1/dm/groups/${groupId}*`,
      `cache:*:/api/v1/dm/groups/my-groups*`,
    ];

    let totalDeleted = 0;
    for (const pattern of patterns) {
      const deleted = await cache.delPattern(pattern);
      totalDeleted += deleted;
    }

    console.log(
      `🗑️  Invalidated ${totalDeleted} group cache keys for group: ${groupId}`
    );
    return totalDeleted;
  }

  static async invalidateAll() {
    const deleted = await cache.delPattern("cache:*");
    console.log(`🗑️  Invalidated ALL ${deleted} cache keys`);
    return deleted;
  }

  static async invalidateKey(key: string) {
    const deleted = await cache.del(key);
    console.log(`🗑️  Invalidated cache key: ${key}`);
    return deleted;
  }
}

export async function invalidateAfterMessage(
  channelId: string,
  serverId?: string
) {
  await CacheInvalidator.invalidateMessages(channelId);
  if (serverId) {
    await CacheInvalidator.invalidateChannel(channelId, serverId);
  }
}

export async function invalidateAfterDM(
  conversationId: string,
  userId: string
) {
  await CacheInvalidator.invalidateConversation(conversationId, userId);
}

export async function invalidateAfterServerUpdate(serverId: string) {
  await CacheInvalidator.invalidateServer(serverId);
}

export async function invalidateAfterUserUpdate(userId: string) {
  await CacheInvalidator.invalidateUser(userId);
}

export default CacheInvalidator;
