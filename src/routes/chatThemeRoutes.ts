import { Hono } from "hono";
import { getChatTheme, setChatTheme } from "../controllers/chatThemeController.ts";
import { authMiddleware } from "../middleware/authMiddleware.ts";

export const chatThemeRouter = new Hono();

chatThemeRouter.get("/:scope/:targetId", authMiddleware, getChatTheme);
chatThemeRouter.put("/:scope/:targetId", authMiddleware, setChatTheme);
