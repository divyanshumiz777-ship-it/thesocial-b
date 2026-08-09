/**
 * Storage keys for per-viewer chat themes inside
 * `User.settings.conversationThemes`.
 *
 * DM keeps its RAW conversationId key, exactly as before chat themes were
 * generalized beyond 1:1 DMs — that's what makes this a zero-migration
 * change: every theme an existing user has already chosen keeps resolving
 * from the same key it was written under. The newer scopes get a namespace
 * prefix. A raw 24-hex ObjectId can never collide with a prefixed key, so
 * one map safely holds all three scopes.
 */

export const CHAT_THEME_SCOPES = ["dm", "group", "community"] as const;
export type ChatThemeScope = (typeof CHAT_THEME_SCOPES)[number];

export function isChatThemeScope(value: string): value is ChatThemeScope {
  return (CHAT_THEME_SCOPES as readonly string[]).includes(value);
}

export function chatThemeKey(scope: ChatThemeScope, targetId: string): string {
  if (scope === "dm") return targetId;
  if (scope === "group") return `group:${targetId}`;
  return `server:${targetId}`;
}
