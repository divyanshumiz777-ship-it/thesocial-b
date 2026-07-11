import { Hono } from "hono";
import { authMiddleware } from "../middleware/authMiddleware.ts";
import {
  getVoiceSessions,
  getVoiceSessionTranscript,
  getVoiceSessionAnalytics,
} from "../controllers/voiceSessionController.ts";

export const voiceSessionRouter = new Hono();

voiceSessionRouter.get("/sessions/:channelId", authMiddleware, getVoiceSessions);
voiceSessionRouter.get(
  "/sessions/:sessionId/transcript",
  authMiddleware,
  getVoiceSessionTranscript,
);
voiceSessionRouter.get(
  "/analytics/:serverId",
  authMiddleware,
  getVoiceSessionAnalytics,
);
