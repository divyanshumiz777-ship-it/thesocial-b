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

app.use(
  "*",
  cors({
    origin: (process.env.FRONTEND_URL as string) || "*",
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  }),
);

const isTest = process.env.NODE_ENV === "test";

if (!isTest) {
  app.use(metrics);
}

if (!isTest) {
  app.use(helmetMiddleware);
  app.use(securityHeaders);
  app.use(requestLogger);
  app.use("*", cacheMiddleware);
  app.use(async (c: Context, next) => {
    try {
      const io = getIoInstance();
      c.set("io", io);
    } catch (error) {
      console.warn("Socket.IO instance not available:", error);
    }
    await next();
  });
}

app.use("*", rateLimit);

app.get("/", (c) => c.text("Hello World from Hono App!"));
app.get("/healthz", (c) =>
  c.json({ status: "ok", uptime: process.uptime(), timestamp: Date.now() }),
);

app.onError((err, c) => {
  Sentry.captureException(err);
  c.header("Access-Control-Allow-Origin", "http://localhost:3000");
  c.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  c.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  return c.json({ error: "Internal server error" }, 500);
});
app.get("/metrics", metricsEndpoint);

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
