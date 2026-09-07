/**
 * Stripe Checkout / Portal helpers. Test-mode price IDs live in env.
 */

import Stripe from "stripe";
import {
  type BillingPlan,
  isInternalOrg,
  priceIdForPlan,
  publicUrl,
} from "./plans.js";

export type StripeClient = Stripe;

/** True when this process is treated as production for Stripe key policy. */
export function isStripeProductionEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const node = (env.NODE_ENV ?? "").toLowerCase();
  const mem = (env.MEMRACER_ENV ?? env.STRIPE_MODE ?? "").toLowerCase();
  return node === "production" || mem === "production" || mem === "live";
}

/**
 * Refuse to use a Stripe test secret key when running in production.
 * STRIPE_MODE is advisory; the key prefix is the source of truth.
 */
export function assertStripeSecretKey(
  key: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const trimmed = key.trim();
  if (!trimmed) return;
  if (isStripeProductionEnv(env) && trimmed.startsWith("sk_test_")) {
    throw new Error(
      "Refusing to start with a Stripe test secret key (sk_test_) in production. " +
        "Set STRIPE_SECRET_KEY to a live sk_live_ key.",
    );
  }
}

export function stripeFromEnv(env: NodeJS.ProcessEnv = process.env): Stripe | null {
  const key = env.STRIPE_SECRET_KEY?.trim();
  if (!key) return null;
  assertStripeSecretKey(key, env);
  return new Stripe(key);
}

export interface CheckoutSessionInput {
  orgId: string;
  plan: "solo" | "team";
  seats: number;
  customerId?: string | null;
  customerEmail?: string | null;
}

export interface CheckoutSessionResult {
  url: string;
  sessionId: string;
  /** Args used for session create — exposed for tests. */
  sessionParams: Stripe.Checkout.SessionCreateParams;
  /** Stripe Idempotency-Key header value. */
  idempotencyKey: string;
}

/** Stable idempotency key for checkout session create (dedupes double-submit). */
export function checkoutIdempotencyKey(input: CheckoutSessionInput): string {
  const seats = Math.max(1, Math.floor(input.seats));
  return `checkout:${input.orgId}:${input.plan}:${seats}`;
}

export function portalIdempotencyKey(customerId: string): string {
  return `portal:${customerId}`;
}

export function buildCheckoutSessionParams(
  input: CheckoutSessionInput,
  env: NodeJS.ProcessEnv = process.env,
): Stripe.Checkout.SessionCreateParams {
  const price = priceIdForPlan(input.plan, env);
  if (!price) {
    throw new Error(`missing Stripe price id for plan ${input.plan} (set STRIPE_${input.plan.toUpperCase()}_PRICE_ID)`);
  }
  const seats = Math.max(1, Math.floor(input.seats));
  const base = publicUrl(env);
  const internal = isInternalOrg(input.orgId, env);
  const params: Stripe.Checkout.SessionCreateParams = {
    mode: "subscription",
    line_items: [{ price, quantity: seats }],
    // Real customers must not redeem arbitrary live promo codes. Internal
    // orgs may use the promo box only when no fixed coupon is applied.
    allow_promotion_codes: internal ? true : undefined,
    success_url: `${base}/dashboard?view=org-settings&billing=success&org=${encodeURIComponent(input.orgId)}`,
    cancel_url: `${base}/dashboard?view=org-settings&billing=cancel&org=${encodeURIComponent(input.orgId)}`,
    client_reference_id: input.orgId,
    metadata: {
      memracer_org_id: input.orgId,
      plan: input.plan,
      seat_quantity: String(seats),
    },
    subscription_data: {
      metadata: {
        memracer_org_id: input.orgId,
        plan: input.plan,
        seat_quantity: String(seats),
      },
    },
  };
  if (input.customerId) {
    params.customer = input.customerId;
  } else if (input.customerEmail) {
    params.customer_email = input.customerEmail;
  }
  const coupon = env.STRIPE_INTERNAL_COUPON_ID?.trim();
  if (coupon && internal) {
    params.discounts = [{ coupon }];
    // Stripe forbids combining allow_promotion_codes with discounts — prefer server coupon for allowlist.
    delete params.allow_promotion_codes;
  }
  return params;
}

export async function createCheckoutSession(
  stripe: Stripe,
  input: CheckoutSessionInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CheckoutSessionResult> {
  const sessionParams = buildCheckoutSessionParams(input, env);
  const idempotencyKey = checkoutIdempotencyKey(input);
  const session = await stripe.checkout.sessions.create(sessionParams, {
    idempotencyKey,
  });
  if (!session.url) throw new Error("Stripe Checkout session missing url");
  return { url: session.url, sessionId: session.id, sessionParams, idempotencyKey };
}

export async function createPortalSession(
  stripe: Stripe,
  customerId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ url: string; idempotencyKey: string }> {
  const base = publicUrl(env);
  const idempotencyKey = portalIdempotencyKey(customerId);
  const session = await stripe.billingPortal.sessions.create(
    {
      customer: customerId,
      return_url: `${base}/dashboard`,
    },
    { idempotencyKey },
  );
  return { url: session.url, idempotencyKey };
}

export function constructWebhookEvent(
  stripe: Stripe,
  rawBody: Buffer | string,
  signature: string,
  env: NodeJS.ProcessEnv = process.env,
): Stripe.Event {
  const secret = env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is not configured");
  return stripe.webhooks.constructEvent(rawBody, signature, secret);
}

export function planLabel(plan: BillingPlan): string {
  return plan;
}
