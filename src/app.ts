import { Context, Hono } from "hono";
import { serve } from "@hono/node-server";
import { Server } from "socket.io";

import { cors } from "hono/cors";
import { userRouter } from "./routes/userRoutes.ts";
import { authRouter } from "./routes/authRoutes.ts";
import { serverRouter } from "./routes/serverRoutes.ts";
import { categoryRouter } from "./routes/categoryRoutes.ts";
import { channelRouter } from "./routes/channelRoutes.ts";
import { messageRouter } from "./routes/messageRoutes.ts";
import { dmRouter } from "./routes/dmRoutes.ts";

import { getIoInstance } from "./server.ts";
const app = new Hono();

app.use(async (c: Context, next) => {
  try {
    const io = getIoInstance();
    c.set("io", io);
  } catch (error) {
    console.warn("Socket.IO instance not available:", error);
  }
  await next();
});

app.use(
  "*",
  cors({
    origin: "*",
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  })
);

app.get("/", (c) => c.text("Hello World from Hono App!"));

app.route("/api/v1/auth", authRouter);
app.route("/api/v1/profile", userRouter);
app.route("/api/v1/server", serverRouter);
app.route("/api/v1/category", categoryRouter);
app.route("/api/v1/channel", channelRouter);
app.route("/api/v1/message", messageRouter);
app.route("/api/v1/dm", dmRouter);

export default app;
