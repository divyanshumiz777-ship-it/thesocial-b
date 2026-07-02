import { Hono } from "hono";
import { authMiddleware } from "../middleware/authMiddleware.ts";
import { reportUser } from "../controllers/reportController.ts";

const reportRoutes = new Hono();

reportRoutes.use(authMiddleware);

reportRoutes.post("/user/:userId", reportUser);

export default reportRoutes;
