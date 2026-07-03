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
 * Timeouts tuned per operation — chat waits longer for Gemini generation.
 *
 * The chat service runs on Render's free tier, which spins the instance down
 * after ~15 minutes idle. Measured directly against production: a cold
 * instance took 32s to answer its OWN /health check, and a fast ~200ms 502
 * (from Render's edge, not a hang) is what callers actually see while it's
 * still booting — confirmed from production logs. That means a longer
 * per-attempt timeout does nothing here (each attempt already returns near-
 * instantly, just with an error status); what survives a cold start is
 * retrying with backoff SPACED far enough apart to land an attempt after
 * the boot finishes. Timeouts below are just a safety ceiling per attempt;
 * retryDelayMs is what actually rides out the cold start.
 */
const CHAT_TIMEOUT_MS = 15_000;
const SEARCH_TIMEOUT_MS = 12_000;
const CONV_TIMEOUT_MS = 10_000;

/** retries=3 + retryDelayMs=10s → backoff of 10s/20s/30s (60s cumulative
 * worst case across 4 attempts) — comfortably spans the observed 32s cold
 * boot, so at least one attempt lands after the instance is warm. Chat gets
 * the full budget since users already expect to wait for an AI answer;
 * search/capabilities/conversations get a shorter one since they back
 * lighter-weight UI surfaces. */
const CHAT_RETRIES = 3;
const CHAT_RETRY_DELAY_MS = 10_000;
const LIGHT_RETRIES = 2;
const LIGHT_RETRY_DELAY_MS = 8_000;

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
      timeoutMs: CHAT_TIMEOUT_MS,
      retries: CHAT_RETRIES,
      retryDelayMs: CHAT_RETRY_DELAY_MS,
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
      timeoutMs: SEARCH_TIMEOUT_MS,
      retries: LIGHT_RETRIES,
      retryDelayMs: LIGHT_RETRY_DELAY_MS,
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
    { method: "GET", userId, timeoutMs: CONV_TIMEOUT_MS, retries: LIGHT_RETRIES, retryDelayMs: LIGHT_RETRY_DELAY_MS }
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
    { method: "GET", userId, timeoutMs: CONV_TIMEOUT_MS, retries: LIGHT_RETRIES, retryDelayMs: LIGHT_RETRY_DELAY_MS }
  );
  return result.ok && result.data ? result.data : null;
}

export async function forwardGetCapabilities(
  userId: string
): Promise<CapabilitiesResponse | null> {
  const result = await callInternalService<CapabilitiesResponse>(
    CHAT_URL,
    "/internal/v1/capabilities",
    { method: "GET", userId, timeoutMs: CONV_TIMEOUT_MS, retries: LIGHT_RETRIES, retryDelayMs: LIGHT_RETRY_DELAY_MS }
  );
  return result.ok && result.data ? result.data : null;
}
