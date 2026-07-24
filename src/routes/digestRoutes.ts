import { Hono } from "hono";
import { authMiddleware } from "../middleware/authMiddleware.ts";
import { getCatchMeUpDigest } from "../controllers/digestController.ts";

const digestRoutes = new Hono();

digestRoutes.use(authMiddleware);
digestRoutes.get("/catch-me-up", getCatchMeUpDigest);

export default digestRoutes;
