import type { Server } from "socket.io";
import mongoose from "mongoose";
import redis from "./redis.ts";

/**
 * Redis-backed request/latency metrics + dependency health checks for the
 * admin dashboard's System tab. Replaces middleware/metrics.ts (an
 * in-process, per-instance-only counter that reset on every restart and was
 * wrong across replicas) with counters that survive restarts and are
 * correct cluster-wide, the same tier of fix dmCallService.ts already made
 * for DM call state.
 *
 * Every write here is fire-and-forget with a bounded timeout, mirroring
 * rateLimit.ts's own "fail open, never let a Redis hiccup block or slow a
 * real request" discipline.
 */

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// ── Request metrics ──────────────────────────────────────────────────────

const METRIC_IO_TIMEOUT_MS = 150;
const METRIC_KEY_TTL_SECONDS = 24 * 60 * 60; // 24h — plenty for a 60-minute dashboard window

const LATENCY_BUCKETS: Array<[field: string, ceilingMs: number]> = [
  ["b_lt50", 50],
  ["b_lt100", 100],
  ["b_lt250", 250],
  ["b_lt500", 500],
  ["b_lt1000", 1000],
  ["b_lt2500", 2500],
];
const LATENCY_OVERFLOW_FIELD = "b_gte2500";
const LATENCY_BUCKET_FIELDS = [...LATENCY_BUCKETS.map(([field]) => field), LATENCY_OVERFLOW_FIELD];

function latencyBucketField(durationMs: number): string {
  for (const [field, ceiling] of LATENCY_BUCKETS) {
    if (durationMs < ceiling) return field;
  }
  return LATENCY_OVERFLOW_FIELD;
}

function minuteBucket(date: Date): string {
  return (
    date.getUTCFullYear().toString() +
    String(date.getUTCMonth() + 1).padStart(2, "0") +
    String(date.getUTCDate()).padStart(2, "0") +
    String(date.getUTCHours()).padStart(2, "0") +
    String(date.getUTCMinutes()).padStart(2, "0")
  );
}

function requestMetricKey(date: Date): string {
  return `sysm:req:${minuteBucket(date)}`;
}

/** Called once per request, after the response status/duration are known. */
export async function writeMetricSample(status: number, durationMs: number): Promise<void> {
  const key = requestMetricKey(new Date());
  const pipeline = redis.pipeline();
  pipeline.hincrby(key, "total", 1);
  if (status >= 500) pipeline.hincrby(key, "err", 1);
  else if (status >= 400) pipeline.hincrby(key, "4xx", 1);
  pipeline.hincrby(key, "dur_sum_ms", Math.max(0, Math.round(durationMs)));
  pipeline.hincrby(key, latencyBucketField(durationMs), 1);
  pipeline.expire(key, METRIC_KEY_TTL_SECONDS);
  try {
    await withTimeout(pipeline.exec(), METRIC_IO_TIMEOUT_MS, "metric write");
  } catch {
    // Fail open — a slow/down Redis must never affect a real request.
  }
}

interface RequestMetricBucket {
  total: number;
  err: number;
  fourXx: number;
  durSumMs: number;
  buckets: Record<string, number>;
}

function emptyBucket(): RequestMetricBucket {
  return { total: 0, err: 0, fourXx: 0, durSumMs: 0, buckets: Object.fromEntries(LATENCY_BUCKET_FIELDS.map((f) => [f, 0])) };
}

async function readMetricBucket(date: Date): Promise<RequestMetricBucket> {
  try {
    const raw = await withTimeout(redis.hgetall(requestMetricKey(date)), METRIC_IO_TIMEOUT_MS, "metric read");
    const bucket = emptyBucket();
    if (!raw) return bucket;
    bucket.total = Number(raw.total || 0);
    bucket.err = Number(raw.err || 0);
    bucket.fourXx = Number(raw["4xx"] || 0);
    bucket.durSumMs = Number(raw.dur_sum_ms || 0);
    for (const field of LATENCY_BUCKET_FIELDS) bucket.buckets[field] = Number(raw[field] || 0);
    return bucket;
  } catch {
    return emptyBucket();
  }
}

function mergeBuckets(a: RequestMetricBucket, b: RequestMetricBucket): RequestMetricBucket {
  const buckets: Record<string, number> = {};
  for (const field of LATENCY_BUCKET_FIELDS) buckets[field] = a.buckets[field] + b.buckets[field];
  return { total: a.total + b.total, err: a.err + b.err, fourXx: a.fourXx + b.fourXx, durSumMs: a.durSumMs + b.durSumMs, buckets };
}

// Approximates p95 from the fixed histogram — good enough for a dashboard
// trend, not a precise SLO number.
function approximateP95Ms(bucket: RequestMetricBucket): number {
  if (bucket.total === 0) return 0;
  const target = bucket.total * 0.95;
  let cumulative = 0;
  for (const [field, ceiling] of LATENCY_BUCKETS) {
    cumulative += bucket.buckets[field];
    if (cumulative >= target) return ceiling;
  }
  // p95 falls in the overflow (>= 2500ms) bucket.
  return LATENCY_BUCKETS[LATENCY_BUCKETS.length - 1][1] * 2;
}

export interface RequestMetricsSummary {
  total: number;
  errorCount: number;
  fourXxCount: number;
  errorRate: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
}

function summarize(bucket: RequestMetricBucket): RequestMetricsSummary {
  return {
    total: bucket.total,
    errorCount: bucket.err,
    fourXxCount: bucket.fourXx,
    errorRate: bucket.total > 0 ? bucket.err / bucket.total : 0,
    avgLatencyMs: bucket.total > 0 ? Math.round(bucket.durSumMs / bucket.total) : 0,
    p95LatencyMs: approximateP95Ms(bucket),
  };
}

/** Aggregate summary over the trailing `minutes` window (rounded to whole minutes). */
export async function getRequestMetricsWindow(minutes: number): Promise<RequestMetricsSummary> {
  const now = Date.now();
  const buckets = await Promise.all(
    Array.from({ length: minutes }, (_, i) => readMetricBucket(new Date(now - i * 60_000))),
  );
  return summarize(buckets.reduce(mergeBuckets, emptyBucket()));
}

export interface RequestMetricsSeriesPoint {
  minute: string; // ISO timestamp of the bucket start
  total: number;
  errorCount: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
}

/** Minute-bucketed, zero-filled series over the trailing `minutes` window, oldest first. */
export async function getRequestMetricsSeries(minutes: number): Promise<RequestMetricsSeriesPoint[]> {
  const now = Date.now();
  const points = await Promise.all(
    Array.from({ length: minutes }, async (_, i) => {
      const date = new Date(now - i * 60_000);
      date.setUTCSeconds(0, 0);
      const bucket = await readMetricBucket(date);
      return { date, summary: summarize(bucket) };
    }),
  );
  return points
    .reverse()
    .map(({ date, summary }) => ({
      minute: date.toISOString(),
      total: summary.total,
      errorCount: summary.errorCount,
      avgLatencyMs: summary.avgLatencyMs,
      p95LatencyMs: summary.p95LatencyMs,
    }));
}

// ── Dependency health ────────────────────────────────────────────────────

const HEALTH_CHECK_TIMEOUT_MS = 800;

export interface DependencyHealth {
  healthy: boolean;
  latencyMs: number | null;
  error?: string;
}

export async function checkRedisHealth(): Promise<DependencyHealth> {
  const start = Date.now();
  try {
    await withTimeout(redis.ping(), HEALTH_CHECK_TIMEOUT_MS, "redis ping");
    return { healthy: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { healthy: false, latencyMs: null, error: err instanceof Error ? err.message : "unknown error" };
  }
}

export async function checkMongoHealth(): Promise<DependencyHealth> {
  const start = Date.now();
  try {
    if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) {
      throw new Error("not connected");
    }
    await withTimeout(mongoose.connection.db.admin().ping(), HEALTH_CHECK_TIMEOUT_MS, "mongo ping");
    return { healthy: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { healthy: false, latencyMs: null, error: err instanceof Error ? err.message : "unknown error" };
  }
}

// ── Connected sockets ────────────────────────────────────────────────────

/** Cluster-wide connected-socket count. fetchSockets() is Redis-adapter-aware
 * (see dmCallService.ts's hasConnectedSocketAnywhere for the same idiom) —
 * falls back to this instance's local count if the cluster-wide call fails. */
export async function getConnectedSocketCount(io: Server): Promise<number> {
  try {
    return (await io.fetchSockets()).length;
  } catch {
    return io.sockets.sockets.size;
  }
}
