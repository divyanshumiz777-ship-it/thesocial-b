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
 * after ~15 minutes idle and can take 20-45s to cold-start (Mongo + Redis +
 * Qdrant client init). The original 8s/5s/3s budgets were sized for a warm
 * instance only, so the very first request after any idle period reliably
 * timed out with zero retry — the exact "AI assistant is temporarily
 * unavailable" 503 users hit. Raised generously enough to ride out a cold
 * start in a single attempt; a warm instance still responds in well under
 * these ceilings, so this doesn't add latency to the common case. One retry
 * added as defense-in-depth for a genuinely transient failure (matches the
 * pattern already used for the recommendation service).
 */
const CHAT_TIMEOUT_MS = 45_000;
const SEARCH_TIMEOUT_MS = 30_000;
const CONV_TIMEOUT_MS = 20_000;
const COLD_START_RETRIES = 1;

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
      retries: COLD_START_RETRIES,
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
      retries: COLD_START_RETRIES,
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
    { method: "GET", userId, timeoutMs: CONV_TIMEOUT_MS, retries: COLD_START_RETRIES }
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
    { method: "GET", userId, timeoutMs: CONV_TIMEOUT_MS, retries: COLD_START_RETRIES }
  );
  return result.ok && result.data ? result.data : null;
}

export async function forwardGetCapabilities(
  userId: string
): Promise<CapabilitiesResponse | null> {
  const result = await callInternalService<CapabilitiesResponse>(
    CHAT_URL,
    "/internal/v1/capabilities",
    { method: "GET", userId, timeoutMs: CONV_TIMEOUT_MS, retries: COLD_START_RETRIES }
  );
  return result.ok && result.data ? result.data : null;
}
