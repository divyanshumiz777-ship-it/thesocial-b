import { Context } from "hono";
import { getIoInstance } from "../config/socket.ts";

// Called from a `pagehide` listener via `fetch(..., { keepalive: true })` —
// the one signal that reliably survives an abrupt tab/browser close, unlike
// a normal fetch which the browser can abort mid-flight once the page is
// gone. sendBeacon can't carry an Authorization header, which is why this
// is a keepalive fetch instead (see socketManager.ts's pagehide listener).
//
// Forcibly disconnecting the user's own socket(s) — rather than reaching
// into onlineUsers/markOffline directly — reuses the existing, already
// battle-tested disconnect pipeline (server.ts's socket.on("disconnect", ...))
// instead of duplicating its bookkeeping (typing-timeout cleanup, room
// counts, voice/group-call teardown) here. That handler special-cases the
// "server namespace disconnect" reason this produces to skip the normal
// 45s offline grace period, matching the explicit user:logout signal.
// Scoped to the ONE socket that is actually going away, when the client tells
// us which. `in(userId).disconnectSockets(true)` killed EVERY socket the user
// had — so closing or navigating away in any one tab tore down a call running
// in a DIFFERENT tab, and on a phone browser simply backgrounding the page did
// the same to the call in it. Presence stays correct because server.ts's
// markOffline is refcounted per socket: it decrements and returns early while
// the user still has others connected, and finalizes only on the last one.
export const markSelfOffline = async (c: Context) => {
  const userId = c.get("user").id;
  let socketId: string | undefined;
  try {
    const body = await c.req.json().catch(() => ({}));
    socketId = body?.socketId;
  } catch {
    /* no body — fall through to the legacy path below */
  }

  try {
    const io = getIoInstance();
    if (socketId) {
      // Every socket is in a room named after its own id, and this goes
      // through the adapter so it still works across replicas. Ownership is
      // verified first: without that check any authenticated user could
      // disconnect any other user's socket just by guessing its id.
      const [target] = await io.in(socketId).fetchSockets();
      if (!target || !target.rooms.has(userId)) {
        return c.json({ success: true });
      }
      io.in(socketId).disconnectSockets(true);
    }
    // No socketId (an older client): deliberately do NOT disconnect anything.
    // The 45s presence grace period and the socket's own ping timeout still
    // mark them offline shortly after; that is a far better failure mode than
    // dropping every session this user has, calls included.
  } catch (err) {
    // Best-effort — if Socket.IO isn't up, the ping-timeout/grace-period
    // fallback still eventually marks them offline, just not instantly.
    console.error("markSelfOffline: failed to disconnect socket:", err);
  }
  return c.json({ success: true });
};
