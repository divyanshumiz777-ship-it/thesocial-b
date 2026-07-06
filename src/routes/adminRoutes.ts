import { Hono } from "hono";
import { authMiddleware } from "../middleware/authMiddleware.ts";
import { requireAdmin } from "../middleware/adminMiddleware.ts";
import {
  getAdminStats,
  getAdminReports,
} from "../controllers/adminController.ts";

const adminRouter = new Hono();

adminRouter.use(authMiddleware);
adminRouter.use(requireAdmin);

adminRouter.get("/stats", getAdminStats);
adminRouter.get("/reports", getAdminReports);

export { adminRouter };
