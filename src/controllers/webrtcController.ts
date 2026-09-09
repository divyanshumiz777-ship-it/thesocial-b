import { Context } from "hono";

// Cloudflare Realtime issues short-lived TURN credentials via API call
// rather than one static username/password — this is the recommended
// architecture (see dashboard.cloudflare.com → Realtime → Calls App "How to
// create credentials"), and keeps CLOUDFLARE_TURN_API_TOKEN server-side only.
// Callers (mobile's useWebRTC.ts, and eventually the web equivalent) fetch a
// fresh set of iceServers right before creating a peer connection.
const CLOUDFLARE_TURN_TTL_SECONDS = 86_400; // 24h — comfortably covers any single call/session

// The fetch below had NO timeout of its own, so a slow or unresponsive
// Cloudflare API held this request open indefinitely: the caller (mobile's
// fetchIceServers) gave up on its own deadline and downgraded the call to
// STUN-only, while this handler stayed parked on a socket that would never
// produce anything useful. Cap it well INSIDE the client's 8s budget so a
// stalled upstream returns a fast, explicit "no TURN available" instead of
// being indistinguishable from a dead backend.
const CLOUDFLARE_FETCH_TIMEOUT_MS = 6_000;

export const getTurnCredentials = async (c: Context) => {
  const keyId = process.env.CLOUDFLARE_TURN_KEY_ID;
  const apiToken = process.env.CLOUDFLARE_TURN_API_TOKEN;

  if (!keyId || !apiToken) {
    // No TURN configured — client falls back to its own STUN-only default
    // rather than erroring the whole call setup.
    return c.json({ iceServers: [] });
  }

  try {
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ttl: CLOUDFLARE_TURN_TTL_SECONDS }),
        signal: AbortSignal.timeout(CLOUDFLARE_FETCH_TIMEOUT_MS),
      },
    );
    if (!res.ok) {
      console.error(`getTurnCredentials: Cloudflare returned ${res.status}`, await res.text());
      return c.json({ iceServers: [] });
    }
    const data = await res.json();
    console.log(`getTurnCredentials: fetched ${data.iceServers?.length ?? 0} ICE server entries from Cloudflare`);
    return c.json({ iceServers: data.iceServers ?? [] });
  } catch (err) {
    console.error("getTurnCredentials: request to Cloudflare failed:", err);
    return c.json({ iceServers: [] });
  }
};
