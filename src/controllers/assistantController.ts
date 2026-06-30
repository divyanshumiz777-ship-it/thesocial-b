/**
 * Assistant controller — pure gateway.
 *
 * Each handler: verify auth → validate input → forward to chat service →
 * return the service response verbatim. Hono never generates response text,
 * never calls Qdrant, never calls Gemini. All AI logic lives in the chat service.
 */

import { Context } from "hono";
import {
  isChatServiceEnabled,
  forwardChat,
  forwardSearch,
  forwardGetConversations,
  forwardGetConversation,
  forwardGetCapabilities,
} from "../lib/chatServiceClient.ts";
import logger from "../lib/logger.ts";

interface JwtUser {
  id: string;
  email: string;
}

function getUser(c: Context): JwtUser | null {
  return (c.get("user") as JwtUser) ?? null;
}

// ── POST /api/v1/assistant/chat ───────────────────────────────────────────────

export async function handleChat(c: Context) {
  const user = getUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  if (!isChatServiceEnabled()) {
    return c.json({ error: "AI assistant is not available" }, 503);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    return c.json({ error: "message is required" }, 400);
  }

  const conversationId =
    typeof body.conversationId === "string" ? body.conversationId : undefined;

  const result = await forwardChat(user.id, {
    message,
    conversation_id: conversationId,
  });

  if (!result) {
    return c.json({ error: "AI assistant is temporarily unavailable" }, 503);
  }

  return c.json(result, 200);
}

// ── POST /api/v1/assistant/search ─────────────────────────────────────────────

export async function handleSearch(c: Context) {
  const user = getUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  if (!isChatServiceEnabled()) {
    return c.json({ error: "AI assistant is not available" }, 503);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) {
    return c.json({ error: "query is required" }, 400);
  }

  const types = Array.isArray(body.types)
    ? (body.types as unknown[]).filter((t): t is string => typeof t === "string")
    : undefined;

  const result = await forwardSearch(user.id, { query, types });

  if (!result) {
    return c.json({ error: "Search is temporarily unavailable" }, 503);
  }

  return c.json(result, 200);
}

// ── GET /api/v1/assistant/capabilities ────────────────────────────────────────

export async function handleGetCapabilities(c: Context) {
  const user = getUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  if (!isChatServiceEnabled()) {
    logger.warn(
      { chatServiceUrl: process.env.CHAT_SERVICE_URL || "(unset)", tokenSet: Boolean(process.env.INTERNAL_SERVICE_TOKEN) },
      "capabilities: chat service not enabled — returning empty registry"
    );
    return c.json({ capabilities: [] }, 200);
  }

  logger.debug(
    { method: "GET", path: "/internal/v1/capabilities", userId: user.id },
    "capabilities: HOP-2 → forwarding to chat service"
  );

  const result = await forwardGetCapabilities(user.id);

  if (!result) {
    logger.error(
      { method: "GET", path: "/internal/v1/capabilities" },
      "capabilities: HOP-2 ← chat service returned null (unreachable, timeout, or non-200)"
    );
    return c.json({ capabilities: [] }, 200);
  }

  logger.debug(
    { count: result.capabilities.length },
    "capabilities: HOP-2 ← 200 OK from chat service"
  );
  return c.json(result, 200);
}

// ── GET /api/v1/assistant/conversations ──────────────────────────────────────

export async function handleGetConversations(c: Context) {
  const user = getUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  if (!isChatServiceEnabled()) {
    return c.json({ conversations: [] }, 200);
  }

  const result = await forwardGetConversations(user.id);
  // Stub until the chat service implements conversation storage.
  return c.json(result ?? { conversations: [] }, 200);
}

// ── GET /api/v1/assistant/conversations/:id ───────────────────────────────────

export async function handleGetConversation(c: Context) {
  const user = getUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const conversationId = c.req.param("id");
  if (!conversationId) {
    return c.json({ error: "conversation id is required" }, 400);
  }

  if (!isChatServiceEnabled()) {
    return c.json({ id: conversationId, messages: [] }, 200);
  }

  const result = await forwardGetConversation(user.id, conversationId);
  // Stub until the chat service implements conversation storage.
  return c.json(result ?? { id: conversationId, messages: [] }, 200);
}
