/**
 * Reel event stream publisher (gateway → Redis Stream).
 *
 * SKELETON ONLY (Batch 3). NOT imported by any controller, so it has zero
 * runtime effect today. In a later batch it will be called (gated) from
 * trackReelEvent to dual-write raw reel engagement events to a Redis Stream
 * that the Recommendation Service consumes. Publishing is:
 *   - OFF by default (REC_EVENT_STREAM_ENABLED !== "true"),
 *   - fire-and-forget and never throws — it can never affect the request path.
 *
 * When disabled, publishReelEvent is a no-op, so behavior is identical to today.
 */

import redis from "./redis.ts";
import logger from "./logger.ts";

const STREAM_ENABLED =
  (process.env.REC_EVENT_STREAM_ENABLED || "false").toLowerCase() === "true";
const STREAM_KEY = process.env.REEL_EVENTS_STREAM_KEY || "reel:events";
const STREAM_MAXLEN = Number(process.env.REEL_EVENTS_STREAM_MAXLEN || 1_000_000);

export interface ReelEventPayload {
  user_id: string;
  reel_id: string;
  event_type: string;
  watch_time?: number;
  completion_rate?: number | null;
  session_id?: string;
  source?: string;
  /** Event timestamp (epoch ms). */
  ts: number;
}

/** True when stream dual-write is enabled by configuration. */
export function isReelEventStreamEnabled(): boolean {
  return STREAM_ENABLED;
}

/**
 * completion_rate = clamp(watch_time / duration, 0, 1).
 *
 * Returns null when it cannot be computed (watch_time missing / non-finite /
 * negative, or duration missing / non-positive / non-finite). Pure; never throws.
 */
export function computeCompletionRate(
  watchTime: unknown,
  duration: unknown
): number | null {
  if (
    typeof watchTime !== "number" ||
    !Number.isFinite(watchTime) ||
    watchTime < 0
  ) {
    return null;
  }
  if (
    typeof duration !== "number" ||
    !Number.isFinite(duration) ||
    duration <= 0
  ) {
    return null;
  }
  return Math.min(1, Math.max(0, watchTime / duration));
}

/**
 * Publish a reel event to the Redis Stream. No-op when disabled. Fire-and-forget:
 * resolves to true on success, false on any failure or when disabled — and never
 * throws, so callers can safely choose not to await it.
 */
export async function publishReelEvent(
  event: ReelEventPayload
): Promise<boolean> {
  if (!STREAM_ENABLED) return false;
  try {
    // Use the generic command interface to avoid xadd overload ambiguity and
    // to express approximate MAXLEN trimming cleanly.
    await redis.call(
      "XADD",
      STREAM_KEY,
      "MAXLEN",
      "~",
      STREAM_MAXLEN,
      "*",
      "data",
      JSON.stringify(event)
    );
    return true;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "unknown error";
    logger.warn(
      { streamKey: STREAM_KEY, error: message },
      "reel event publish failed"
    );
    return false;
  }
}
