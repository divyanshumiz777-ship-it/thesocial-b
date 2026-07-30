import Razorpay from "razorpay";
import {
  validatePaymentVerification,
  validateWebhookSignature,
} from "razorpay/dist/utils/razorpay-utils.js";

// Lazy singleton, same pattern as the Stripe client it replaces — nothing
// touches the Razorpay API at import/startup, so a deployment with no keys
// configured yet boots cleanly; isRazorpayEnabled() is the single gate every
// payment controller checks before doing anything.
//
// India-focused: this collects payments only (Razorpay Route — the
// automatic payment-splitting product needed for real-time creator
// payouts — requires the PLATFORM itself to meet a ₹40L+ domestic turnover
// threshold under RBI rules from September 2025, which a new platform
// won't meet). Tips and tier subscriptions settle to the platform's own
// Razorpay account; what's owed to each creator is tracked in Mongo
// (Tip/TierSubscription) and paid out manually/separately for now.
let _razorpay: Razorpay | null = null;

export function isRazorpayEnabled(): boolean {
  return Boolean(process.env.RAZORPAY_KEY_ID) && Boolean(process.env.RAZORPAY_KEY_SECRET);
}

export function getRazorpayClient(): Razorpay {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    throw new Error("RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET are not configured");
  }
  if (!_razorpay) {
    _razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
  }
  return _razorpay;
}

// The public key — safe to expose to the frontend, which needs it to open
// the Razorpay Checkout modal.
export function getRazorpayKeyId(): string {
  return process.env.RAZORPAY_KEY_ID || "";
}

export function getWebhookSecret(): string {
  return process.env.RAZORPAY_WEBHOOK_SECRET || "";
}

// Platform's cut of every tip and tier subscription — bookkeeping only
// (there's no Razorpay Route split happening at charge time under the
// "collect only" model), used to compute how much of a payment is
// recorded as platform revenue vs. amount owed to the creator.
export function getPlatformFeePercent(): number {
  const raw = Number.parseFloat(process.env.RAZORPAY_PLATFORM_FEE_PERCENT || "10");
  return Number.isFinite(raw) && raw >= 0 && raw <= 100 ? raw : 10;
}

export function paiseToFeePaise(amountPaise: number): number {
  return Math.round((amountPaise * getPlatformFeePercent()) / 100);
}

export function getFrontendUrl(): string {
  return process.env.FRONTEND_URL || "http://localhost:3000";
}

// Re-exported so callers never hand-construct the HMAC themselves — the
// exact field concatenation differs between an order payment and a
// subscription payment (verified against the installed package's own
// source: order_id + '|' + payment_id vs. payment_id + '|' + subscription_id),
// and getting that order wrong silently breaks payment-authenticity checks.
export { validatePaymentVerification, validateWebhookSignature };
