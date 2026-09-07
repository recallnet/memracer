/**
 * Seat / project caps. There is no free tier.
 *
 * - No active paid plan: bootstrap only (1 seat = creator, 1 project). No invites,
 *   no extra projects until Checkout attaches Solo/Team/Enterprise.
 * - Active Solo/Team: plan caps (and seat_quantity when set).
 * - past_due: block expansion (invites / new projects).
 */

import type { Db } from "../db/driver.js";
import { PLAN_LIMITS, type BillingPlan, type BillingStatus } from "./plans.js";

export interface OrgBillingRow {
  id: string;
  plan: string | null;
  seat_quantity: number | null;
  billing_status: string | null;
}

export function effectivePlan(org: OrgBillingRow): BillingPlan {
  const p = org.plan;
  if (p === "solo" || p === "team" || p === "enterprise" || p === "none") return p;
  return "none";
}

/** Paid subscription that is currently usable. No free tier. */
export function hasActivePaidPlan(org: OrgBillingRow): boolean {
  const plan = effectivePlan(org);
  const status = (org.billing_status ?? "none") as BillingStatus;
  if (status !== "active") return false;
  return plan === "solo" || plan === "team" || plan === "enterprise";
}

export function maxSeats(org: OrgBillingRow): number | null {
  const plan = effectivePlan(org);
  if (plan === "enterprise" && hasActivePaidPlan(org)) return null;
  if ((plan === "solo" || plan === "team") && hasActivePaidPlan(org)) {
    const cap = PLAN_LIMITS[plan].maxSeats;
    const qty = org.seat_quantity && org.seat_quantity > 0 ? org.seat_quantity : cap;
    return Math.min(cap, qty);
  }
  // Unpaid: creator only — not a free multi-seat tier.
  return 1;
}

export function maxProjects(org: OrgBillingRow): number | null {
  const plan = effectivePlan(org);
  if (plan === "enterprise" && hasActivePaidPlan(org)) return null;
  if ((plan === "solo" || plan === "team") && hasActivePaidPlan(org)) {
    return PLAN_LIMITS[plan].maxProjects;
  }
  // Unpaid: single bootstrap project from signup.
  return 1;
}

export function writesBlocked(org: OrgBillingRow): boolean {
  const status = (org.billing_status ?? "none") as BillingStatus;
  return status === "past_due";
}

/** Frigg / customer inference requires an active paid plan. */
export function friggAllowed(org: OrgBillingRow): boolean {
  if (writesBlocked(org)) return false;
  return hasActivePaidPlan(org);
}

/** Count better-auth members across projects in the org. */
export async function countOrgSeats(db: Db, orgId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(DISTINCT m."userId") AS n
         FROM "member" m
         INNER JOIN projects p ON p.id = m."organizationId"
        WHERE p.org_id = ?
          AND (p.archived_at IS NULL)
          AND m.role IN ('human', 'admin', 'coder')`,
    )
    .get<{ n: number }>(orgId);
  return Number(row?.n ?? 0);
}

/**
 * Pending, unexpired invitations for projects in the org whose email is not
 * already a member of any project in the org (those invites do not add a seat).
 */
export async function countPendingOrgInvites(db: Db, orgId: string): Promise<number> {
  const nowIso = new Date().toISOString();
  const row = await db
    .prepare(
      `SELECT COUNT(DISTINCT lower(i.email)) AS n
         FROM "invitation" i
         INNER JOIN projects p ON p.id = i."organizationId"
        WHERE p.org_id = ?
          AND (p.archived_at IS NULL)
          AND i.status = 'pending'
          AND i."expiresAt" > ?
          AND NOT EXISTS (
            SELECT 1
              FROM "member" m
              INNER JOIN projects p2 ON p2.id = m."organizationId"
              INNER JOIN "user" u ON u.id = m."userId"
             WHERE p2.org_id = ?
               AND (p2.archived_at IS NULL)
               AND lower(u.email) = lower(i.email)
          )`,
    )
    .get<{ n: number }>(orgId, nowIso, orgId);
  return Number(row?.n ?? 0);
}

/** Members + pending net-new invites against the seat cap. */
export async function countOrgSeatCommitments(db: Db, orgId: string): Promise<number> {
  return (await countOrgSeats(db, orgId)) + (await countPendingOrgInvites(db, orgId));
}

/** True when this user already occupies a seat on any project in the org. */
export async function userHasOrgSeat(db: Db, orgId: string, userId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS ok
         FROM "member" m
         INNER JOIN projects p ON p.id = m."organizationId"
        WHERE p.org_id = ?
          AND (p.archived_at IS NULL)
          AND m."userId" = ?
          AND m.role IN ('human', 'admin', 'coder')
        LIMIT 1`,
    )
    .get<{ ok: number }>(orgId, userId);
  return Boolean(row);
}

export async function countOrgProjects(db: Db, orgId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM projects WHERE org_id = ? AND archived_at IS NULL`,
    )
    .get<{ n: number }>(orgId);
  return Number(row?.n ?? 0);
}

const SUBSCRIBE_SEATS =
  "Set up billing in Org Settings (Checkout) before inviting teammates. There is no free multi-seat tier.";
const SUBSCRIBE_PROJECTS =
  "Set up billing in Org Settings (Checkout) before creating more projects. There is no free multi-project tier.";

export async function assertCanAddSeat(
  db: Db,
  org: OrgBillingRow,
  opts?: { /** When true, skip the cap (user already has an org seat). */ existingOrgMember?: boolean },
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  if (writesBlocked(org)) {
    return {
      ok: false,
      status: 402,
      error: "Billing past due — update payment method in Org Settings before adding seats.",
    };
  }
  if (!hasActivePaidPlan(org)) {
    return { ok: false, status: 402, error: SUBSCRIBE_SEATS };
  }
  if (opts?.existingOrgMember) return { ok: true };
  const cap = maxSeats(org);
  if (cap === null) return { ok: true };
  // Pending invites consume capacity so Team×N cannot mint unbounded accepts.
  const used = await countOrgSeatCommitments(db, org.id);
  if (used >= cap) {
    return {
      ok: false,
      status: 402,
      error: `Seat limit reached (${used}/${cap}). Upgrade plan or add seats in billing.`,
    };
  }
  return { ok: true };
}

export async function assertCanAddProject(
  db: Db,
  org: OrgBillingRow,
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  if (writesBlocked(org)) {
    return {
      ok: false,
      status: 402,
      error: "Billing past due — update payment method before creating projects.",
    };
  }
  const used = await countOrgProjects(db, org.id);
  // First project (signup bootstrap) is allowed without a plan.
  if (used === 0) return { ok: true };

  if (!hasActivePaidPlan(org)) {
    return { ok: false, status: 402, error: SUBSCRIBE_PROJECTS };
  }
  const cap = maxProjects(org);
  if (cap === null) return { ok: true };
  if (used >= cap) {
    return {
      ok: false,
      status: 402,
      error: `Project limit reached (${used}/${cap}) for current plan.`,
    };
  }
  return { ok: true };
}
