import { getIoInstance } from "../config/socket.ts";

/**
 * Authoritatively broadcasts a user's profile change to every connected
 * client. This is the single source of truth for profile-picture/name/about
 * propagation — it runs server-side on the write path (updateProfile/editUser)
 * so it fires regardless of whether the editor's own socket happens to be
 * connected at save time, which the previous client-relayed emit could not
 * guarantee.
 *
 * `user:profile-changed` is a global `io.emit` (every socket): a user's name
 * and avatar are already visible to anyone who can see them anywhere in the
 * app, so a global fan-out exposes nothing beyond what's already on screen,
 * and it means a viewer picks up the change no matter which surface currently
 * shows the avatar (DM sidebar, chat, reels, comments, member lists, …)
 * without needing to be in any particular room.
 *
 * `creator:profileUpdated` additionally carries the resolved fields to the
 * creator's room for the profile/reels surfaces that scope to it. Unlike the
 * old version this includes the actual profilePic URL, not just a boolean.
 */
export function broadcastProfileChange(user: {
  _id: unknown;
  name?: string;
  profilePic?: string;
  about?: string;
}) {
  let io;
  try {
    io = getIoInstance();
  } catch {
    return; // socket not initialised (tests / cold start) — nothing to do
  }
  if (!io) return;

  const userId = String(user._id);
  const profilePic = user.profilePic ?? "";

  io.emit("user:profile-changed", {
    userId,
    name: user.name,
    profilePic,
    about: user.about,
    timestamp: Date.now(),
  });

  io.to(`creator:${userId}`).emit("creator:profileUpdated", {
    creatorId: userId,
    changedFields: {
      name: user.name,
      about: user.about,
      profilePic,
    },
  });
}
