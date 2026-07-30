import { Hono } from "hono";
import { authMiddleware } from "../middleware/authMiddleware.ts";
import {
  getCatchMeUpDigest,
  getCatchMeUpEligibility,
  ackCatchMeUpDigest,
} from "../controllers/digestController.ts";

const digestRoutes = new Hono();

digestRoutes.use(authMiddleware);
// Order matters for Hono's router — /catch-me-up/eligibility must be
// registered before the plain /catch-me-up GET so it isn't shadowed.
digestRoutes.get("/catch-me-up/eligibility", getCatchMeUpEligibility);
digestRoutes.get("/catch-me-up", getCatchMeUpDigest);
digestRoutes.post("/catch-me-up/ack", ackCatchMeUpDigest);

export default digestRoutes;
