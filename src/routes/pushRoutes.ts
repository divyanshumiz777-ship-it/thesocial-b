import { Hono } from "hono";
import { authMiddleware } from "../middleware/authMiddleware.ts";
import { getPushConfig, subscribePush, unsubscribePush } from "../controllers/pushController.ts";

const pushRoutes = new Hono();

// Public — lets the frontend decide whether to even offer a "turn on
// notifications" toggle before the user is necessarily signed in.
pushRoutes.get("/config", getPushConfig);
pushRoutes.post("/subscribe", authMiddleware, subscribePush);
pushRoutes.post("/unsubscribe", authMiddleware, unsubscribePush);

export default pushRoutes;
