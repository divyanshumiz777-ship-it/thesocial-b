/**
 * Shared allowed-origin resolution for CORS.
 *
 * Before this fix, the REST layer (app.ts's `hono/cors` middleware) and the
 * Socket.IO layer (server.ts) each had their OWN copy of this logic, and
 * only the REST copy had ever been fixed for the "credentials:true requires
 * an explicit origin, not '*'" rule. The Socket.IO layer kept passing
 * `process.env.FRONTEND_URL` straight through as a single literal string:
 * unsplit if it ever became a comma-separated multi-origin list (breaking
 * WebSocket CORS the moment a second origin was added, even though REST
 * would keep working), and falling back to `"*"` if unset (an invalid
 * combination with `credentials:true` per the CORS spec).
 *
 * `getAllowedOrigins()` is now the single source of truth for both layers.
 */

const DEFAULT_ORIGIN = "http://localhost:3000";

/** Parses FRONTEND_URL into a clean list of allowed origins. Always returns
 * at least one entry. */
export function getAllowedOrigins(): string[] {
  const raw = process.env.FRONTEND_URL || DEFAULT_ORIGIN;
  const origins = raw
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  return origins.length > 0 ? origins : [DEFAULT_ORIGIN];
}

/** Hono `cors()`-compatible origin matcher: echoes the request's Origin
 * header if it's on the allow-list, else falls back to the first configured
 * origin (same behavior the REST layer already had). */
export function matchOrigin(
  origin: string | undefined,
  allowed: string[] = getAllowedOrigins(),
): string {
  if (!origin) return allowed[0];
  return allowed.includes(origin) ? origin : allowed[0];
}
