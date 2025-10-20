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
      const socketRateLimit: Record<string, { last: number; count: number }> =
        {};
      const SOCKET_WINDOW_MS = 10 * 1000;
      const SOCKET_MAX_EVENTS = 10;

      function checkSocketRate(userId: string, event: string) {
        const key = `${userId}:${event}`;
        const now = Date.now();
        const entry = socketRateLimit[key] || { last: now, count: 0 };
        if (now - entry.last > SOCKET_WINDOW_MS) {
          entry.count = 0;
          entry.last = now;
        }
        entry.count++;
        socketRateLimit[key] = entry;
        return entry.count <= SOCKET_MAX_EVENTS;
      }
      socket.on("webrtc:join", ({ channelId, userId }) => {
        socket.join(channelId);
        ioInstance.to(channelId).emit("webrtc:user-joined", { userId });
      });

      socket.on("webrtc:leave", ({ channelId, userId }) => {
        socket.leave(channelId);
        ioInstance.to(channelId).emit("webrtc:user-left", { userId });
      });

      socket.on("webrtc:offer", ({ channelId, offer, from, to }) => {
        ioInstance.to(channelId).emit("webrtc:offer", { offer, from, to });
      });

      socket.on("webrtc:answer", ({ channelId, answer, from, to }) => {
        ioInstance.to(channelId).emit("webrtc:answer", { answer, from, to });
      });

      socket.on(
        "webrtc:ice-candidate",
        ({ channelId, candidate, from, to }) => {
          ioInstance
            .to(channelId)
            .emit("webrtc:ice-candidate", { candidate, from, to });
        }
      );
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
        if (!checkSocketRate(userId, "typing")) return;
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
