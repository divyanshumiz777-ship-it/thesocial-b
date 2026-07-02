/**
 * Server-side enforcement of `settings.privacy.profileVisibility`.
 *
 * Enforcing at the source (the profile-returning endpoints) means every
 * consumer — profile panel, profile page, search, mention cards, avatars —
 * inherits the rule without each having to re-check. Frontend-only checks
 * would be cosmetic since anyone could call the API directly.
 */

export type ProfileVisibility = "public" | "private" | "friends" | "followers";

export function getProfileVisibility(user: any): ProfileVisibility {
  const v = user?.settings?.privacy?.profileVisibility;
  return v === "private" || v === "friends" || v === "followers" ? v : "public";
}

/**
 * public    → everyone
 * friends   → the user themself + their friends
 * followers → the user themself + accepted followers (+ friends, since that's
 *             already a closer relationship) — Instagram-style private account.
 *             A pending follow request does NOT count as a follower.
 * private   → the user themself only ("Only Me" in the UI)
 */
export function canViewFullProfile(
  user: any,
  opts: { viewerId?: string | null; isFriend?: boolean; isFollower?: boolean }
): boolean {
  const targetId = user?._id?.toString?.() ?? String(user?._id ?? "");
  if (opts.viewerId && targetId && opts.viewerId === targetId) return true;

  const visibility = getProfileVisibility(user);
  if (visibility === "public") return true;
  if (visibility === "friends") return !!opts.isFriend;
  if (visibility === "followers") return !!opts.isFollower || !!opts.isFriend;
  return false; // private
}

/** Identity-only view for a restricted (hidden) profile. */
export function redactedProfileView(user: any) {
  return {
    _id: user._id,
    name: user.name,
    username: user.username ?? "",
    profilePic: "",
    verified: !!user.verified,
    visibility: getProfileVisibility(user),
    restricted: true,
  };
}

/** Curated full view — avoids leaking settings/friends/blockedUsers/password. */
export function fullProfileView(user: any) {
  return {
    _id: user._id,
    name: user.name,
    username: user.username ?? "",
    email: user.email,
    profilePic: user.profilePic ?? "",
    bannerUrl: user.bannerUrl ?? "",
    about: user.about ?? "",
    website: user.website ?? "",
    location: user.location ?? "",
    verified: !!user.verified,
    createdAt: user.createdAt,
    lastSeen: user.lastSeen,
    customStatus: user.customStatus,
    visibility: getProfileVisibility(user),
    restricted: false,
  };
}

/** Returns the full curated view when allowed, otherwise the redacted view. */
export function buildProfileView(
  user: any,
  opts: { viewerId?: string | null; isFriend?: boolean; isFollower?: boolean }
) {
  return canViewFullProfile(user, opts)
    ? fullProfileView(user)
    : redactedProfileView(user);
}
