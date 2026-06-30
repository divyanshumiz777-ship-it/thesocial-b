import { Hono } from "hono";
import { authMiddleware } from "../middleware/authMiddleware.ts";
import {
  handleChat,
  handleSearch,
  handleGetCapabilities,
  handleGetConversations,
  handleGetConversation,
} from "../controllers/assistantController.ts";

export const assistantRouter = new Hono();

assistantRouter.use(authMiddleware);

assistantRouter.post("/chat", handleChat);
assistantRouter.post("/search", handleSearch);
assistantRouter.get("/capabilities", handleGetCapabilities);
assistantRouter.get("/conversations", handleGetConversations);
assistantRouter.get("/conversations/:id", handleGetConversation);
