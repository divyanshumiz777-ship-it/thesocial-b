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
export const markSelfOffline = async (c: Context) => {
  const userId = c.get("user").id;
  try {
    getIoInstance().in(userId).disconnectSockets(true);
  } catch (err) {
    // Best-effort — if Socket.IO isn't up, the ping-timeout/grace-period
    // fallback still eventually marks them offline, just not instantly.
    console.error("markSelfOffline: failed to disconnect sockets:", err);
  }
  return c.json({ success: true });
};
