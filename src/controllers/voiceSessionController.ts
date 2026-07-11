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
