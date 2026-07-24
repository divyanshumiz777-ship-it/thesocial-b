import { Hono } from "hono";
import { authMiddleware } from "../middleware/authMiddleware.ts";
import {
  getPaymentsStatus,
  startCreatorOnboarding,
  getPayoutStatus,
  getTipEligibility,
  createTipCheckout,
  handleStripeWebhook,
} from "../controllers/paymentController.ts";

const paymentRoutes = new Hono();

// Public — the frontend needs this before deciding whether to show any
// tipping/monetization UI at all.
paymentRoutes.get("/status", getPaymentsStatus);
paymentRoutes.get("/tip-eligibility/:userId", getTipEligibility);

// Stripe's webhook call carries no user auth (it authenticates via the
// signature header instead, verified inside handleStripeWebhook) — must
// stay outside authMiddleware, same reasoning as publicReelRoutes.
paymentRoutes.post("/webhook", handleStripeWebhook);

paymentRoutes.post("/onboard", authMiddleware, startCreatorOnboarding);
paymentRoutes.get("/payout-status", authMiddleware, getPayoutStatus);
paymentRoutes.post("/tip", authMiddleware, createTipCheckout);

export default paymentRoutes;
