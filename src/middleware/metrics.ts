import { Context, Next } from "hono";

let requestCount = 0;
let errorCount = 0;
let lastRequestDuration = 0;

export const metrics = async (c: Context, next: Next) => {
  const start = Date.now();
  try {
    await next();
    requestCount++;
    lastRequestDuration = Date.now() - start;
  } catch (err) {
    errorCount++;
    throw err;
  }
};

export const metricsEndpoint = async (c: Context) => {
  return c.text(`
    # HELP app_requests_total Total requests
    # TYPE app_requests_total counter
    app_requests_total ${requestCount}
    # HELP app_errors_total Total errors
    # TYPE app_errors_total counter
    app_errors_total ${errorCount}
    # HELP app_last_request_duration_ms Last request duration in ms
    # TYPE app_last_request_duration_ms gauge
    app_last_request_duration_ms ${lastRequestDuration}
  `);
};
