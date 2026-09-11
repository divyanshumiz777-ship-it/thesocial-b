import { Hono } from "hono";
import { authMiddleware } from "../middleware/authMiddleware.ts";
import { requireAdmin } from "../middleware/adminMiddleware.ts";
import {
  getAdminStats,
  getAdminAnalytics,
  getAdminUsers,
  getAdminServers,
  getAdminReports,
  getServersForReportedUser,
  resolveReport,
  getAdminAppeals,
  resolveAppeal,
  getSystemHealthSnapshot,
  getSystemHealthSeries,
  getSystemHealthDependencies,
} from "../controllers/adminController.ts";

const adminRouter = new Hono();

adminRouter.use(authMiddleware);
adminRouter.use(requireAdmin);

adminRouter.get("/stats", getAdminStats);
adminRouter.get("/analytics", getAdminAnalytics);
adminRouter.get("/users", getAdminUsers);
adminRouter.get("/servers", getAdminServers);
adminRouter.get("/reports", getAdminReports);
adminRouter.get("/reports/:userId/servers", getServersForReportedUser);
adminRouter.patch("/reports/:reportId/resolve", resolveReport);
adminRouter.get("/appeals", getAdminAppeals);
adminRouter.patch("/appeals/:appealId/resolve", resolveAppeal);
adminRouter.get("/system-health", getSystemHealthSnapshot);
adminRouter.get("/system-health/series", getSystemHealthSeries);
adminRouter.get("/system-health/dependencies", getSystemHealthDependencies);

export { adminRouter };
