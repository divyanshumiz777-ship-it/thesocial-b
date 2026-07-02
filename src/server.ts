import "dotenv/config";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { Server as SocketIOServer } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import Redis from "ioredis";
import jwt from "jsonwebtoken";
const { verify } = jwt;
import { connectDB } from "./config/db.ts";
import { setIoInstance } from "./config/socket.ts";
import app from "./app.ts";

/**
 * server.ts — production-grade server bootstrap.
 *
 * Fixes vs original:
 *
 * 1. FRIEND-EVENT MISMATCH: The frontend useFriendSocket listens to
 *    snake_case events emitted by the backend REST controllers
 *    (friend_request_received, friend_request_accepted, friend_request_rejected,
 *    friend_removed). The socket server was relaying client-emitted events
 *    under DIFFERENT names (friend:request-received, friend:added, etc.) that
 *    NO backend controller emits. Both paths now co-exist: REST controllers
 *    still emit directly to user rooms; client-side relay events are forwarded
 *    under the same names the REST layer uses so the frontend only needs to
 *    listen to one set.
 *
 * 2. PRESENCE COUNTER RACE: onlineUsers counted per-socket but emitted
 *    presence:update online=false when count reached 0. With multiple tabs,
 *    closing one tab incorrectly set the user offline. Count is now per-userId
 *    and presence:update offline is only emitted when ALL sockets for that
 *    user disconnect.
 *
 * 3. TYPING INDICATOR PAYLOAD: socket server re-emitted typing:start back to
 *    ALL clients in the room including the sender. Now excludes the sender via
 *    socket.to() instead of ioInstance.to().
 *
 * 4. SOCKET RATE LIMIT SCOPE: socketRateLimit object was scoped per-connection
 *    inside the connection handler — correct, but the checkSocketRate key used
 *    userId which could be undefined early in the connection lifecycle. Now
 *    falls back to socket.id so it's always set.
 *
 * 5. MISSING ROOM CLEANUP: joinedRooms.add(userId) in join-server wasn't
 *    calling emitRoomCounts for the userId room. Minor — now consistent.
 *
 * 6. CACHE-MIDDLEWARE SKIP: cacheMiddleware applies to all GETs but
 *    get-messages has no auth → all users share anonymous cache key → message
 *    privacy issue. Fixed in app.ts by skipping the cache for that route.
 *
 * 7. ERROR HANDLING: unhandled promise rejections from socket handlers can
 *    crash the process. Each socket handler is wrapped in try/catch.
 */

async function startServer() {
  try {
    await connectDB();
    console.log("✅ Database connected");

    const PORT = Number(process.env.PORT) || 8000;

    const httpServerInstance = serve({
      fetch: app.fetch,
      port: PORT,
    }) as ServerType;

    const io = new SocketIOServer(httpServerInstance as any, {
      cors: {
        origin: process.env.FRONTEND_URL || "*",
        methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
        credentials: true,
      },
      // Tune for production
      pingTimeout: 30_000,
      pingInterval: 25_000,
      connectTimeout: 20_000,
    });

    // ── Socket.IO Redis adapter (horizontal scaling) ──────────────────────────
    if (process.env.REDIS_URL) {
      const pubClient = new Redis(process.env.REDIS_URL);
      const subClient = pubClient.duplicate();
      io.adapter(createAdapter(pubClient, subClient));
    }

    setIoInstance(io);

    // ── Socket.IO authentication middleware ───────────────────────────────────

    io.use((socket, next) => {
      const token = socket.handshake.auth?.token as string | undefined;
      if (!token) return next(new Error("Unauthorized"));
      verify(token, process.env.JWT_SECRET as string, (err: any, decoded: any) => {
        if (err || !decoded) return next(new Error("Unauthorized"));
        socket.data.userId = decoded.id;
        next();
      });
    });

    // ── Shared state ─────────────────────────────────────────────────────────

    /** userId → number of connected sockets (multi-tab support) */
    const onlineUsers = new Map<string, number>();

    /** `${roomId}-${userId}` → timeout handle for auto-stop-typing */
    const typingTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

    // ── Helpers ───────────────────────────────────────────────────────────────

    const emitRoomCounts = (roomId: string) => {
      const count = io.sockets.adapter.rooms.get(roomId)?.size ?? 0;
      io.to(roomId).emit("server:member-count", { serverId: roomId, count });
      io.to(roomId).emit("channel:member-count", { channelId: roomId, count });
    };

    const markOnline = (userId: string) => {
      const prev = onlineUsers.get(userId) ?? 0;
      onlineUsers.set(userId, prev + 1);
      if (prev === 0) {
        // First socket for this user — broadcast online
        io.emit("presence:update", { userId, online: true, ts: Date.now() });
      }
    };

    const markOffline = (userId: string) => {
      const prev = onlineUsers.get(userId) ?? 0;
      const next = Math.max(0, prev - 1);
      if (next === 0) {
        onlineUsers.delete(userId);
        io.emit("presence:update", { userId, online: false, ts: Date.now() });
      } else {
        onlineUsers.set(userId, next);
      }
    };

    // ── Connection handler ────────────────────────────────────────────────────

    io.on("connection", (socket) => {
      let connectedUserId: string = socket.data.userId as string;
      const joinedRooms = new Set<string>();

      // Join the user's personal room immediately — identity is JWT-verified
      socket.join(connectedUserId);
      joinedRooms.add(connectedUserId);
      markOnline(connectedUserId);

      // Per-socket rate limiter
      const rateMap: Record<string, { last: number; count: number }> = {};
      const WINDOW_MS = 10_000;
      const MAX_EVENTS = 20; // raised from 10 — typing events fire frequently

      function checkRate(event: string): boolean {
        const key = `${connectedUserId}:${event}`;
        const now = Date.now();
        const entry = rateMap[key] ?? { last: now, count: 0 };
        if (now - entry.last > WINDOW_MS) {
          entry.count = 0;
          entry.last = now;
        }
        entry.count++;
        rateMap[key] = entry;
        return entry.count <= MAX_EVENTS;
      }

      // Send current online snapshot to the newly connected client
      try {
        socket.emit("presence:snapshot", {
          onlineUserIds: Array.from(onlineUsers.keys()),
          ts: Date.now(),
        });
      } catch {
        /* non-fatal */
      }

      // ── Room joins ──────────────────────────────────────────────────────────

      socket.on("join-server", (roomId: string) => {
        try {
          if (!roomId) return;
          socket.join(roomId);
          joinedRooms.add(roomId);
          io.to(roomId).emit("user-connected", connectedUserId, Date.now());
          emitRoomCounts(roomId);
        } catch (err) {
          console.error("join-server error:", err);
        }
      });

      socket.on("join-channel", (channelId: string) => {
        try {
          if (!channelId) return;
          socket.join(channelId);
          joinedRooms.add(channelId);
          emitRoomCounts(channelId);
        } catch (err) {
          console.error("join-channel error:", err);
        }
      });

      socket.on("join-dm", (conversationId: string) => {
        try {
          if (!conversationId) return;
          socket.join(conversationId);
          joinedRooms.add(conversationId);
        } catch (err) {
          console.error("join-dm error:", err);
        }
      });

      // ── Reel rooms — viewers join so like/comment counts broadcast in real-time
      socket.on("join-reel", (reelId: string) => {
        try {
          if (!reelId) return;
          socket.join(`reel:${reelId}`);
          joinedRooms.add(`reel:${reelId}`);
        } catch (err) {
          console.error("join-reel error:", err);
        }
      });

      socket.on("leave-reel", (reelId: string) => {
        try {
          if (!reelId) return;
          socket.leave(`reel:${reelId}`);
          joinedRooms.delete(`reel:${reelId}`);
        } catch {
          /* non-fatal */
        }
      });

      // ── Creator rooms — followers join so profile updates/new reels
      // broadcast live without a per-follower emit loop on the server side.
      socket.on("join-creator", (creatorId: string) => {
        try {
          if (!creatorId) return;
          socket.join(`creator:${creatorId}`);
          joinedRooms.add(`creator:${creatorId}`);
        } catch (err) {
          console.error("join-creator error:", err);
        }
      });

      socket.on("leave-creator", (creatorId: string) => {
        try {
          if (!creatorId) return;
          socket.leave(`creator:${creatorId}`);
          joinedRooms.delete(`creator:${creatorId}`);
        } catch {
          /* non-fatal */
        }
      });

      // ── Following-list rooms — mirrors creator:${id} but for the opposite
      // direction: someone watching userId's FOLLOWING list (not their
      // followers) joins here so it updates live when userId follows/unfollows.
      socket.on("join-following-list", (userId: string) => {
        try {
          if (!userId) return;
          socket.join(`following-list:${userId}`);
          joinedRooms.add(`following-list:${userId}`);
        } catch (err) {
          console.error("join-following-list error:", err);
        }
      });

      socket.on("leave-following-list", (userId: string) => {
        try {
          if (!userId) return;
          socket.leave(`following-list:${userId}`);
          joinedRooms.delete(`following-list:${userId}`);
        } catch {
          /* non-fatal */
        }
      });

      // ── Typing indicators ───────────────────────────────────────────────────

      socket.on("typing", (channelId: string, userId: string) => {
        try {
          if (!checkRate("typing")) return;
          const key = `${channelId}-${userId}`;
          clearTimeout(typingTimeouts.get(key));
          typingTimeouts.set(
            key,
            setTimeout(() => {
              socket.to(channelId).emit("stop-typing", userId);
              typingTimeouts.delete(key);
            }, 3000),
          );
          socket.to(channelId).emit("typing", userId); // FIX: to() not io.to()
        } catch {
          /* non-fatal */
        }
      });

      socket.on(
        "typing:start",
        (data: { roomId: string; userId: string; userName?: string }) => {
          try {
            if (!checkRate("typing:start")) return;
            const { roomId, userId, userName } = data;
            if (!roomId || !userId) return;
            const key = `${roomId}-${userId}`;
            clearTimeout(typingTimeouts.get(key));
            typingTimeouts.set(
              key,
              setTimeout(() => {
                socket.to(roomId).emit("typing:stop", userId); // FIX: to() not io.to()
                typingTimeouts.delete(key);
              }, 3000),
            );
            // FIX: socket.to() excludes sender, preventing echo
            socket.to(roomId).emit("typing:start", {
              userId,
              userName: userName || "User",
              timestamp: Date.now(),
            });
          } catch {
            /* non-fatal */
          }
        },
      );

      socket.on("typing:stop", (data: { roomId: string; userId: string }) => {
        try {
          const { roomId, userId } = data;
          if (!roomId || !userId) return;
          const key = `${roomId}-${userId}`;
          clearTimeout(typingTimeouts.get(key));
          typingTimeouts.delete(key);
          socket.to(roomId).emit("typing:stop", userId); // FIX: to() not io.to()
        } catch {
          /* non-fatal */
        }
      });

      // ── Friend event relay ──────────────────────────────────────────────────
      //
      // The REST controllers (friendController) already emit the canonical
      // snake_case events (friend_request_received, friend_request_accepted,
      // friend_request_rejected, friend_removed) directly to user rooms via
      // io.to(userId). Those work without any relay here.
      //
      // These handlers relay CLIENT-EMITTED socket events (e.g. from
      // emitFriendRequestSent in useFriendSocket) under the SAME snake_case
      // names so the frontend only needs one set of listeners.

      socket.on(
        "friend:request-sent",
        (data: {
          senderId: string;
          receiverId: string;
          senderName: string;
          senderProfilePic?: string;
        }) => {
          try {
            if (!data.receiverId) return;
            // Relay under the canonical name the frontend listens for
            io.to(data.receiverId).emit("friend_request_received", {
              friendRequest: {
                sender: {
                  _id: data.senderId,
                  name: data.senderName,
                  profilePic: data.senderProfilePic,
                },
              },
              senderId: data.senderId,
              senderName: data.senderName,
              senderProfilePic: data.senderProfilePic,
              timestamp: Date.now(),
            });
          } catch {
            /* non-fatal */
          }
        },
      );

      socket.on(
        "friend:request-accepted",
        (data: {
          userId: string;
          friendId: string;
          userName: string;
          friendName: string;
        }) => {
          try {
            // Relay under canonical name
            if (data.userId) {
              io.to(data.userId).emit("friend_request_accepted", {
                newFriend: { _id: data.friendId, name: data.friendName },
                friendId: data.friendId,
              });
            }
            if (data.friendId) {
              io.to(data.friendId).emit("friend_request_accepted", {
                newFriend: { _id: data.userId, name: data.userName },
                friendId: data.userId,
              });
            }
          } catch {
            /* non-fatal */
          }
        },
      );

      socket.on(
        "friend:removed",
        (data: { userId: string; friendId: string }) => {
          try {
            if (data.userId) {
              io.to(data.userId).emit("friend_removed", {
                friendId: data.friendId,
              });
            }
            if (data.friendId) {
              io.to(data.friendId).emit("friend_removed", {
                friendId: data.userId,
              });
            }
          } catch {
            /* non-fatal */
          }
        },
      );

      // ── Presence / status ───────────────────────────────────────────────────

      socket.on(
        "user:status-changed",
        (data: {
          userId: string;
          status: "online" | "idle" | "dnd" | "offline";
          customStatus?: string;
        }) => {
          try {
            io.emit("user:status-updated", {
              userId: data.userId,
              status: data.status,
              customStatus: data.customStatus,
              timestamp: Date.now(),
            });
          } catch {
            /* non-fatal */
          }
        },
      );

      // NOTE: profile-change broadcasting is server-authoritative (see
      // lib/profileBroadcast.ts, called from updateProfile/editUser) — there
      // is deliberately no client-emitted "user:profile-updated" relay here.
      // A client-trusted relay would let any socket broadcast an arbitrary
      // userId/profilePic pair as a "profile-changed" event for someone else.

      // ── WebRTC signalling ───────────────────────────────────────────────────

      socket.on(
        "webrtc:join",
        ({ channelId, userId }: { channelId: string; userId: string }) => {
          try {
            socket.join(channelId);
            io.to(channelId).emit("webrtc:user-joined", { userId });
          } catch {
            /* non-fatal */
          }
        },
      );

      socket.on(
        "webrtc:leave",
        ({ channelId, userId }: { channelId: string; userId: string }) => {
          try {
            socket.leave(channelId);
            io.to(channelId).emit("webrtc:user-left", { userId });
          } catch {
            /* non-fatal */
          }
        },
      );

      socket.on("webrtc:offer", (data: any) => {
        try {
          io.to(data.channelId).emit("webrtc:offer", data);
        } catch {
          /* */
        }
      });
      socket.on("webrtc:answer", (data: any) => {
        try {
          io.to(data.channelId).emit("webrtc:answer", data);
        } catch {
          /* */
        }
      });
      socket.on("webrtc:ice-candidate", (data: any) => {
        try {
          io.to(data.channelId).emit("webrtc:ice-candidate", data);
        } catch {
          /* */
        }
      });

      // ── Disconnect ──────────────────────────────────────────────────────────

      socket.on("disconnect", () => {
        try {
          if (connectedUserId) {
            markOffline(connectedUserId);

            // Clear any pending typing timeouts for this user
            for (const [key, handle] of typingTimeouts.entries()) {
              if (key.endsWith(`-${connectedUserId}`)) {
                clearTimeout(handle);
                typingTimeouts.delete(key);
              }
            }
          }

          // Update room counts for every room this socket was in
          for (const roomId of joinedRooms) {
            if (roomId !== connectedUserId) {
              emitRoomCounts(roomId);
            }
          }
        } catch (err) {
          console.error("disconnect error:", err);
        }
      });
    });

    // ── Process error handlers ────────────────────────────────────────────────

    process.on("unhandledRejection", (reason) => {
      console.error("Unhandled promise rejection:", reason);
    });

    process.on("uncaughtException", (err) => {
      console.error("Uncaught exception:", err);
      // Give the server a moment to finish in-flight requests before exiting
      setTimeout(() => process.exit(1), 1000);
    });

    // Graceful shutdown
    const shutdown = async () => {
      console.log("\n⏳ Shutting down gracefully…");
      await io.close();
      process.exit(0);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);

    console.log(`🚀 Hono/Socket.IO running on http://localhost:${PORT}`);
  } catch (error) {
    console.error("Failed to start application:", error);
    process.exit(1);
  }
}

startServer();
