/**
 * Seat plan catalog (product pricing). Price IDs come from env (Stripe test/live).
 */

export type BillingPlan = "solo" | "team" | "enterprise" | "none";
export type BillingStatus = "none" | "active" | "past_due" | "canceled" | "incomplete";

export const PLAN_LIMITS: Record<
  Exclude<BillingPlan, "none" | "enterprise">,
  { maxSeats: number; maxProjects: number; listPriceCents: number }
> = {
  solo: { maxSeats: 15, maxProjects: 5, listPriceCents: 500 },
  team: { maxSeats: 100, maxProjects: 25, listPriceCents: 2900 },
};

export function priceIdForPlan(plan: "solo" | "team", env: NodeJS.ProcessEnv = process.env): string | null {
  if (plan === "solo") return env.STRIPE_SOLO_PRICE_ID?.trim() || null;
  return env.STRIPE_TEAM_PRICE_ID?.trim() || null;
}

export function planFromPriceId(priceId: string | null | undefined, env: NodeJS.ProcessEnv = process.env): BillingPlan {
  if (!priceId) return "none";
  if (priceId === env.STRIPE_SOLO_PRICE_ID) return "solo";
  if (priceId === env.STRIPE_TEAM_PRICE_ID) return "team";
  return "none";
}

export function isInternalOrg(orgId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.STRIPE_INTERNAL_ORG_IDS?.trim();
  if (!raw) return false;
  return raw.split(",").map((s) => s.trim()).filter(Boolean).includes(orgId);
}

export function publicUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.MEMRACER_PUBLIC_URL || env.BETTER_AUTH_URL || "https://memracer.com").replace(/\/$/, "");
}
