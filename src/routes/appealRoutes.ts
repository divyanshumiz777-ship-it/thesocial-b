import { Hono } from "hono";
import { authMiddleware } from "../middleware/authMiddleware.ts";
import { submitAppeal } from "../controllers/adminController.ts";

const appealRoutes = new Hono();

appealRoutes.use(authMiddleware);
appealRoutes.post("/", submitAppeal);

export default appealRoutes;
