import { Hono } from "hono";
import { authMiddleware } from "../middleware/authMiddleware.ts";
import {
  getPaymentsStatus,
  getTipsEnabledStatus,
  setTipsEnabledStatus,
  getTipEligibility,
  createTipOrder,
  verifyTipPayment,
  createServerTier,
  listServerTiers,
  deactivateServerTier,
  createTierSubscription,
  verifyTierSubscription,
  handleRazorpayWebhook,
  getCreatorRevenueSummary,
} from "../controllers/paymentController.ts";

const paymentRoutes = new Hono();

// Public — the frontend needs this before deciding whether to show any
// tipping/monetization UI at all.
paymentRoutes.get("/status", getPaymentsStatus);
paymentRoutes.get("/tip-eligibility/:userId", getTipEligibility);

// Razorpay's webhook call carries no user auth (it authenticates via the
// X-Razorpay-Signature header instead, verified inside handleRazorpayWebhook)
// — must stay outside authMiddleware, same reasoning as publicReelRoutes.
paymentRoutes.post("/webhook", handleRazorpayWebhook);

paymentRoutes.get("/tips-enabled", authMiddleware, getTipsEnabledStatus);
paymentRoutes.post("/tips-enabled", authMiddleware, setTipsEnabledStatus);
paymentRoutes.post("/tip", authMiddleware, createTipOrder);
paymentRoutes.post("/tip/verify", authMiddleware, verifyTipPayment);
// Always scoped to the authenticated caller (c.get("user").id inside the
// controller) — deliberately no :userId param, since this returns money
// data; a route shape that accepted one would invite a "pasted someone
// else's id" confusion/leak risk even with correct server-side enforcement.
paymentRoutes.get("/creator-summary", authMiddleware, getCreatorRevenueSummary);

export default paymentRoutes;
