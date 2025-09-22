import dotenv from "dotenv";
import { serve } from "@hono/node-server";
import { Server } from "socket.io";
import { connectDB } from "./config/db.ts";
import app from "./app.ts";

const envFile =
  process.env.NODE_ENV === "production" ? ".env.production" : ".env.local";
dotenv.config({ path: envFile });

let ioInstance: Server;

async function startServer() {
  try {
    await connectDB();
    console.log("Database connected successfully!");
    const PORT = Number(process.env.PORT) || 8001;

    const httpServerInstance = serve({
      fetch: app.fetch,
      port: PORT,
    });

    ioInstance = new Server(httpServerInstance, {
      cors: {
        origin: "*",
        methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
      },
    });

    const typingTimeouts = new Map();

    ioInstance.on("connection", (socket) => {
      let connectedServerId: string;
      let connectedUserId: string;
      socket.on("join-server", (serverId, userId) => {
        socket.join(serverId);
        connectedServerId = serverId;
        connectedUserId = userId;

        ioInstance.to(serverId).emit("user-connected", userId, Date.now());
      });
      socket.on("typing", (channelId, userId) => {
        const timeoutKey = `${channelId}-${userId}`;
        if (typingTimeouts.has(timeoutKey)) {
          clearTimeout(typingTimeouts.get(timeoutKey));
        }
        const newTimeout = setTimeout(() => {
          ioInstance.to(channelId).emit("stop-typing", userId);
          typingTimeouts.delete(timeoutKey);
        }, 3000);
        typingTimeouts.set(timeoutKey, newTimeout);
      });

      socket.on("disconnect", () => {
        if (connectedServerId && connectedUserId)
          ioInstance
            .to(connectedServerId)
            .emit("user-disconnected", connectedUserId, Date.now());
      });
    });

    console.log(`Hono/Socket.IO Server running on http://localhost:${PORT}`);
  } catch (error) {
    console.error("Failed to start application:", error);
    process.exit(1);
  }
}

startServer();

export const getIoInstance = () => {
  if (!ioInstance) {
    throw new Error("Socket.IO instance not initialized yet!");
  }
  return ioInstance;
};
