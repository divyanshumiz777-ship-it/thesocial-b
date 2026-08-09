/**
 * Chat-theme id allowlist, shared by the generic chat-theme controller and
 * the legacy DM theme endpoints.
 *
 * Deliberately accepts the UNION of current preset ids and the legacy ids
 * that predate chat themes becoming accent recipes (see
 * frontend/lib/chatThemes.ts). Two reasons: existing users still have the
 * old ids persisted in `settings.conversationThemes`, and during a rollout
 * a client still running the previous bundle can re-submit one — rejecting
 * it with a 400 would break theme-setting for those users mid-deploy for no
 * benefit. The frontend maps legacy ids to their nearest current accent at
 * render time, so accepting them here costs nothing.
 */

/** Current, pickable presets — mirrors CHAT_THEME_PRESET_IDS on the frontend. */
export const CHAT_THEME_PRESET_IDS = [
  "slate",
  "azure",
  "indigo",
  "violet",
  "rose",
  "amber",
  "moss",
] as const;

/** Pre-redesign ids, still persisted in existing user documents. */
export const LEGACY_CHAT_THEME_IDS = [
  "discord",
  "whatsapp",
  "telegram",
  "instagram",
  "midnight",
  "ocean",
  "forest",
  "purple",
] as const;

const ACCEPTED_THEME_IDS = new Set<string>([
  ...CHAT_THEME_PRESET_IDS,
  ...LEGACY_CHAT_THEME_IDS,
]);

export const CUSTOM_CHAT_THEME_PATTERN = /^custom:#[0-9a-fA-F]{6}$/;

export function isValidChatTheme(theme: string): boolean {
  return ACCEPTED_THEME_IDS.has(theme) || CUSTOM_CHAT_THEME_PATTERN.test(theme);
}
