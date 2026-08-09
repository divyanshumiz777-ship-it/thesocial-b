import { Context, Hono } from "hono";
import { cors } from "hono/cors";
import { getAllowedOrigins, matchOrigin } from "./lib/corsOrigins.ts";
import cacheMiddleware from "./middleware/cacheMiddleware.ts";
import requestLogger from "./middleware/requestLogger.ts";
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
import { chatThemeRouter } from "./routes/chatThemeRoutes.ts";
import { threadRouter } from "./routes/threadRoutes.ts";
import { notificationRouter } from "./routes/notificationRoutes.ts";
import { botRouter } from "./routes/botRoutes.ts";
import attachmentRoutes from "./routes/attachmentRoutes.ts";
import friendRoutes from "./routes/friendRoutes.ts";
import followRoutes from "./routes/followRoutes.ts";
import reportRoutes from "./routes/reportRoutes.ts";
import presenceRoutes from "./routes/presenceRoutes.ts";
import { reelRouter } from "./routes/reelRoutes.ts";
import { publicReelRouter } from "./routes/publicReelRoutes.ts";
import { assistantRouter } from "./routes/assistantRoutes.ts";
import { adminRouter } from "./routes/adminRoutes.ts";
import appealRoutes from "./routes/appealRoutes.ts";
import savedItemRoutes from "./routes/savedItemRoutes.ts";
import digestRoutes from "./routes/digestRoutes.ts";
import pushRoutes from "./routes/pushRoutes.ts";
import paymentRoutes from "./routes/paymentRoutes.ts";
import { voiceSessionRouter } from "./routes/voiceSessionRoutes.ts";
import { getIoInstance } from "./config/socket.ts";
import { rateLimit } from "./middleware/rateLimit.ts";

const app = new Hono();

// ── CORS ─────────────────────────────────────────────────────────────────────
// FIX: credentials:true requires an explicit origin, not "*"
//
// Origin resolution now lives in ./lib/corsOrigins.ts and is shared with the
// Socket.IO CORS config in server.ts — previously each layer had its own
// copy, and the Socket.IO copy was never updated when this one was fixed,
// silently breaking WebSocket CORS under a multi-origin FRONTEND_URL.

const allowedOrigins = getAllowedOrigins();

app.use(
  "*",
  cors({
    origin: (origin) => matchOrigin(origin, allowedOrigins),
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    credentials: true,
  }),
);

const isTest = process.env.NODE_ENV === "test";

if (!isTest) {
  app.use(metrics);
  app.use(helmetMiddleware);
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
      "/api/v1/dm/groups/", // group info/members/messages — same rationale as
      // get-dm above (socket provides liveness); also where a member's
      // presence dot lives, so a stale read here would look like the
      // gray-dot-while-online bug even after the actual presence fix.
      "/api/v1/user/conversations", // always needs fresh
      "/api/v1/dm/hidden-conversations", // must reflect hide/unhide immediately;
      // cache runs before authMiddleware → anonymous key shared across users
      "/api/v1/dm/blocked-users", // same: per-user list, must reflect block/unblock now
      "/api/v1/dm/theme/", // must reflect a just-set theme immediately on the
      // next open — invalidated on write too, but this is the same "socket
      // already provides liveness for THIS session" class of route as get-dm
      "/api/v1/chat-theme/", // generalized dm/group/community version of the
      // route above — same rationale, same requirement
      "/api/v1/notification", // always needs fresh
      "/api/v1/user/settings", // settings must be current
      "/api/v1/user/account-info", // gates the password-change form's visibility —
      // a stale cached response right after linking/unlinking a provider (or in a
      // test/dev cycle) would show the wrong form state or a confusing error
      "/api/v1/auth/", // never cache auth
      "/api/v1/user/friends", // always reflects current friend list
      "/api/v1/friends/requests/", // pending/sent requests must be fresh after accept/reject
      "/api/v1/friends/", // friend list via friend routes
      "/api/v1/user/user-servers", // cache runs before authMiddleware → key is "anonymous",
      // so all users would share one stale list (own created/joined servers wouldn't show)
      "/api/v1/saved-items", // save/unsave has no socket-based liveness to fall back on
      // (unlike messages/DMs above) — saveItem/unsaveItem never invalidated this GET's
      // cache entry, so the optimistic client-side toggle got silently reverted the
      // moment SWR's own revalidation re-fetched the still-cached (pre-toggle) list;
      // per-user list, cheap to compute, no benefit to caching it anyway
      "/api/v1/message/pinned", // same bug class: togglePinMessage emits
      // "message:pinned" over the socket, but every listener (including the
      // pinning user's own client) reacts to it by re-fetching this exact
      // GET — and togglePinMessage never invalidates this route's cache
      // entry, so the refetch just replayed the pre-pin cached list until
      // the cache entry happened to expire (which read as "fixes itself on
      // reload")
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
app.route("/api/v1/chat-theme", chatThemeRouter);
app.route("/api/v1/thread", threadRouter);
app.route("/api/v1/notification", notificationRouter);
app.route("/api/v1/bot", botRouter);
app.route("/api/v1/attachments", attachmentRoutes);
app.route("/api/v1/friends", friendRoutes);
app.route("/api/v1/follow", followRoutes);
app.route("/api/v1/reports", reportRoutes);
app.route("/api/v1/presence", presenceRoutes);
app.route("/api/v1/reels", reelRouter);
app.route("/api/v1/public/reels", publicReelRouter);
app.route("/api/v1/assistant", assistantRouter);
app.route("/api/v1/admin", adminRouter);
app.route("/api/v1/appeals", appealRoutes);
app.route("/api/v1/saved-items", savedItemRoutes);
app.route("/api/v1/digest", digestRoutes);
app.route("/api/v1/push", pushRoutes);
app.route("/api/v1/payments", paymentRoutes);
app.route("/api/v1/voice", voiceSessionRouter);

export default app;
