import { Context, Hono } from "hono";
import { cors } from "hono/cors";
import cacheMiddleware from "./middleware/cacheMiddleware.ts";
import requestLogger from "./middleware/requestLogger.ts";
import securityHeaders from "./middleware/securityHeaders.ts";
import helmetMiddleware from "./middleware/helmetMiddleware.ts";
import Sentry from "./lib/sentry.ts";
import { metrics, metricsEndpoint } from "./middleware/metrics.ts";
import { userRouter } from "./routes/userRoutes.ts";
import { authRouter } from "./routes/authRoutes.ts";
import { serverRouter } from "./routes/serverRoutes.ts";
import { categoryRouter } from "./routes/categoryRoutes.ts";
import { channelRouter } from "./routes/channelRoutes.ts";
import { messageRouter } from "./routes/messageRoutes.ts";
import { dmRouter } from "./routes/dmRoutes.ts";
import { threadRouter } from "./routes/threadRoutes.ts";
import { notificationRouter } from "./routes/notificationRoutes.ts";
import { botRouter } from "./routes/botRoutes.ts";
import attachmentRoutes from "./routes/attachmentRoutes.ts";
import friendRoutes from "./routes/friendRoutes.ts";
import { reelRouter } from "./routes/reelRoutes.ts";
import { getIoInstance } from "./config/socket.ts";
import { rateLimit } from "./middleware/rateLimit.ts";

const app = new Hono();

// ── CORS ─────────────────────────────────────────────────────────────────────
// FIX: credentials:true requires an explicit origin, not "*"

const allowedOrigins = (
  process.env.FRONTEND_URL ||
  "http://localhost:3000" ||
  "http://localhost:3001"
)
  .split(",")
  .map((o) => o.trim());

app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) return allowedOrigins[0]; // same-origin / server-side requests
      return allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
    },
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    credentials: true,
  }),
);

const isTest = process.env.NODE_ENV === "test";

if (!isTest) {
  app.use(metrics);
  app.use(helmetMiddleware);
  app.use(securityHeaders);
  app.use(requestLogger);
}

// ── Cache middleware with corrected skip list ─────────────────────────────────
//
// FIX 1: Original SKIP_CACHE_ROUTES didn't match real route paths, so:
//   - POST message send was skipped (correct — it's a POST, so already skipped)
//   - GET /message/get-messages/:channelId was NOT skipped even though:
//     (a) it has no auth → all users share cache:anonymous:... key (privacy leak)
//     (b) cacheInvalidation patterns targeted wrong paths so new messages
//         never evicted the cache → stale messages for up to 60s after send
//
// FIX 2: get-messages route now has authMiddleware added in messageRoutes.ts
//   (see that file). With auth, each user gets a scoped cache key.
//   But we still add get-messages to the skip list because socket events
//   provide liveness — there's no value in serving a cached message list
//   that's 60s stale when the socket already delivered the new message.
//
// The other affected routes (DM messages, conversations) are also skipped
// so they always reflect the latest data on mount.

if (!isTest) {
  app.use("*", async (c: Context, next) => {
    const path = new URL(c.req.url).pathname;

    // Skip cache for routes where stale data causes visible bugs
    const skipPaths = [
      "/api/v1/message/get-messages/", // socket provides liveness
      "/api/v1/dm/get-dm/", // same
      "/api/v1/user/conversations", // always needs fresh
      "/api/v1/notification", // always needs fresh
      "/api/v1/user/settings", // settings must be current
      "/api/v1/auth/", // never cache auth
    ];

    if (skipPaths.some((p) => path.startsWith(p))) {
      return next();
    }

    return cacheMiddleware(c, next);
  });
}

// ── io context injection ──────────────────────────────────────────────────────
//
// FIX: Original swallowed the error silently. We still don't throw
// (the server may briefly be in an init state) but we log in dev.

if (!isTest) {
  app.use(async (c: Context, next) => {
    try {
      const io = getIoInstance();
      c.set("io", io);
    } catch (error) {
      if (process.env.NODE_ENV === "development") {
        console.warn("Socket.IO not yet initialised for this request");
      }
    }
    await next();
  });
}

// ── Rate limit (applied after cache, before routes) ───────────────────────────
app.use("*", rateLimit);

// ── Health / meta ─────────────────────────────────────────────────────────────
app.get("/", (c) => c.text("TheSocial API"));
app.get("/healthz", (c) =>
  c.json({ status: "ok", uptime: process.uptime(), timestamp: Date.now() }),
);
app.get("/metrics", metricsEndpoint);

// ── Global error handler ──────────────────────────────────────────────────────
app.onError((err, c) => {
  Sentry.captureException(err);
  console.error("Unhandled error:", err.message);
  return c.json({ error: "Internal server error" }, 500);
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.route("/api/v1/auth", authRouter);
app.route("/api/v1/user", userRouter);
app.route("/api/v1/server", serverRouter);
app.route("/api/v1/category", categoryRouter);
app.route("/api/v1/channel", channelRouter);
app.route("/api/v1/message", messageRouter);
app.route("/api/v1/dm", dmRouter);
app.route("/api/v1/thread", threadRouter);
app.route("/api/v1/notification", notificationRouter);
app.route("/api/v1/bot", botRouter);
app.route("/api/v1/attachments", attachmentRoutes);
app.route("/api/v1/friends", friendRoutes);
app.route("/api/v1/reels", reelRouter);

export default app;
