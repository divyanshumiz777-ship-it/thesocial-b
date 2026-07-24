import Stripe from "stripe";

// Lazy singleton, same pattern as chat-service's groq_client.py — nothing
// touches the Stripe API at import/startup, so a deployment with no keys
// configured yet boots cleanly; isStripeEnabled() is the single gate every
// payment controller checks before doing anything.
let _stripe: Stripe | null = null;

export function isStripeEnabled(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

export function getStripeClient(): Stripe {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY is not configured");
  }
  if (!_stripe) {
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return _stripe;
}

export function getWebhookSecret(): string {
  return process.env.STRIPE_WEBHOOK_SECRET || "";
}

// Platform's cut of every tip and tier subscription — a plain env-configured
// percentage (not a Stripe Connect "application_fee_percent" object), kept
// as a documented, easily-changed default rather than hardcoding it deep in
// checkout-session construction.
export function getPlatformFeePercent(): number {
  const raw = Number.parseFloat(process.env.STRIPE_PLATFORM_FEE_PERCENT || "10");
  return Number.isFinite(raw) && raw >= 0 && raw <= 100 ? raw : 10;
}

export function centsToFeeCents(amountCents: number): number {
  return Math.round((amountCents * getPlatformFeePercent()) / 100);
}

export function getFrontendUrl(): string {
  return process.env.FRONTEND_URL || "http://localhost:3000";
}
