/**
 * Chat service client (Hono gateway → AI Chat Service).
 *
 * Thin typed wrapper over the shared callInternalService transport (timeout,
 * circuit breaker, X-Internal-Token + X-User-Id headers, never throws).
 *
 * Hono is a PURE GATEWAY here: it never calls Qdrant, never calls Gemini, and
 * never generates response text itself. Every function simply forwards the
 * request and returns the chat service's response verbatim, or null on failure.
 */

import { callInternalService, aiServiceConfig } from "./aiServiceClient.ts";

const CHAT_URL = aiServiceConfig.chatUrl;

/**
 * The chat service runs on Render's free tier, which spins the instance down
 * after ~15 minutes idle. A cold start has been observed in production in TWO
 * distinct shapes, and a robust config has to survive both:
 *
 *   1. FAST-502: Render's edge instantly rejects with a ~200ms 502 while the
 *      instance is spun down. Each attempt fails near-instantly, so the
 *      per-attempt timeout is irrelevant here — what rides this out is
 *      RETRIES with backoff spaced far enough apart that a later attempt
 *      lands after the boot completes.
 *
 *   2. HANG: Render's edge instead HOLDS the request open during boot and
 *      only responds once the service is ready. Here the binding constraint
 *      is the per-attempt TIMEOUT — a short timeout aborts the held request
 *      mid-boot (well before the ~32s+ boot finishes) and no amount of
 *      retrying helps, because every attempt gets killed before the service
 *      can answer. Confirmed from a production log where 10-15s timeouts
 *      aborted every attempt across ~100s while a direct /health check on
 *      the same instance answered in ~1s once warm, and the internal
 *      endpoints returned full data once warm — i.e. not a service bug, just
 *      a boot slower than the timeout.
 *
 * So: a GENEROUS per-attempt timeout (rides out a held request through cold
 * boot in a single attempt — mode 2) PLUS retries with backoff (spans the
 * boot when attempts fast-fail — mode 1). Cold-boot duration is a property
 * of the SERVICE, not the endpoint, so the timeout is uniform across all
 * endpoints rather than differentiated — a warm capabilities/search/conv
 * call still returns in a few seconds; the 60s is only the ceiling for the
 * cold-boot-held case. The circuit breaker in aiServiceClient.ts caps the
 * aggregate cost if the service is genuinely down (opens after 8 failures).
 *
 * RETRIES=2 (~30s total backoff: 10s + 20s) was observed in production to be
 * too short for a fast-502 cold start (Render's edge instantly rejecting
 * while the instance is spun down) — all 3 attempts failed within the ~30s
 * window while the instance was still booting, matching this module's own
 * documented "~20-40s typical, up to ~100s observed" boot range. RETRIES=3
 * extends the fast-502 survival window to ~60s (10s + 20s + 30s), covering
 * the typical case with real margin without stretching a synchronous
 * request out to the full ~100s worst case.
 */
const REQUEST_TIMEOUT_MS = 60_000;
const RETRIES = 3;
const RETRY_DELAY_MS = 10_000;

// ── Response type definitions ─────────────────────────────────────────────────

export interface ChatCitation {
  id: string;
  source_type: string;
  source_id: string;
  title: string;
  score: number;
  metadata: Record<string, unknown>;
}

export interface ChatResponse {
  answer: string;
  citations: ChatCitation[];
  intent?: string;
}

export interface SearchResponse {
  results: ChatCitation[];
}

export interface ConversationSummary {
  id: string;
  title?: string;
  created_at: string;
  updated_at: string;
}

export interface ConversationsResponse {
  conversations: ConversationSummary[];
}

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations?: ChatCitation[];
  created_at: string;
}

export interface ConversationResponse {
  id: string;
  messages: ConversationMessage[];
}

export interface CapabilityDef {
  name: string;
  label: string;
  icon: string;
  category: string;
  command: string;
  description: string;
  aliases: string[];
  slash: string[];
  examples: string[];
}

export interface CapabilitiesResponse {
  capabilities: CapabilityDef[];
}

export interface VoiceSessionSummaryResponse {
  summary: string;
  keyPoints: string[];
  actionItems: string[];
}

export interface TranscribeAudioResponse {
  text: string;
}

// ── Feature flag ──────────────────────────────────────────────────────────────

export function isChatServiceEnabled(): boolean {
  return Boolean(CHAT_URL) && Boolean(process.env.INTERNAL_SERVICE_TOKEN);
}

// ── Typed forwarding helpers ──────────────────────────────────────────────────

export async function forwardChat(
  userId: string,
  body: { message: string; conversation_id?: string }
): Promise<ChatResponse | null> {
  const result = await callInternalService<ChatResponse>(
    CHAT_URL,
    "/internal/v1/chat",
    {
      method: "POST",
      body: { user_id: userId, ...body },
      userId,
      timeoutMs: REQUEST_TIMEOUT_MS,
      retries: RETRIES,
      retryDelayMs: RETRY_DELAY_MS,
    }
  );
  return result.ok && result.data ? result.data : null;
}

export async function forwardSearch(
  userId: string,
  body: { query: string; types?: string[] }
): Promise<SearchResponse | null> {
  const result = await callInternalService<SearchResponse>(
    CHAT_URL,
    "/internal/v1/search",
    {
      method: "POST",
      body: { user_id: userId, ...body },
      userId,
      timeoutMs: REQUEST_TIMEOUT_MS,
      retries: RETRIES,
      retryDelayMs: RETRY_DELAY_MS,
    }
  );
  return result.ok && result.data ? result.data : null;
}

export async function forwardGetConversations(
  userId: string
): Promise<ConversationsResponse | null> {
  const result = await callInternalService<ConversationsResponse>(
    CHAT_URL,
    "/internal/v1/conversations",
    { method: "GET", userId, timeoutMs: REQUEST_TIMEOUT_MS, retries: RETRIES, retryDelayMs: RETRY_DELAY_MS }
  );
  return result.ok && result.data ? result.data : null;
}

export async function forwardGetConversation(
  userId: string,
  conversationId: string
): Promise<ConversationResponse | null> {
  const result = await callInternalService<ConversationResponse>(
    CHAT_URL,
    `/internal/v1/conversations/${conversationId}`,
    { method: "GET", userId, timeoutMs: REQUEST_TIMEOUT_MS, retries: RETRIES, retryDelayMs: RETRY_DELAY_MS }
  );
  return result.ok && result.data ? result.data : null;
}

export async function forwardGetCapabilities(
  userId: string
): Promise<CapabilitiesResponse | null> {
  const result = await callInternalService<CapabilitiesResponse>(
    CHAT_URL,
    "/internal/v1/capabilities",
    { method: "GET", userId, timeoutMs: REQUEST_TIMEOUT_MS, retries: RETRIES, retryDelayMs: RETRY_DELAY_MS }
  );
  return result.ok && result.data ? result.data : null;
}

// No `userId` forwarded (no X-User-Id) — this summarizes a session on behalf
// of all its participants, not a single querying user; the chat-service
// endpoint doesn't read that header. ACL for later retrieval comes from
// `allowedUserIds`, enforced the same way as every other RAG content type.
// Best-effort, fire-and-forget from every call site — the Mongo delete has
// already committed by the time this is called; a failure here only means
// the deleted content keeps surfacing through search/the assistant a while
// longer; it never blocks or reverts the actual delete operation.
export async function forwardDeleteContent(
  scope: "server" | "channel" | "source",
  id: string,
  sourceType?: string,
): Promise<boolean> {
  const result = await callInternalService<{ status: string }>(
    CHAT_URL,
    "/internal/v1/delete",
    {
      method: "POST",
      body: { scope, id, source_type: sourceType },
      timeoutMs: REQUEST_TIMEOUT_MS,
      retries: RETRIES,
      retryDelayMs: RETRY_DELAY_MS,
    }
  );
  return result.ok;
}

// Live captions get a chunk roughly every few seconds for the length of a
// call — this is a continuous, LOSSY stream (missing one chunk just means
// one ~4s window of speech never got captioned, not a broken call), so it
// deliberately does NOT use the cold-start-survival timeout/retry budget
// every other forwarder in this file uses. A single slow/failed chunk
// should drop and let the next one (already on its way regardless) carry
// on, rather than piling up multiple in-flight 60s-timeout retries against
// a possibly-cold instance while new chunks keep arriving every few seconds.
const TRANSCRIBE_TIMEOUT_MS = 12_000;
const TRANSCRIBE_RETRIES = 0;

export async function forwardTranscribeAudio(
  userId: string,
  body: { audio_base64: string; mime_type: string }
): Promise<TranscribeAudioResponse | null> {
  const result = await callInternalService<TranscribeAudioResponse>(
    CHAT_URL,
    "/internal/v1/voice/transcribe-chunk",
    {
      method: "POST",
      body,
      userId,
      timeoutMs: TRANSCRIBE_TIMEOUT_MS,
      retries: TRANSCRIBE_RETRIES,
    }
  );
  return result.ok && result.data ? result.data : null;
}

// Fires the instant someone joins a Voice/Video channel that has
// transcription enabled (see server.ts's webrtc:join handler) — well before
// the consent banner is even shown, let alone before any real audio chunk
// exists to send. Deliberately uses the FULL cold-start-survival budget
// (unlike forwardTranscribeAudio above): this call's entire purpose is to
// absorb a Render free-tier cold boot (~20-100s, see this file's top
// comment) in the background while the user is still clicking through the
// join/consent UI, so that by the time the first real caption chunk goes
// out, the instance is already warm and lands well inside
// TRANSCRIBE_TIMEOUT_MS's tight budget instead of racing a cold start with
// zero retries. Fire-and-forget from the caller — a failed warm-up isn't
// itself an error, it just means the first real chunk has to ride out the
// cold start on its own, exactly as it would have without this.
export async function warmChatService(): Promise<void> {
  await callInternalService(CHAT_URL, "/internal/v1/ping", {
    method: "GET",
    timeoutMs: REQUEST_TIMEOUT_MS,
    retries: RETRIES,
    retryDelayMs: RETRY_DELAY_MS,
  });
}

export async function forwardSummarizeVoiceSession(body: {
  session_id: string;
  channel_id: string;
  server_id: string;
  channel_name: string;
  server_name: string;
  visibility: "public" | "private";
  allowed_user_ids: string[];
  participants: string[];
  segments: Array<{ sender: string; text: string }>;
}): Promise<VoiceSessionSummaryResponse | null> {
  const result = await callInternalService<VoiceSessionSummaryResponse>(
    CHAT_URL,
    "/internal/v1/voice/summarize",
    {
      method: "POST",
      body,
      timeoutMs: REQUEST_TIMEOUT_MS,
      retries: RETRIES,
      retryDelayMs: RETRY_DELAY_MS,
    }
  );
  return result.ok && result.data ? result.data : null;
}

export interface ModerationTriageResponse {
  severity: "low" | "medium" | "high";
  suggestedAction: "none" | "warn" | "mute" | "ban" | "escalate";
  rationale: string;
}

// Fire-and-forget from reportController.ts right after a report is created —
// this only ever prioritizes the admin queue (severity/suggested action),
// never gates or auto-actions the report itself. A null return (chat-service
// down, cold start, etc.) just means the report stays untriaged.
export async function forwardModerationTriage(body: {
  reason: string;
  details?: string;
  content_type?: string;
  snippet?: string;
}): Promise<ModerationTriageResponse | null> {
  const result = await callInternalService<ModerationTriageResponse>(
    CHAT_URL,
    "/internal/v1/moderation/triage",
    {
      method: "POST",
      body,
      timeoutMs: REQUEST_TIMEOUT_MS,
      retries: RETRIES,
      retryDelayMs: RETRY_DELAY_MS,
    }
  );
  return result.ok && result.data ? result.data : null;
}

export interface CatchMeUpResponse {
  digest: string;
  since: string;
  totalMessageCount: number;
  totalMentionCount: number;
  servers: Array<{
    serverId: string;
    serverName: string;
    messageCount: number;
    mentionCount: number;
    topChannel: string | null;
  }>;
}

export async function forwardCatchMeUpDigest(
  userId: string,
  since: string
): Promise<CatchMeUpResponse | null> {
  const result = await callInternalService<CatchMeUpResponse>(
    CHAT_URL,
    "/internal/v1/digest/catch-me-up",
    {
      method: "POST",
      body: { since },
      userId,
      timeoutMs: REQUEST_TIMEOUT_MS,
      retries: RETRIES,
      retryDelayMs: RETRY_DELAY_MS,
    }
  );
  return result.ok && result.data ? result.data : null;
}

export interface ReelCaptionsResponse {
  vtt: string;
}

// Fire-and-forget from reelController.ts right after a reel is created — a
// null return just means the reel stays without captions; it never blocks
// or retries reel creation. Downloading + transcribing a full video takes
// longer than a warm chat/search call, so this reuses the same cold-start-
// survival budget as every other non-latency-sensitive forwarder in this file.
export async function forwardGenerateReelCaptions(
  videoUrl: string
): Promise<ReelCaptionsResponse | null> {
  const result = await callInternalService<ReelCaptionsResponse>(
    CHAT_URL,
    "/internal/v1/reels/generate-captions",
    {
      method: "POST",
      body: { video_url: videoUrl },
      timeoutMs: REQUEST_TIMEOUT_MS,
      retries: RETRIES,
      retryDelayMs: RETRY_DELAY_MS,
    }
  );
  return result.ok && result.data ? result.data : null;
}
