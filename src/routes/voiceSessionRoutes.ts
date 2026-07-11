import { Hono } from "hono";
import { authMiddleware } from "../middleware/authMiddleware.ts";
import {
  getVoiceSessions,
  getVoiceSessionTranscript,
} from "../controllers/voiceSessionController.ts";

export const voiceSessionRouter = new Hono();

voiceSessionRouter.get("/sessions/:channelId", authMiddleware, getVoiceSessions);
voiceSessionRouter.get(
  "/sessions/:sessionId/transcript",
  authMiddleware,
  getVoiceSessionTranscript,
);
