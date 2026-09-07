/**
 * Apply Stripe webhook events to org billing columns. Idempotent via stripe_events.
 *
 * Durability: record only after a successful apply (or intentional ignore), so a
 * crashed apply does not poison the event id and block Stripe retries.
 */

import type Stripe from "stripe";
import type { Db } from "../db/driver.js";
import { type BillingPlan, type BillingStatus, planFromPriceId } from "./plans.js";

export interface OrgBillingUpdate {
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
  plan?: BillingPlan;
  seat_quantity?: number;
  billing_status?: BillingStatus;
  current_period_end?: number | null;
  billing_email?: string | null;
  billing_last_event_created?: number | null;
}

export async function recordStripeEvent(db: Db, eventId: string): Promise<"new" | "duplicate"> {
  const now = Date.now();
  try {
    const inserted = await db
      .prepare(
        "INSERT INTO stripe_events (event_id, processed_at) VALUES (?, ?) ON CONFLICT DO NOTHING RETURNING event_id",
      )
      .get<{ event_id: string }>(eventId, now);
    if (inserted) return "new";
  } catch {
    // SQLite without RETURNING on conflict — fall through to select
  }
  const existing = await db
    .prepare("SELECT event_id FROM stripe_events WHERE event_id = ?")
    .get<{ event_id: string }>(eventId);
  if (existing) return "duplicate";
  await db.prepare("INSERT INTO stripe_events (event_id, processed_at) VALUES (?, ?)").run(eventId, now);
  return "new";
}

async function isProcessed(db: Db, eventId: string): Promise<boolean> {
  const existing = await db
    .prepare("SELECT event_id FROM stripe_events WHERE event_id = ?")
    .get<{ event_id: string }>(eventId);
  return Boolean(existing);
}

async function updateOrgById(db: Db, orgId: string, patch: OrgBillingUpdate): Promise<void> {
  const sets: string[] = [];
  const params: Array<string | number | null> = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    sets.push(`${k} = ?`);
    params.push(v as string | number | null);
  }
  if (sets.length === 0) return;
  params.push(orgId);
  await db.prepare(`UPDATE orgs SET ${sets.join(", ")} WHERE id = ?`).run(...params);
}

async function orgIdFromCustomer(db: Db, customerId: string | null | undefined): Promise<string | null> {
  if (!customerId) return null;
  const row = await db
    .prepare("SELECT id FROM orgs WHERE stripe_customer_id = ?")
    .get<{ id: string }>(customerId);
  return row?.id ?? null;
}

function parsePlan(raw: unknown): BillingPlan | null {
  if (raw === "solo" || raw === "team" || raw === "enterprise") return raw;
  return null;
}

function seatQuantityFromSession(session: Stripe.Checkout.Session): number | undefined {
  const metaSeats = session.metadata?.seat_quantity ?? session.metadata?.seats;
  if (metaSeats != null && metaSeats !== "") {
    const n = Number(metaSeats);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  const lineItems = (session as { line_items?: { data?: Array<{ quantity?: number | null }> } }).line_items;
  const qty = lineItems?.data?.[0]?.quantity;
  if (typeof qty === "number" && qty > 0) return qty;
  return undefined;
}

function subscriptionFields(
  sub: Stripe.Subscription,
  env: NodeJS.ProcessEnv,
): OrgBillingUpdate {
  const item = sub.items.data[0];
  const priceId = item?.price?.id;
  const metaPlan = parsePlan(sub.metadata?.plan);
  const pricePlan = planFromPriceId(priceId, env);
  // Fail closed: never invent Team from an unknown price.
  const plan: BillingPlan | undefined = metaPlan ?? (pricePlan !== "none" ? pricePlan : undefined);
  const seats = item?.quantity ?? 1;
  let billing_status: BillingStatus = "none";
  switch (sub.status) {
    case "active":
    case "trialing":
      billing_status = "active";
      break;
    case "past_due":
    case "unpaid":
      billing_status = "past_due";
      break;
    case "canceled":
      billing_status = "canceled";
      break;
    default:
      billing_status = "incomplete";
  }
  const periodEnd = (sub as { current_period_end?: number }).current_period_end;
  const patch: OrgBillingUpdate = {
    stripe_subscription_id: sub.id,
    stripe_customer_id: typeof sub.customer === "string" ? sub.customer : sub.customer?.id ?? null,
    seat_quantity: seats,
    billing_status,
    current_period_end: periodEnd ? periodEnd * 1000 : null,
  };
  if (billing_status === "canceled") {
    patch.plan = "none";
  } else if (plan) {
    patch.plan = plan;
  }
  // Unknown plan + non-canceled: leave existing org.plan untouched (do not invent team).
  return patch;
}

/**
 * Guard against out-of-order Stripe delivery: a canceled plan must not be
 * re-activated by a late subscription.updated / invoice.paid whose Stripe
 * created time is older than the last applied billing event.
 */
async function shouldApplyStatusChange(
  db: Db,
  orgId: string,
  nextStatus: BillingStatus | undefined,
  eventCreatedSec: number,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!nextStatus || nextStatus === "canceled" || nextStatus === "none") {
    return { ok: true };
  }
  const row = await db
    .prepare(
      "SELECT billing_status, billing_last_event_created FROM orgs WHERE id = ?",
    )
    .get<{ billing_status: string | null; billing_last_event_created: number | null }>(orgId);
  if (!row) return { ok: true };
  if (row.billing_status !== "canceled") return { ok: true };
  const eventMs = eventCreatedSec * 1000;
  const last = row.billing_last_event_created ?? 0;
  if (eventMs <= last) {
    return {
      ok: false,
      reason: `stale event after cancel (event.created=${eventCreatedSec} <= watermark=${Math.floor(last / 1000)})`,
    };
  }
  return { ok: true };
}

async function applyStripeEventBody(
  db: Db,
  event: Stripe.Event,
  env: NodeJS.ProcessEnv,
): Promise<{ applied: boolean; reason?: string; durable?: boolean }> {
  const eventCreated = typeof event.created === "number" ? event.created : Math.floor(Date.now() / 1000);
  const eventMs = eventCreated * 1000;

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const orgId = session.metadata?.memracer_org_id
        ?? session.client_reference_id
        ?? null;
      if (!orgId) return { applied: false, reason: "no org id on session" };
      const customerId = typeof session.customer === "string"
        ? session.customer
        : session.customer?.id ?? null;
      const subId = typeof session.subscription === "string"
        ? session.subscription
        : session.subscription?.id ?? null;
      const plan = parsePlan(session.metadata?.plan);
      const seats = seatQuantityFromSession(session);
      if (plan) {
        const gate = await shouldApplyStatusChange(db, orgId, "active", eventCreated);
        if (!gate.ok) return { applied: false, reason: gate.reason, durable: true };
      }
      const patch: OrgBillingUpdate = {
        stripe_customer_id: customerId,
        stripe_subscription_id: subId,
        billing_email: session.customer_details?.email ?? session.customer_email ?? null,
        billing_last_event_created: eventMs,
      };
      if (plan) {
        patch.plan = plan;
        patch.billing_status = "active";
      }
      // Unknown plan: attach customer/sub only — do not invent Team or mark active.
      if (seats != null) patch.seat_quantity = seats;
      await updateOrgById(db, orgId, patch);
      return { applied: true, durable: true };
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const orgId = sub.metadata?.memracer_org_id
        ?? await orgIdFromCustomer(db, typeof sub.customer === "string" ? sub.customer : sub.customer?.id);
      if (!orgId) return { applied: false, reason: "no org for subscription" };
      const fields = subscriptionFields(sub, env);
      if (event.type === "customer.subscription.deleted") {
        fields.billing_status = "canceled";
        fields.plan = "none";
      }
      const gate = await shouldApplyStatusChange(db, orgId, fields.billing_status, eventCreated);
      if (!gate.ok) return { applied: false, reason: gate.reason, durable: true };
      fields.billing_last_event_created = eventMs;
      await updateOrgById(db, orgId, fields);
      return { applied: true, durable: true };
    }
    case "invoice.paid":
    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId = typeof invoice.customer === "string"
        ? invoice.customer
        : invoice.customer?.id ?? null;
      const subRef = (invoice as { subscription?: string | { id?: string } | null }).subscription;
      const subId = typeof subRef === "string" ? subRef : subRef?.id ?? null;
      let orgId = subId
        ? (await db
            .prepare("SELECT id FROM orgs WHERE stripe_subscription_id = ?")
            .get<{ id: string }>(subId))?.id ?? null
        : null;
      if (!orgId) orgId = await orgIdFromCustomer(db, customerId);
      if (!orgId) return { applied: false, reason: "no org for invoice" };

      // Prefer subscription-linked org; only flip status (not invent plan).
      // Tie past_due/active to the invoice event while leaving plan/seats to subscription events.
      const nextStatus: BillingStatus = event.type === "invoice.paid" ? "active" : "past_due";
      const gate = await shouldApplyStatusChange(db, orgId, nextStatus, eventCreated);
      if (!gate.ok) return { applied: false, reason: gate.reason, durable: true };
      const patch: OrgBillingUpdate = {
        billing_status: nextStatus,
        billing_last_event_created: eventMs,
      };
      if (subId) patch.stripe_subscription_id = subId;
      if (customerId) patch.stripe_customer_id = customerId;
      await updateOrgById(db, orgId, patch);
      return { applied: true, durable: true };
    }
    default:
      // Intentionally ignored types are durable so we do not reprocess forever.
      return { applied: false, reason: `ignored ${event.type}`, durable: true };
  }
}

export async function applyStripeEvent(
  db: Db,
  event: Stripe.Event,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ applied: boolean; reason?: string }> {
  if (await isProcessed(db, event.id)) {
    return { applied: false, reason: "duplicate" };
  }

  let result: { applied: boolean; reason?: string; durable?: boolean };
  try {
    result = await applyStripeEventBody(db, event, env);
  } catch (err) {
    // Apply threw — do not record; Stripe may retry.
    return {
      applied: false,
      reason: err instanceof Error ? err.message : "apply failed",
    };
  }

  // Record only after successful apply or intentional ignore.
  if (result.applied || result.durable) {
    await recordStripeEvent(db, event.id);
  }
  return { applied: result.applied, reason: result.reason };
}
