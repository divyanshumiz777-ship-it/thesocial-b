/**
 * AI service client (gateway → internal Python microservices).
 *
 * SKELETON ONLY (Batch 2). This module is intentionally NOT imported by any
 * route or by server.ts, so it has zero effect on application behavior. It
 * provides the transport the gateway will use in a LATER batch to call the
 * Recommendation Service (and, later, the Chat Service):
 *   - per-request timeout (AbortController),
 *   - a simple per-target circuit breaker,
 *   - the shared `X-Internal-Token` secret,
 *   - forwarding of the JWT-verified user id as `X-User-Id`.
 *
 * No business logic lives here yet — only transport scaffolding. The feed
 * fallback wiring (and the only callers of this module) arrive in a later batch.
 */

import logger from "./logger.ts";

const REC_SERVICE_URL = process.env.REC_SERVICE_URL || "";
const CHAT_SERVICE_URL = process.env.CHAT_SERVICE_URL || "";
const INTERNAL_SERVICE_TOKEN = process.env.INTERNAL_SERVICE_TOKEN || "";
const REC_SERVICE_ENABLED =
  (process.env.REC_SERVICE_ENABLED || "false").toLowerCase() === "true";

/** Default per-request timeout (ms). Feed calls will use a tighter budget. */
const DEFAULT_TIMEOUT_MS = 2000;

/** Circuit breaker tuning. */
const FAILURE_THRESHOLD = 5; // consecutive failures before opening
const OPEN_DURATION_MS = 30_000; // stay open this long before a half-open retry

export interface InternalCallOptions {
  /** HTTP method. Defaults to "POST". */
  method?: "GET" | "POST";
  /** JSON-serializable request body (POST only). */
  body?: unknown;
  /** JWT-verified user id, forwarded to the service as `X-User-Id`. */
  userId?: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
}

export interface InternalCallResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  /** Set when the call failed, was misconfigured, or the breaker was open. */
  error?: string;
}

/** Per-target circuit breaker state, keyed by base URL. */
interface BreakerState {
  failures: number;
  openUntil: number; // epoch ms; 0 = closed
}

const breakers = new Map<string, BreakerState>();

function getBreaker(target: string): BreakerState {
  let state = breakers.get(target);
  if (!state) {
    state = { failures: 0, openUntil: 0 };
    breakers.set(target, state);
  }
  return state;
}

function recordSuccess(target: string): void {
  const state = getBreaker(target);
  state.failures = 0;
  state.openUntil = 0;
}

function recordFailure(target: string): void {
  const state = getBreaker(target);
  state.failures += 1;
  if (state.failures >= FAILURE_THRESHOLD) {
    state.openUntil = Date.now() + OPEN_DURATION_MS;
  }
}

/** True when the breaker for a target is currently open (skip the call). */
function isBreakerOpen(target: string): boolean {
  return getBreaker(target).openUntil > Date.now();
}

/**
 * Low-level transport: call an internal AI service with timeout, breaker, and
 * gateway identity headers. Never throws — returns a normalized result so a
 * caller can fall back cleanly (e.g. to the heuristic recommender). Callers
 * and fallback wiring are added in a later batch.
 */
export async function callInternalService<T = unknown>(
  baseUrl: string,
  path: string,
  options: InternalCallOptions = {}
): Promise<InternalCallResult<T>> {
  if (!baseUrl) {
    logger.warn({ path }, "callInternalService: CHAT_SERVICE_URL is not set — call skipped");
    return { ok: false, status: 0, data: null, error: "service url not configured" };
  }
  if (!INTERNAL_SERVICE_TOKEN) {
    logger.warn({ path }, "callInternalService: INTERNAL_SERVICE_TOKEN is not set — call skipped");
    return { ok: false, status: 0, data: null, error: "internal token not configured" };
  }
  if (isBreakerOpen(baseUrl)) {
    logger.warn({ baseUrl, path }, "callInternalService: circuit breaker OPEN — call skipped");
    return { ok: false, status: 0, data: null, error: "circuit open" };
  }

  const { method = "POST", body, userId, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Internal-Token": INTERNAL_SERVICE_TOKEN,
  };
  if (userId) headers["X-User-Id"] = userId;

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body:
        method === "POST" && body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    let data: T | null = null;
    try {
      data = (await response.json()) as T;
    } catch {
      data = null;
    }

    if (response.ok) {
      recordSuccess(baseUrl);
      logger.debug({ method, baseUrl, path, status: response.status }, "ai service call OK");
      return { ok: true, status: response.status, data };
    }

    recordFailure(baseUrl);
    logger.warn(
      { method, baseUrl, path, status: response.status, body: data },
      "ai service call returned non-2xx"
    );
    return {
      ok: false,
      status: response.status,
      data,
      error: `upstream status ${response.status}`,
    };
  } catch (error: unknown) {
    recordFailure(baseUrl);
    const message = error instanceof Error ? error.message : "unknown error";
    logger.warn({ baseUrl, path, error: message }, "ai service call failed");
    return { ok: false, status: 0, data: null, error: message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether the Recommendation Service should be consulted for feeds.
 * Returns false unless the flag is on AND the service URL + token are set, so
 * the system stays on the heuristic recommender by default.
 */
export function isRecommendationServiceEnabled(): boolean {
  return (
    REC_SERVICE_ENABLED &&
    Boolean(REC_SERVICE_URL) &&
    Boolean(INTERNAL_SERVICE_TOKEN)
  );
}

/**
 * Fetch a personalized feed (ordered reel IDs) from the Recommendation Service.
 *
 * Returns the reel IDs, or null on any non-success: disabled, timeout,
 * unavailable, empty/invalid response, open circuit, or exhausted retries.
 * Never throws — callers fall back to the heuristic recommender.
 *
 * Defaults: 250ms timeout, 1 retry. The circuit breaker lives in
 * callInternalService; when it is open this returns null immediately (no retry).
 */
export async function fetchRecommendedFeed(
  userId: string,
  options: {
    limit?: number;
    seen?: string[];
    timeoutMs?: number;
    retries?: number;
  } = {}
): Promise<string[] | null> {
  if (!isRecommendationServiceEnabled()) return null;

  const { limit = 20, seen = [], timeoutMs = 250, retries = 1 } = options;
  const body = { user_id: userId, limit, seen };

  let attempt = 0;
  while (attempt <= retries) {
    const result = await callInternalService<{ items?: unknown }>(
      REC_SERVICE_URL,
      "/internal/v1/feed",
      { method: "POST", body, userId, timeoutMs }
    );

    if (result.ok && result.data && Array.isArray(result.data.items)) {
      const items = result.data.items.filter(
        (item: unknown): item is string => typeof item === "string"
      );
      return items.length > 0 ? items : null;
    }

    // Do not retry while the breaker is open — it returns fast and unchanged.
    if (result.error === "circuit open") return null;
    attempt += 1;
  }
  return null;
}

/** Configured base URLs + flag, exposed for the wiring batch. */
export const aiServiceConfig = {
  recommendationUrl: REC_SERVICE_URL,
  chatUrl: CHAT_SERVICE_URL,
  enabled: REC_SERVICE_ENABLED,
} as const;
