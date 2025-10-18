import "dotenv/config";
import { serve } from "@hono/node-server";
import { Server } from "socket.io";
import { connectDB } from "./config/db.ts";
import { setIoInstance } from "./config/socket.ts";
import app from "./app.ts";

async function startServer() {
  try {
    await connectDB();
    console.log("Database connected successfully!");
    const PORT = Number(process.env.PORT) || 8000;

    const httpServerInstance = serve({
      fetch: app.fetch,
      port: PORT,
    });

    const ioInstance = new Server(httpServerInstance, {
      cors: {
        origin: "*",
        methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
      },
    });

    setIoInstance(ioInstance);

    const typingTimeouts = new Map();
    const onlineUsers = new Map<string, number>();

    ioInstance.on("connection", (socket) => {
      let connectedUserId: string | undefined;
      const joinedRooms = new Set<string>();

      try {
        socket.emit("presence:snapshot", {
          onlineUserIds: Array.from(onlineUsers.keys()),
          ts: Date.now(),
        });
      } catch {}

      const emitRoomCounts = (roomId: string) => {
        const count = ioInstance.sockets.adapter.rooms.get(roomId)?.size || 0;
        ioInstance.emit("server:member-count", { serverId: roomId, count });
        ioInstance.emit("channel:member-count", { channelId: roomId, count });
      };

      socket.on("identify", (userId: string) => {
        connectedUserId = userId;
        socket.join(userId);
        joinedRooms.add(userId);
        const prev = onlineUsers.get(userId) || 0;
        onlineUsers.set(userId, prev + 1);
        ioInstance.emit("presence:update", {
          userId,
          online: true,
          ts: Date.now(),
        });
      });

      socket.on("join-server", (roomId: string, userId?: string) => {
        if (userId) {
          connectedUserId = userId;
          socket.join(userId);
          joinedRooms.add(userId);
          const prev = onlineUsers.get(userId) || 0;
          onlineUsers.set(userId, prev + 1);
          ioInstance.emit("presence:update", {
            userId,
            online: true,
            ts: Date.now(),
          });
        }
        socket.join(roomId);
        joinedRooms.add(roomId);
        ioInstance
          .to(roomId)
          .emit("user-connected", connectedUserId, Date.now());
        emitRoomCounts(roomId);
      });

      socket.on("join-channel", (channelId: string) => {
        socket.join(channelId);
        joinedRooms.add(channelId);
        emitRoomCounts(channelId);
      });

      socket.on("request-server-channel-counts", (serverId: string) => {});

      socket.on("join-dm", (conversationId: string) => {
        socket.join(conversationId);
        joinedRooms.add(conversationId);
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
        ioInstance.to(channelId).emit("typing", userId);
      });

      socket.on("disconnect", () => {
        if (connectedUserId) {
          const prev = onlineUsers.get(connectedUserId) || 0;
          const next = Math.max(0, prev - 1);
          if (next === 0) {
            onlineUsers.delete(connectedUserId);
            ioInstance.emit("presence:update", {
              userId: connectedUserId,
              online: false,
              ts: Date.now(),
            });
          } else {
            onlineUsers.set(connectedUserId, next);
          }
        }
        for (const key of typingTimeouts.keys()) {
          if (connectedUserId && key.endsWith(`-${connectedUserId}`)) {
            clearTimeout(typingTimeouts.get(key));
            typingTimeouts.delete(key);
          }
        }
        for (const roomId of joinedRooms) {
          emitRoomCounts(roomId);
        }
      });
    });

    console.log(`Hono/Socket.IO Server running on http://localhost:${PORT}`);
  } catch (error) {
    console.error("Failed to start application:", error);
    process.exit(1);
  }
}

startServer();
