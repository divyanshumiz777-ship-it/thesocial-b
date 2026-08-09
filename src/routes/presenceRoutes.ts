import { Hono } from "hono";
import { authMiddleware } from "../middleware/authMiddleware.ts";
import { markSelfOffline } from "../controllers/presenceController.ts";

const presenceRouter = new Hono();

presenceRouter.post("/offline", authMiddleware, markSelfOffline);

export default presenceRouter;
