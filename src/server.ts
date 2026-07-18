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
import { getAllowedOrigins } from "./lib/corsOrigins.ts";
import app from "./app.ts";
import User from "./models/User.ts";
import VoiceSession from "./models/VoiceSession.ts";
import VoiceSessionTranscript from "./models/VoiceSessionTranscript.ts";
import Channel from "./models/Channel.ts";
import DiscordServer from "./models/DiscordServer.ts";
import ServerMember from "./models/ServerMember.ts";
import {
  createNotification,
  sendNotificationViaSocket,
} from "./controllers/notificationController.ts";
import {
  forwardSummarizeVoiceSession,
  forwardTranscribeAudio,
  isChatServiceEnabled,
  warmChatService,
} from "./lib/chatServiceClient.ts";
import {
  inviteCall as inviteDMCall,
  acceptCall as acceptDMCall,
  rejectCall as rejectDMCall,
  cancelCall as cancelDMCall,
  endCall as endDMCall,
  mediaReady as mediaReadyDMCall,
} from "./lib/dmCallService.ts";

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
 *
 * 8. PRESENCE GRACE PERIOD (P0 realtime fix): markOffline used to broadcast
 *    presence:update{online:false} synchronously and unconditionally on
 *    every disconnect, with zero debounce — any transient disconnect
 *    (network blip, or a client-side reconnect racing its own new
 *    connection ahead of the old one's disconnect event) produced a real,
 *    wire-visible false "offline" broadcast to every client. Offline is now
 *    only broadcast after a grace period with no reconnect, and is cancelled
 *    if any new socket for that user connects first. lastSeen is persisted
 *    to Mongo only once the grace period actually elapses.
 *
 * 9. REDIS ADAPTER ERROR HANDLING: pubClient/subClient had no 'error'
 *    listener, unlike lib/redis.ts's own client — an EventEmitter that
 *    emits 'error' with zero listeners throws synchronously. Guarded now.
 */

async function startServer() {
  try {
    // FAIL FAST: both REST auth (authMiddleware.ts) and the Socket.IO
    // handshake guard below verify against this same secret. Without this
    // check, a missing JWT_SECRET in a given environment doesn't fail
    // loudly at startup — it just makes every request and every socket
    // handshake mysteriously return "Unauthorized" forever, which is a much
    // harder production symptom to trace back to its actual cause.
    if (!process.env.JWT_SECRET) {
      console.error(
        "FATAL: JWT_SECRET is not set. Refusing to start — REST auth and " +
          "Socket.IO auth both depend on this secret being present.",
      );
      process.exit(1);
    }

    await connectDB();
    console.log("✅ Database connected");

    const PORT = Number(process.env.PORT) || 8000;

    const httpServerInstance = serve({
      fetch: app.fetch,
      port: PORT,
    }) as ServerType;

    // Shared with the REST layer's CORS config (app.ts) — see
    // lib/corsOrigins.ts. Previously this layer had its own copy that (a)
    // fell back to "*" instead of a concrete origin when FRONTEND_URL was
    // unset — an invalid combination with credentials:true — and (b) passed
    // a multi-origin FRONTEND_URL through unsplit as a single literal
    // string, silently breaking WebSocket CORS the moment a second origin
    // was configured even though REST kept working fine.
    const allowedOrigins = getAllowedOrigins();

    const io = new SocketIOServer(httpServerInstance as any, {
      cors: {
        origin: allowedOrigins,
        methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
        credentials: true,
      },
      // Prefer WebSocket immediately instead of Engine.IO's default
      // "polling first, then upgrade" sequence. Long-polling's handshake is
      // stateful and pinned to whichever backend instance served the first
      // request — behind a load balancer with no sticky sessions, a
      // polling-mode client can get its subsequent poll routed to a
      // DIFFERENT instance and fail in a way that looks exactly like
      // "connects, then immediately disconnects, reconnect loop." Going
      // straight to WebSocket sidesteps that whole failure class. Polling
      // remains listed as a fallback for the rare client/proxy that
      // genuinely can't do WebSocket.
      transports: ["websocket", "polling"],
      // Tune for production
      pingTimeout: 30_000,
      pingInterval: 25_000,
      connectTimeout: 20_000,
    });

    // ── Socket.IO Redis adapter (horizontal scaling) ──────────────────────────
    if (process.env.REDIS_URL) {
      const pubClient = new Redis(process.env.REDIS_URL);
      const subClient = pubClient.duplicate();
      pubClient.on("error", (err) =>
        console.error("Redis adapter pubClient error:", err),
      );
      subClient.on("error", (err) =>
        console.error("Redis adapter subClient error:", err),
      );
      io.adapter(createAdapter(pubClient, subClient));
      console.log(
        "✅ Socket.IO Redis adapter attached — cross-instance broadcast is active.",
      );
    } else {
      // Loud on purpose: with this unset, the app still starts and looks
      // healthy on a single instance, but the moment this backend runs as
      // more than one instance, events emitted on instance A silently never
      // reach sockets connected to instance B — no error, no crash, just
      // missing realtime delivery for whichever users land on the "other"
      // instance. That failure mode is otherwise nearly impossible to spot
      // from logs alone.
      console.warn(
        "⚠️  REDIS_URL is not set — the Socket.IO Redis adapter is NOT " +
          "attached. Safe for a single backend instance; if this service " +
          "ever runs as 2+ instances, cross-instance realtime broadcast " +
          "will silently fail for users split across instances.",
      );
    }

    setIoInstance(io);

    // ── Socket.IO authentication middleware ───────────────────────────────────
    // Rejections are now logged server-side (they previously were not) —
    // this is the only place that can tell you WHY a given handshake was
    // refused (no token vs. expired vs. bad signature), which matters
    // because a JWT_SECRET mismatch between the frontend (which mints the
    // token) and this backend would otherwise look identical to a client
    // simply not sending one.

    io.use((socket, next) => {
      const token = socket.handshake.auth?.token as string | undefined;
      if (!token) {
        console.warn(`Socket ${socket.id} rejected: no auth token in handshake.`);
        return next(new Error("Unauthorized"));
      }
      verify(token, process.env.JWT_SECRET as string, (err: any, decoded: any) => {
        if (err || !decoded) {
          console.warn(
            `Socket ${socket.id} rejected: ${err?.name || "invalid token"}` +
              (err?.message ? ` — ${err.message}` : ""),
          );
          return next(new Error("Unauthorized"));
        }
        socket.data.userId = decoded.id;
        next();
      });
    });

    // ── Shared state ─────────────────────────────────────────────────────────

    type PresenceStatus = "online" | "idle" | "dnd";

    interface PresenceEntry {
      /** number of connected sockets for this user (multi-tab/device support) */
      count: number;
      status: PresenceStatus;
      /** pending "broadcast offline" timer, cancelled on reconnect within the grace period */
      offlineTimer: ReturnType<typeof setTimeout> | null;
    }

    /** userId → presence entry. Never marks offline immediately — see markOffline. */
    const onlineUsers = new Map<string, PresenceEntry>();

    /** sessionId → set of userIds who have explicitly told the server they
     * consent to transcription for that voice session. In-memory, matching
     * onlineUsers/joinedRooms — a live call's consent state doesn't need to
     * survive a server restart any more than its room membership does.
     * Server-enforced (not just the client-side gate on whether speech
     * recognition runs at all) because a modified client could otherwise
     * emit voice:caption regardless of what its own UI shows. */
    const voiceConsent = new Map<string, Set<string>>();

    /** How long to wait after a user's last socket disconnects before
     * broadcasting them offline. Covers transient network drops, page
     * refreshes, and (now largely eliminated, but kept as defense in depth)
     * a client-side reconnect whose new "connect" hasn't landed yet when the
     * old socket's "disconnect" is processed. */
    const OFFLINE_GRACE_MS = 45_000;

    /** `${roomId}-${userId}` → timeout handle for auto-stop-typing */
    const typingTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

    // ── Helpers ───────────────────────────────────────────────────────────────

    const emitRoomCounts = (roomId: string) => {
      const count = io.sockets.adapter.rooms.get(roomId)?.size ?? 0;
      io.to(roomId).emit("server:member-count", { serverId: roomId, count });
      io.to(roomId).emit("channel:member-count", { channelId: roomId, count });
    };

    // ── Voice session lifecycle ─────────────────────────────────────────────
    // Any server member (owner, admin, mod, or plain member) may join a
    // voice channel's call — this is a participation check, not a structural
    // change, so it deliberately matches voiceSessionController.ts's lax
    // "any role" read-access rule rather than createChannel/updateChannel's
    // admin/mod-only gate.
    const canJoinVoiceChannel = async (
      channelId: string,
      userId: string,
    ): Promise<{ allowed: boolean; transcriptionEnabled: boolean }> => {
      const denied = { allowed: false, transcriptionEnabled: false };
      try {
        const channel = await Channel.findById(channelId)
          .select("server transcriptionEnabled")
          .lean();
        if (!channel) return denied;
        const server = await DiscordServer.findById(channel.server)
          .select("owner")
          .lean();
        if (!server) return denied;
        const transcriptionEnabled = !!channel.transcriptionEnabled;
        if (server.owner.toString() === userId) {
          return { allowed: true, transcriptionEnabled };
        }
        const isMember = !!(await ServerMember.exists({ server: channel.server, user: userId }));
        return { allowed: isMember, transcriptionEnabled };
      } catch (err) {
        console.error("canJoinVoiceChannel error:", err);
        return denied;
      }
    };

    // Cheap in-memory room-size check first (this runs on every disconnect
    // for every room the socket was in, most of which aren't voice channels
    // at all) — only falls through to a DB query on the rare "room just
    // became empty" transition, and even then a non-voice roomId simply
    // finds nothing.
    const startOrJoinVoiceSession = async (
      channelId: string,
      userId: string,
    ): Promise<string | null> => {
      try {
        const roomSize = io.sockets.adapter.rooms.get(channelId)?.size ?? 0;
        if (roomSize <= 1) {
          const existing = await VoiceSession.findOne({
            channel: channelId,
            status: "active",
          });
          if (existing) {
            await VoiceSession.updateOne(
              { _id: existing._id },
              { $addToSet: { participants: userId } },
            );
            return existing._id.toString();
          }
          const channel = await Channel.findById(channelId).lean();
          if (!channel) return null;
          const created = await VoiceSession.create({
            channel: channelId,
            server: channel.server,
            participants: [userId],
            startedAt: new Date(),
            status: "active",
          });
          io.to(channelId).emit("voice:session-started", {
            channelId,
            sessionId: created._id.toString(),
            participantIds: [userId],
          });
          return created._id.toString();
        } else {
          const updated = await VoiceSession.findOneAndUpdate(
            { channel: channelId, status: "active" },
            { $addToSet: { participants: userId } },
            { new: true },
          );
          return updated?._id.toString() ?? null;
        }
      } catch (err) {
        console.error("startOrJoinVoiceSession error:", err);
        return null;
      }
    };

    const endVoiceSessionIfEmpty = async (channelId: string) => {
      try {
        const roomSize = io.sockets.adapter.rooms.get(channelId)?.size ?? 0;
        if (roomSize > 0) return;
        const session = await VoiceSession.findOneAndUpdate(
          { channel: channelId, status: "active" },
          { status: "ended", endedAt: new Date() },
          { new: true },
        );
        if (session) {
          voiceConsent.delete(session._id.toString());
          io.to(channelId).emit("voice:session-ended", {
            channelId,
            sessionId: session._id.toString(),
          });
          // Fire-and-forget: summarization can take several seconds (LLM
          // call + RAG embed/upsert) and must not delay whoever triggered
          // this (a leave/disconnect handler). Failures are handled and
          // logged entirely inside summarizeVoiceSession itself.
          void summarizeVoiceSession(session._id.toString());
        }
      } catch (err) {
        console.error("endVoiceSessionIfEmpty error:", err);
      }
    };

    // ── Voice session summarization (Phase C) ───────────────────────────────
    // Triggered once a session ends (above). Skips entirely — leaving the
    // session at status "ended" — when there's no transcript at all
    // (transcription was never enabled for the channel, no participant's
    // browser supported/consented to it, or nobody spoke): summarizing
    // nothing would either error or produce a hallucinated-sounding response
    // from an empty prompt, neither of which is useful.
    const summarizeVoiceSession = async (sessionId: string) => {
      if (!isChatServiceEnabled()) return;

      try {
        const transcript = await VoiceSessionTranscript.findOne({
          session: sessionId,
        }).lean();
        if (!transcript || transcript.segments.length === 0) return;

        const session = await VoiceSession.findById(sessionId).lean();
        if (!session) return;

        const [channel, server] = await Promise.all([
          Channel.findById(session.channel).lean(),
          DiscordServer.findById(session.server).lean(),
        ]);
        if (!channel || !server) return;

        await VoiceSession.updateOne(
          { _id: sessionId },
          { status: "processing" },
        );

        const speakerIds = Array.from(
          new Set(transcript.segments.map((s) => s.speaker.toString())),
        );
        const users = await User.find({ _id: { $in: speakerIds } })
          .select("name")
          .lean();
        const nameById = new Map(
          users.map((u) => [u._id.toString(), u.name || "Someone"]),
        );

        const isPublic = server.visibility === "public";
        const allowedUserIds = isPublic
          ? []
          : server.members.map((m) => m.user.toString());

        const result = await forwardSummarizeVoiceSession({
          session_id: sessionId,
          channel_id: channel._id.toString(),
          server_id: server._id.toString(),
          channel_name: channel.name,
          server_name: server.name,
          visibility: isPublic ? "public" : "private",
          allowed_user_ids: allowedUserIds,
          participants: [...nameById.values()],
          segments: transcript.segments.map((s) => ({
            sender: nameById.get(s.speaker.toString()) ?? "Someone",
            text: s.text,
          })),
        });

        if (!result) {
          await VoiceSession.updateOne(
            { _id: sessionId },
            { status: "failed" },
          );
          return;
        }

        await VoiceSession.updateOne(
          { _id: sessionId },
          {
            status: "summarized",
            summary: result.summary,
            keyPoints: result.keyPoints,
            actionItems: result.actionItems,
          },
        );

        io.to(session.channel.toString()).emit("voice:summary-ready", {
          channelId: session.channel.toString(),
          sessionId,
          summaryPreview: result.summary.slice(0, 140),
        });

        const recipientIds = session.participants.map((p) => p.toString());
        await Promise.all(
          recipientIds.map(async (recipientId) => {
            const notification = await createNotification({
              recipient: recipientId,
              type: "voice_session_summary",
              title: `Voice session summary ready — #${channel.name}`,
              message: result.summary.slice(0, 140),
              metadata: {
                serverId: server._id.toString(),
                serverName: server.name,
                channelId: channel._id.toString(),
                channelName: channel.name,
                sessionId,
              },
            });
            if (notification) {
              sendNotificationViaSocket(io, recipientId, notification);
            }
          }),
        );
      } catch (err) {
        console.error("summarizeVoiceSession error:", err);
        try {
          await VoiceSession.updateOne(
            { _id: sessionId },
            { status: "failed" },
          );
        } catch {
          /* non-fatal */
        }
      }
    };

    const markOnline = (userId: string) => {
      const entry = onlineUsers.get(userId);
      if (entry) {
        // Another tab/device for the same user, or a reconnect that beat
        // the grace-period timer — cancel any pending offline broadcast.
        if (entry.offlineTimer) {
          clearTimeout(entry.offlineTimer);
          entry.offlineTimer = null;
        }
        entry.count += 1;
        return;
      }
      onlineUsers.set(userId, { count: 1, status: "online", offlineTimer: null });
      io.emit("presence:update", {
        userId,
        online: true,
        status: "online",
        ts: Date.now(),
      });
    };

    const markOffline = (userId: string) => {
      const entry = onlineUsers.get(userId);
      if (!entry) return;
      entry.count = Math.max(0, entry.count - 1);
      if (entry.count > 0) return;

      // Last known socket for this user just disconnected. Don't broadcast
      // offline yet — give them OFFLINE_GRACE_MS to reconnect (refresh,
      // brief network drop) before treating this as a genuine transition.
      if (entry.offlineTimer) clearTimeout(entry.offlineTimer);
      entry.offlineTimer = setTimeout(async () => {
        onlineUsers.delete(userId);
        const lastSeen = new Date();
        io.emit("presence:update", {
          userId,
          online: false,
          ts: lastSeen.getTime(),
          lastSeen: lastSeen.toISOString(),
        });
        try {
          await User.findByIdAndUpdate(userId, { lastSeen });
        } catch (err) {
          console.error("Failed to persist lastSeen on offline:", err);
        }
      }, OFFLINE_GRACE_MS);
    };

    // ── Connection handler ────────────────────────────────────────────────────

    io.on("connection", (socket) => {
      let connectedUserId: string = socket.data.userId as string;
      const joinedRooms = new Set<string>();

      console.log(
        `Socket ${socket.id} connected (user ${connectedUserId}, ` +
          `transport=${socket.conn.transport.name})`,
      );
      // Diagnostic only — confirms whether a connection ever leaves
      // long-polling for a real WebSocket, without changing behavior.
      socket.conn.on("upgrade", (transport) => {
        console.log(`Socket ${socket.id} transport upgraded to ${transport.name}`);
      });

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
          statuses: Object.fromEntries(
            Array.from(onlineUsers.entries()).map(([uid, entry]) => [
              uid,
              entry.status,
            ]),
          ),
          ts: Date.now(),
        });
      } catch {
        /* non-fatal */
      }

      // ── App-level heartbeat ─────────────────────────────────────────────────
      //
      // Socket.IO's own ping/pong (pingInterval/pingTimeout above) already
      // detects dead transports. This exists as an explicit, app-level
      // liveness signal for future analytics/monitoring hooks and as a
      // second line of defense in environments where an intermediary proxy
      // interferes with WS-level control frames but passes data frames.
      socket.on("client:heartbeat", () => {
        /* liveness signal only; no state to update today */
      });

      // ── Self-reported presence status (online/idle/dnd) ─────────────────────
      //
      // Client-driven activity/visibility detection (SocketProvider) reports
      // "online"/"idle"; a manual "Do Not Disturb" toggle (not yet wired to
      // any UI) can report "dnd" through the same channel. This never
      // affects the online/offline connection-count bookkeeping above —
      // only the status shown alongside "online".
      socket.on(
        "presence:self-status",
        (data: { status: PresenceStatus }) => {
          try {
            const entry = onlineUsers.get(connectedUserId);
            if (!entry) return;
            if (!["online", "idle", "dnd"].includes(data?.status)) return;
            if (entry.status === data.status) return;
            entry.status = data.status;
            io.emit("presence:update", {
              userId: connectedUserId,
              online: true,
              status: entry.status,
              ts: Date.now(),
            });
          } catch {
            /* non-fatal */
          }
        },
      );

      // ── Room joins ──────────────────────────────────────────────────────────

      socket.on("join-server", async (roomId: string) => {
        try {
          if (!roomId) return;
          // A private/invite-only server's real-time events (moderation
          // actions, membership changes, settings updates) must not reach a
          // socket that just requests the room by id — any connected client
          // used to be able to join any server's room and passively receive
          // those events. Public servers stay open to anyone (their info is
          // already visible via search/browse).
          const server = await DiscordServer.findById(roomId)
            .select("owner visibility")
            .lean();
          if (!server) return;
          const isAllowed =
            server.visibility === "public" ||
            server.owner?.toString() === connectedUserId ||
            (await ServerMember.exists({ server: roomId, user: connectedUserId }));
          if (!isAllowed) {
            console.warn(
              `join-server denied: user ${connectedUserId} is not a member of server ${roomId}`,
            );
            return;
          }
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
        // `userId` is deliberately NOT read from the client payload here —
        // every other handler in this file uses connectedUserId (the
        // JWT-verified identity from the handshake); trusting a
        // client-supplied userId would let a modified client impersonate
        // anyone in session participant tracking, notifications, and the
        // RAG-indexed transcript's speaker attribution.
        async ({ channelId }: { channelId: string }) => {
          try {
            const { allowed, transcriptionEnabled } = await canJoinVoiceChannel(
              channelId,
              connectedUserId,
            );
            if (!allowed) {
              socket.emit("webrtc:join-denied", { channelId });
              return;
            }
            socket.join(channelId);
            joinedRooms.add(channelId);
            io.to(channelId).emit("webrtc:user-joined", { userId: connectedUserId });
            const sessionId = await startOrJoinVoiceSession(channelId, connectedUserId);
            // Told only to the joining socket (not broadcast) — this is how
            // a client learns which session its own captions belong to,
            // whether it just started the session or joined an existing one.
            if (sessionId) {
              socket.emit("voice:session-active", { channelId, sessionId });
            }
            // Fire-and-forget: absorb a Render free-tier cold start on the
            // chat-service NOW, in the background, while the user still has
            // to click through the consent banner before any real audio
            // chunk is sent — see warmChatService's own comment for why this
            // is what actually fixes "captions keep failing" in production
            // (forwardTranscribeAudio's per-chunk budget is deliberately too
            // tight to survive a cold start on its own).
            if (transcriptionEnabled && isChatServiceEnabled()) {
              void warmChatService();
            }
          } catch {
            /* non-fatal */
          }
        },
      );

      socket.on(
        "webrtc:leave",
        async ({ channelId }: { channelId: string }) => {
          try {
            socket.leave(channelId);
            joinedRooms.delete(channelId);
            io.to(channelId).emit("webrtc:user-left", { userId: connectedUserId });
            await endVoiceSessionIfEmpty(channelId);
          } catch {
            /* non-fatal */
          }
        },
      );

      // Pure SDP/ICE relay — but each still needs two checks the previous
      // version skipped: (1) the sender must actually be a member of the
      // target room (otherwise a socket that never passed webrtc:join's
      // permission gate could inject signaling into any room just by
      // knowing its channelId), and (2) `from` is server-stamped rather
      // than trusted from the payload, for the same impersonation reason
      // as webrtc:join above.
      socket.on("webrtc:offer", (data: any) => {
        try {
          if (!data?.channelId || !socket.rooms.has(data.channelId)) return;
          io.to(data.channelId).emit("webrtc:offer", { ...data, from: connectedUserId });
        } catch {
          /* */
        }
      });
      socket.on("webrtc:answer", (data: any) => {
        try {
          if (!data?.channelId || !socket.rooms.has(data.channelId)) return;
          io.to(data.channelId).emit("webrtc:answer", { ...data, from: connectedUserId });
        } catch {
          /* */
        }
      });
      socket.on("webrtc:ice-candidate", (data: any) => {
        try {
          if (!data?.channelId || !socket.rooms.has(data.channelId)) return;
          io.to(data.channelId).emit("webrtc:ice-candidate", { ...data, from: connectedUserId });
        } catch {
          /* */
        }
      });

      // Purely informational (no SDP/track data here — that's replaced
      // directly peer-to-peer via RTCRtpSender.replaceTrack, see
      // useWebRTC.ts) — this just tells everyone else in the room whose
      // video tile is now a screen share, for the "X is sharing" UI.
      socket.on("webrtc:screen-share-started", (data: any) => {
        try {
          if (!data?.channelId || !socket.rooms.has(data.channelId)) return;
          io.to(data.channelId).emit("webrtc:screen-share-started", {
            channelId: data.channelId,
            userId: connectedUserId,
          });
        } catch {
          /* */
        }
      });
      socket.on("webrtc:screen-share-stopped", (data: any) => {
        try {
          if (!data?.channelId || !socket.rooms.has(data.channelId)) return;
          io.to(data.channelId).emit("webrtc:screen-share-stopped", {
            channelId: data.channelId,
            userId: connectedUserId,
          });
        } catch {
          /* */
        }
      });

      // ── Voice live captions / transcript capture ────────────────────────────
      // Client-side speech recognition (see VoiceVideoChannel.tsx) emits
      // interim results (isFinal: false, for the live caption overlay only —
      // not persisted) and final results (isFinal: true — relayed AND
      // appended to this session's transcript). There is no server-side
      // audio access at all in this peer-to-peer WebRTC setup, so
      // transcription only exists where the browser's own recognition API
      // is available; this handler just relays/persists text, never audio.
      // Explicit, server-tracked opt-in — sent once by the client when the
      // user clicks "Enable captions for me" (see VoiceVideoChannel.tsx).
      // voice:caption below refuses to relay or persist anything for a
      // speaker who hasn't sent this for the given session, so consent is
      // enforced here rather than trusted from client-side UI state alone.
      socket.on("voice:consent", ({ sessionId }: { sessionId: string }) => {
        if (!sessionId) return;
        if (!voiceConsent.has(sessionId)) voiceConsent.set(sessionId, new Set());
        voiceConsent.get(sessionId)!.add(connectedUserId);
      });

      socket.on(
        "voice:caption",
        // `speakerId` is server-stamped from connectedUserId, not read from
        // the payload — this is the identity that ends up permanently
        // attributed to a FINAL transcript segment, and is what the consent
        // check below is keyed on, so it must be trustworthy, not
        // client-supplied.
        async (data: { channelId: string; sessionId: string; text: string; isFinal: boolean }) => {
          try {
            const { channelId, sessionId, text, isFinal } = data;
            if (!text?.trim()) return;
            // No consent on file for this speaker/session → drop entirely,
            // both the live relay and persistence. A non-consenting
            // participant's own words never leave their device via this
            // path, regardless of what a (possibly modified) client sends.
            if (!voiceConsent.get(sessionId)?.has(connectedUserId)) return;

            const payload = { channelId, sessionId, speakerId: connectedUserId, text, isFinal };
            socket.to(channelId).emit("voice:caption", payload);
            if (!isFinal) return;

            await VoiceSessionTranscript.updateOne(
              { session: sessionId },
              {
                $push: {
                  segments: { speaker: connectedUserId, text, timestamp: new Date() },
                },
              },
              { upsert: true },
            );
          } catch (err) {
            console.error("voice:caption persist error:", err);
          }
        },
      );

      // Server-side transcription (Groq Whisper via the chat-service) — the
      // ACTUAL captioning path now; voice:caption above is kept only as a
      // relay/persist primitive this handler reuses, not because any client
      // still does its own browser-side speech recognition. This replaced
      // that browser-side approach entirely: the Web Speech API only exists
      // in Chromium browsers, requires (and silently fails without) live
      // network access to Google's speech backend — confirmed in production
      // to fail in e.g. Brave with that access blocked by default — whereas
      // this path only depends on this server reaching the chat-service.
      socket.on(
        "voice:audio-chunk",
        async (
          data: { channelId: string; sessionId: string; audio: string; mimeType: string },
          // Socket.IO acknowledgement — lets the client tell "chunk
          // transcribed to nothing because nobody was talking" (ok, no
          // problem) apart from "the chat-service call itself failed"
          // (client can surface that after a few in a row), which a plain
          // fire-and-forget emit can't distinguish.
          ack?: (res: { ok: boolean }) => void,
        ) => {
          let ok = false;
          try {
            const { channelId, sessionId, audio, mimeType } = data;
            if (!channelId || !sessionId || !audio) return;
            // Same consent gate as voice:caption — a non-consenting
            // participant's audio never leaves the drop-here point below,
            // regardless of what a modified client might send.
            if (!voiceConsent.get(sessionId)?.has(connectedUserId)) {
              ok = true; // not an error condition, just not opted in
              return;
            }
            if (!isChatServiceEnabled()) return;

            const result = await forwardTranscribeAudio(connectedUserId, {
              audio_base64: audio,
              mime_type: mimeType || "audio/webm",
            });
            if (result === null) return; // the chat-service call itself failed
            ok = true;
            const text = result.text?.trim();
            if (!text) return;

            // Whisper transcribes a whole chunk at once — there is no
            // "interim" concept the way browser speech recognition has, so
            // every result here is final: relay AND persist, same as
            // voice:caption's isFinal branch. Unlike voice:caption above
            // (socket.to, not io.to — deliberately excludes the sender,
            // because that client-side approach already knew its own text
            // instantly from the browser's own recognition), the SPEAKER
            // here doesn't know the text until this comes back from
            // Whisper, so this one goes to io.to — everyone in the room,
            // including the speaker themselves.
            const payload = { channelId, sessionId, speakerId: connectedUserId, text, isFinal: true };
            io.to(channelId).emit("voice:caption", payload);
            await VoiceSessionTranscript.updateOne(
              { session: sessionId },
              {
                $push: {
                  segments: { speaker: connectedUserId, text, timestamp: new Date() },
                },
              },
              { upsert: true },
            );
          } catch (err) {
            console.error("voice:audio-chunk transcribe error:", err);
          } finally {
            ack?.({ ok });
          }
        },
      );

      // ── 1:1 DM voice/video calling ───────────────────────────────────────────
      // Ring/accept/reject/cancel/end lifecycle lives in lib/dmCallService.ts —
      // these handlers are thin wrappers supplying the server-verified
      // connectedUserId (never trusted from the payload, same reasoning as
      // every webrtc:* handler above). Once call:accept fires, the service
      // module puts exactly the two right sockets in a room named by the
      // callId; from there the EXISTING webrtc:offer/answer/ice-candidate
      // handlers above carry the actual peer connection, unchanged.
      socket.on("call:invite", (data) => {
        void inviteDMCall(io, socket, connectedUserId, data);
      });
      socket.on("call:accept", (data) => {
        void acceptDMCall(io, socket, connectedUserId, data);
      });
      socket.on("call:reject", (data) => {
        void rejectDMCall(io, connectedUserId, data);
      });
      socket.on("call:cancel", (data) => {
        void cancelDMCall(io, connectedUserId, data);
      });
      socket.on("call:end", (data) => {
        void endDMCall(io, connectedUserId, data);
      });
      // Each side reports readiness once ITS OWN getUserMedia() resolves —
      // see dmCallService.ts's mediaReady for why webrtc:user-joined waits
      // for both rather than firing immediately at accept time.
      socket.on("call:media-ready", (data) => {
        void mediaReadyDMCall(io, connectedUserId, data);
      });

      // ── Disconnect ──────────────────────────────────────────────────────────

      socket.on("disconnect", (reason) => {
        try {
          console.log(
            `Socket ${socket.id} (user ${connectedUserId}) disconnected: ${reason}`,
          );
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
              // Best-effort: ends the voice session if this was the last
              // participant in a Voice channel and they disconnected (tab
              // close, crash, network drop) without an explicit
              // webrtc:leave. No-ops for every non-voice room — it's just a
              // findOneAndUpdate that matches nothing.
              void endVoiceSessionIfEmpty(roomId);
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
