import { Context, Next } from "hono";
import { writeMetricSample } from "../lib/systemHealth.ts";

// Replaces metrics.ts — records into Redis (lib/systemHealth.ts) instead of
// an in-process counter, so figures survive restarts and are correct across
// replicas. No public endpoint reads this directly; it's surfaced only
// through the admin-gated /api/v1/admin/system-health* routes.
export const systemMetrics = async (c: Context, next: Next) => {
  const start = Date.now();
  let status = 500;
  try {
    await next();
    status = c.res?.status ?? 200;
  } catch (err) {
    status = 500;
    throw err;
  } finally {
    void writeMetricSample(status, Date.now() - start);
  }
};
