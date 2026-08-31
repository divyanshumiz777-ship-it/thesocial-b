import { Hono } from "hono";
import { authMiddleware } from "../middleware/authMiddleware.ts";
import { getTurnCredentials } from "../controllers/webrtcController.ts";

const webrtcRouter = new Hono();

webrtcRouter.get("/turn-credentials", authMiddleware, getTurnCredentials);

export default webrtcRouter;
