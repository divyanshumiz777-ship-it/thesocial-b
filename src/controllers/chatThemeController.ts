import { Context } from "hono";
import { Server } from "socket.io";
import mongoose from "mongoose";
import Conversation from "../models/Conversation.ts";
import Group from "../models/Group.ts";
import ServerMember from "../models/ServerMember.ts";
import User from "../models/User.ts";
import { isValidChatTheme } from "../constants/chatThemes.ts";
import {
  chatThemeKey,
  isChatThemeScope,
  type ChatThemeScope,
} from "../utils/chatThemeKey.ts";
import { invalidateAfterDM } from "../lib/cacheInvalidation.ts";

/**
 * Generic per-viewer chat theme endpoints, covering all three chat surfaces
 * (1:1 DM, group DM, community server) through one pair of routes. Storage
 * lives on the SAME `User.settings.conversationThemes` map the original
 * DM-only feature used (see chatThemeKey.ts for why that's safe to share),
 * so a DM theme set through this endpoint reads back identically through
 * the legacy `/api/v1/dm/theme/:conversationId` route, and vice versa.
 *
 * Always viewer-private — nothing here is ever visible to or shared with
 * other participants/members, matching the original DM theme's model.
 */

async function assertCanThemeTarget(
  userId: string,
  scope: ChatThemeScope,
  targetId: string
): Promise<{ ok: true } | { ok: false; status: 404 | 403; error: string }> {
  if (scope === "dm") {
    const conversation = await Conversation.findById(targetId).select("participants");
    if (!conversation) return { ok: false, status: 404, error: "Conversation not found" };
    const isParticipant = conversation.participants?.some(
      (p) => p?.toString() === userId.toString()
    );
    if (!isParticipant) {
      return { ok: false, status: 403, error: "You are not a participant of this conversation" };
    }
    return { ok: true };
  }

  if (scope === "group") {
    const group = await Group.findById(targetId).select("participants");
    if (!group) return { ok: false, status: 404, error: "Group not found" };
    const isParticipant = group.participants?.some(
      (p) => p?.toString() === userId.toString()
    );
    if (!isParticipant) {
      return { ok: false, status: 403, error: "You are not a member of this group" };
    }
    return { ok: true };
  }

  // community
  const membership = await ServerMember.findOne({ server: targetId, user: userId })
    .select("banned")
    .lean();
  if (!membership) {
    return { ok: false, status: 403, error: "You are not a member of this community" };
  }
  if (membership.banned?.isBanned) {
    return { ok: false, status: 403, error: "You are banned from this community" };
  }
  return { ok: true };
}

/** GET — no membership check (mirrors the original DM theme endpoint):
 *  reading your own stored preference back is harmless even for a target
 *  you've since left, and skipping the lookup keeps this cheap. */
export const getChatTheme = async (c: Context) => {
  const { scope, targetId } = c.req.param();
  const userId = c.get("user").id;

  if (!scope || !isChatThemeScope(scope)) {
    return c.json({ error: "Invalid scope" }, 400);
  }
  if (!targetId || !mongoose.Types.ObjectId.isValid(targetId)) {
    return c.json({ error: "Invalid ID format" }, 400);
  }

  try {
    const user = await User.findById(userId).select("settings.conversationThemes");
    const theme =
      user?.settings?.conversationThemes?.get(chatThemeKey(scope, targetId)) ?? null;
    return c.json({ theme }, 200);
  } catch (error) {
    console.error("Error fetching chat theme:", error);
    return c.json({ error: "Failed to fetch chat theme" }, 500);
  }
};

/** Set (or clear, via theme: null/"default") this viewer's theme for a
 *  dm/group/community target. */
export const setChatTheme = async (c: Context) => {
  const { scope, targetId } = c.req.param();
  const userId = c.get("user").id;
  const io = c.get("io") as Server | undefined;
  const { theme } = (await c.req.json().catch(() => ({}))) as { theme?: string | null };

  if (!scope || !isChatThemeScope(scope)) {
    return c.json({ error: "Invalid scope" }, 400);
  }
  if (!targetId || !mongoose.Types.ObjectId.isValid(targetId)) {
    return c.json({ error: "Invalid ID format" }, 400);
  }

  try {
    const permission = await assertCanThemeTarget(userId, scope, targetId);
    if (!permission.ok) return c.json({ error: permission.error }, permission.status);

    const key = chatThemeKey(scope, targetId);
    const clearing = theme === null || theme === undefined || theme === "default";

    if (clearing) {
      await User.findByIdAndUpdate(userId, {
        $unset: { [`settings.conversationThemes.${key}`]: "" },
      });
    } else {
      if (typeof theme !== "string" || !isValidChatTheme(theme)) {
        return c.json({ error: "Invalid theme" }, 400);
      }
      await User.findByIdAndUpdate(userId, {
        $set: { [`settings.conversationThemes.${key}`]: theme },
      });
    }

    const resolvedTheme = clearing ? null : (theme as string);

    if (io) {
      io.to(userId.toString()).emit("chat:themeChanged", {
        scope,
        targetId,
        theme: resolvedTheme,
      });
      // The DM surface's socket listener still only knows the original
      // event/payload shape — keep sending it during the migration window
      // so DirectMessageChat.tsx doesn't need to change in lockstep with
      // this endpoint existing.
      if (scope === "dm") {
        io.to(userId.toString()).emit("conversation:themeChanged", {
          conversationId: targetId,
          theme: resolvedTheme,
        });
      }
    }

    // This whole path is on the cache skip-list (app.ts) so reads are never
    // stale regardless; invalidateAfterDM additionally covers any combined
    // DM-response caching that embeds theme data. No group/community
    // equivalent exists yet, so this only runs for "dm".
    if (scope === "dm") {
      await invalidateAfterDM(targetId, userId);
    }

    return c.json({ success: true, theme: resolvedTheme }, 200);
  } catch (error) {
    console.error("Error setting chat theme:", error);
    return c.json({ error: "Failed to set chat theme" }, 500);
  }
};
