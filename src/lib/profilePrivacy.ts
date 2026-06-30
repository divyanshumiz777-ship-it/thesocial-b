/**
 * Server-side enforcement of `settings.privacy.profileVisibility`.
 *
 * Enforcing at the source (the profile-returning endpoints) means every
 * consumer — profile panel, profile page, search, mention cards, avatars —
 * inherits the rule without each having to re-check. Frontend-only checks
 * would be cosmetic since anyone could call the API directly.
 */

export type ProfileVisibility = "public" | "private" | "friends";

export function getProfileVisibility(user: any): ProfileVisibility {
  const v = user?.settings?.privacy?.profileVisibility;
  return v === "private" || v === "friends" ? v : "public";
}

/**
 * public  → everyone
 * friends → the user themself + their friends
 * private → the user themself only
 */
export function canViewFullProfile(
  user: any,
  opts: { viewerId?: string | null; isFriend?: boolean }
): boolean {
  const targetId = user?._id?.toString?.() ?? String(user?._id ?? "");
  if (opts.viewerId && targetId && opts.viewerId === targetId) return true;

  const visibility = getProfileVisibility(user);
  if (visibility === "public") return true;
  if (visibility === "friends") return !!opts.isFriend;
  return false; // private
}

/** Identity-only view for a restricted (hidden) profile. */
export function redactedProfileView(user: any) {
  return {
    _id: user._id,
    name: user.name,
    profilePic: "",
    visibility: getProfileVisibility(user),
    restricted: true,
  };
}

/** Curated full view — avoids leaking settings/friends/blockedUsers/password. */
export function fullProfileView(user: any) {
  return {
    _id: user._id,
    name: user.name,
    email: user.email,
    profilePic: user.profilePic ?? "",
    about: user.about ?? "",
    lastSeen: user.lastSeen,
    customStatus: user.customStatus,
    visibility: getProfileVisibility(user),
    restricted: false,
  };
}

/** Returns the full curated view when allowed, otherwise the redacted view. */
export function buildProfileView(
  user: any,
  opts: { viewerId?: string | null; isFriend?: boolean }
) {
  return canViewFullProfile(user, opts)
    ? fullProfileView(user)
    : redactedProfileView(user);
}
