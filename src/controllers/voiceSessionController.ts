import { Context } from "hono";
import mongoose from "mongoose";
import VoiceSession from "../models/VoiceSession.ts";
import VoiceSessionTranscript from "../models/VoiceSessionTranscript.ts";
import DiscordServer from "../models/DiscordServer.ts";
import ServerMember from "../models/ServerMember.ts";

// Read access to a channel's voice-session history and transcripts is
// server-membership-gated (any role, not just admin/mod — this is a read,
// not a structural change) rather than left open like getChannels/getChannel
// currently are, since transcripts carry meaningfully more privacy
// sensitivity than channel metadata.
async function isServerMember(serverId: string, userId: string | undefined) {
  if (!userId) return false;
  const server = await DiscordServer.findById(serverId).lean();
  if (!server) return false;
  if (server.owner.toString() === userId) return true;
  return !!(await ServerMember.exists({ server: serverId, user: userId }));
}

// Analytics aggregates data across every session in the server (not just
// one the caller is party to), so it's gated like updateChannel/deleteChannel
// (owner-or-admin/mod) rather than the lax "any member" rule above.
async function isServerAdminOrMod(serverId: string, userId: string | undefined) {
  if (!userId) return false;
  const server = await DiscordServer.findById(serverId).lean();
  if (!server) return false;
  if (server.owner.toString() === userId) return true;
  return !!(await ServerMember.exists({
    server: serverId,
    user: userId,
    roles: { $in: ["admin", "mod"] },
  }));
}

export const getVoiceSessions = async (c: Context) => {
  const { channelId } = c.req.param();
  const user = c.get("user");

  if (!mongoose.Types.ObjectId.isValid(channelId)) {
    return c.json({ error: "Invalid channel ID format" }, 400);
  }

  try {
    const sessions = await VoiceSession.find({ channel: channelId })
      .sort({ startedAt: -1 })
      .limit(50)
      .lean();

    if (sessions.length > 0) {
      const allowed = await isServerMember(
        sessions[0].server.toString(),
        user?.id,
      );
      if (!allowed) return c.json({ error: "Permission denied" }, 403);
    }

    return c.json({ sessions });
  } catch (error) {
    console.error("Error fetching voice sessions:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const getVoiceSessionTranscript = async (c: Context) => {
  const { sessionId } = c.req.param();
  const user = c.get("user");

  if (!mongoose.Types.ObjectId.isValid(sessionId)) {
    return c.json({ error: "Invalid session ID format" }, 400);
  }

  try {
    const session = await VoiceSession.findById(sessionId).lean();
    if (!session) return c.json({ error: "Session not found" }, 404);

    const allowed = await isServerMember(session.server.toString(), user?.id);
    if (!allowed) return c.json({ error: "Permission denied" }, 403);

    const transcript = await VoiceSessionTranscript.findOne({
      session: sessionId,
    }).lean();

    return c.json({ session, transcript: transcript ?? { segments: [] } });
  } catch (error) {
    console.error("Error fetching voice session transcript:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const getVoiceSessionAnalytics = async (c: Context) => {
  const { serverId } = c.req.param();
  const user = c.get("user");

  if (!mongoose.Types.ObjectId.isValid(serverId)) {
    return c.json({ error: "Invalid server ID format" }, 400);
  }

  try {
    const allowed = await isServerAdminOrMod(serverId, user?.id);
    if (!allowed) return c.json({ error: "Permission denied" }, 403);

    const sessions = await VoiceSession.find({ server: serverId })
      .select("status startedAt endedAt participants")
      .lean();

    const byStatus: Record<string, number> = {};
    const participantIds = new Set<string>();
    let durationTotalMs = 0;
    let durationCount = 0;

    for (const s of sessions) {
      byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
      for (const p of s.participants ?? []) participantIds.add(p.toString());
      if (s.startedAt && s.endedAt) {
        durationTotalMs += s.endedAt.getTime() - s.startedAt.getTime();
        durationCount += 1;
      }
    }

    const summarized = byStatus["summarized"] ?? 0;
    const failed = byStatus["failed"] ?? 0;
    const terminalSummarizations = summarized + failed;

    return c.json({
      serverId,
      totalSessions: sessions.length,
      byStatus,
      avgDurationSeconds:
        durationCount > 0 ? Math.round(durationTotalMs / durationCount / 1000) : null,
      totalUniqueParticipants: participantIds.size,
      summarizationSuccessRate:
        terminalSummarizations > 0 ? summarized / terminalSummarizations : null,
    });
  } catch (error) {
    console.error("Error fetching voice session analytics:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};
