import DiscordServer from "../models/DiscordServer.ts";

export const checkPermission = async (
  serverId: string,
  userId: string,
  requiredRole: string
): Promise<boolean> => {
  const server = await DiscordServer.findOne({
    _id: serverId,
    $or: [
      { owner: userId },
      {
        members: {
          $elemMatch: { user: userId, roles: { $in: [requiredRole, "owner"] } },
        },
      },
    ],
  }).lean();

  return !!server;
};
