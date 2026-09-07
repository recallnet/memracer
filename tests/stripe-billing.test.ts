import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import {
  assertStripeSecretKey,
  buildCheckoutSessionParams,
  checkoutIdempotencyKey,
  createCheckoutSession,
  portalIdempotencyKey,
} from "../src/billing/stripe.js";
import { applyStripeEvent, recordStripeEvent } from "../src/billing/webhooks.js";
import { assertCanAddProject, assertCanAddSeat, maxProjects, maxSeats } from "../src/billing/limits.js";
import type Stripe from "stripe";

const env = {
  STRIPE_SOLO_PRICE_ID: "price_solo_test",
  STRIPE_TEAM_PRICE_ID: "price_team_test",
  STRIPE_INTERNAL_COUPON_ID: "jUhACNLx",
  STRIPE_INTERNAL_ORG_IDS: "org-internal",
  MEMRACER_PUBLIC_URL: "https://memracer.com",
};

describe("assertStripeSecretKey", () => {
  it("refuses sk_test_ when NODE_ENV is production", () => {
    expect(() =>
      assertStripeSecretKey("sk_test_abc", { NODE_ENV: "production" }),
    ).toThrow(/test secret key/i);
  });

  it("allows sk_live_ in production and sk_test_ in non-production", () => {
    expect(() =>
      assertStripeSecretKey("sk_live_abc", { NODE_ENV: "production" }),
    ).not.toThrow();
    expect(() =>
      assertStripeSecretKey("sk_test_abc", { NODE_ENV: "development" }),
    ).not.toThrow();
  });
});

describe("buildCheckoutSessionParams", () => {
  it("does not enable allow_promotion_codes for external (real) customers", () => {
    const params = buildCheckoutSessionParams(
      { orgId: "org-external", plan: "team", seats: 4 },
      env,
    );
    expect(params.mode).toBe("subscription");
    expect(params.allow_promotion_codes).toBeUndefined();
    expect(params.line_items).toEqual([{ price: "price_team_test", quantity: 4 }]);
    expect(params.metadata?.memracer_org_id).toBe("org-external");
    expect(params.discounts).toBeUndefined();
  });

  it("applies STRIPE_INTERNAL_COUPON_ID for allowlisted orgs (Team×4 bootstrap)", () => {
    const params = buildCheckoutSessionParams(
      { orgId: "org-internal", plan: "team", seats: 4 },
      env,
    );
    expect(params.discounts).toEqual([{ coupon: "jUhACNLx" }]);
    // Stripe forbids allow_promotion_codes with discounts
    expect(params.allow_promotion_codes).toBeUndefined();
    expect(params.line_items?.[0]).toEqual({ price: "price_team_test", quantity: 4 });
  });

  it("exposes stable checkout and portal idempotency keys", () => {
    expect(checkoutIdempotencyKey({ orgId: "o1", plan: "team", seats: 4 })).toBe(
      "checkout:o1:team:4",
    );
    expect(portalIdempotencyKey("cus_1")).toBe("portal:cus_1");
  });

  it("passes idempotencyKey into Stripe checkout session create", async () => {
    const create = vi.fn(async () => ({ id: "cs_1", url: "https://checkout.example/s" }));
    const stripe = { checkout: { sessions: { create } } } as unknown as Stripe;
    const result = await createCheckoutSession(
      stripe,
      { orgId: "org-x", plan: "solo", seats: 2 },
      env,
    );
    expect(result.idempotencyKey).toBe("checkout:org-x:solo:2");
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][1]).toEqual({ idempotencyKey: "checkout:org-x:solo:2" });
  });
});

describe("seat/project caps (no free tier)", () => {
  it("caps Solo at 15 seats / 5 projects when active", () => {
    expect(maxSeats({ id: "o", plan: "solo", seat_quantity: 15, billing_status: "active" })).toBe(15);
    expect(maxProjects({ id: "o", plan: "solo", seat_quantity: 15, billing_status: "active" })).toBe(5);
  });

  it("unpaid orgs cannot invite (not a free multi-seat tier)", async () => {
    const db = openDb(":memory:");
    await db.prepare("INSERT INTO orgs (id, name, created_at, plan, billing_status) VALUES (?, ?, ?, ?, ?)")
      .run("org1", "O", Date.now(), "none", "none");
    const seat = await assertCanAddSeat(db, { id: "org1", plan: "none", seat_quantity: 0, billing_status: "none" });
    expect(seat.ok).toBe(false);
    if (!seat.ok) {
      expect(seat.status).toBe(402);
      expect(seat.error).toMatch(/billing|Checkout/i);
    }
    await db.close();
  });

  it("unpaid orgs may keep one bootstrap project only", async () => {
    const db = openDb(":memory:");
    const now = Date.now();
    await db.prepare("INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)").run("org1", "O", now);
    const first = await assertCanAddProject(db, { id: "org1", plan: "none", seat_quantity: 0, billing_status: "none" });
    expect(first.ok).toBe(true);
    await db.prepare("INSERT INTO projects (id, name, org_id, mediator_model) VALUES (?, ?, ?, ?)")
      .run("p0", "P0", "org1", "z-ai/glm-5.2");
    const second = await assertCanAddProject(db, { id: "org1", plan: "none", seat_quantity: 0, billing_status: "none" });
    expect(second.ok).toBe(false);
    await db.close();
  });

  it("blocks past_due writes", async () => {
    const db = openDb(":memory:");
    await db.prepare("INSERT INTO orgs (id, name, created_at, plan, seat_quantity, billing_status) VALUES (?, ?, ?, ?, ?, ?)")
      .run("org1", "O", Date.now(), "team", 10, "past_due");
    const seat = await assertCanAddSeat(db, { id: "org1", plan: "team", seat_quantity: 10, billing_status: "past_due" });
    expect(seat.ok).toBe(false);
    if (!seat.ok) expect(seat.status).toBe(402);
    await db.close();
  });

  it("enforces project cap for active solo", async () => {
    const db = openDb(":memory:");
    const now = Date.now();
    await db.prepare("INSERT INTO orgs (id, name, created_at, plan, seat_quantity, billing_status) VALUES (?, ?, ?, ?, ?, ?)")
      .run("org1", "O", now, "solo", 5, "active");
    for (let i = 0; i < 5; i++) {
      await db.prepare("INSERT INTO projects (id, name, org_id, mediator_model) VALUES (?, ?, ?, ?)")
        .run(`p${i}`, `P${i}`, "org1", "z-ai/glm-5.2");
    }
    const gate = await assertCanAddProject(db, { id: "org1", plan: "solo", seat_quantity: 5, billing_status: "active" });
    expect(gate.ok).toBe(false);
    await db.close();
  });
});

describe("stripe webhook durability + caps", () => {
  it("does not record event id when apply fails so Stripe can retry", async () => {
    const db = openDb(":memory:");
    // No org row — apply fails to attach.
    const event = {
      id: "evt_fail_apply",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_fail",
          customer: "cus_x",
          subscription: "sub_x",
          metadata: { memracer_org_id: "missing-org", plan: "team", seat_quantity: "4" },
        },
      },
    } as unknown as Stripe.Event;
    // updateOrgById runs against missing org — still "applied" (0 rows). Use no org id path.
    const noOrg = {
      id: "evt_fail_no_org",
      type: "checkout.session.completed",
      data: { object: { id: "cs_no", customer: "cus_x", metadata: {} } },
    } as unknown as Stripe.Event;
    const result = await applyStripeEvent(db, noOrg, env);
    expect(result.applied).toBe(false);
    expect(result.reason).toMatch(/no org/i);
    const recorded = await db.prepare("SELECT event_id FROM stripe_events WHERE event_id = ?")
      .get("evt_fail_no_org");
    expect(recorded).toBeUndefined();
    // Retry still not duplicate-poisoned
    const retry = await applyStripeEvent(db, noOrg, env);
    expect(retry.reason).toMatch(/no org/i);
    await db.close();
  });

  it("checkout.session.completed sets seat_quantity from metadata and refuses unknown plan→team", async () => {
    const db = openDb(":memory:");
    const now = Date.now();
    await db.prepare("INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)").run("org-c", "C", now);
    const good = {
      id: "evt_checkout_seats",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_good",
          customer: "cus_c",
          subscription: "sub_c",
          metadata: { memracer_org_id: "org-c", plan: "team", seat_quantity: "4" },
          customer_details: { email: "a@example.com" },
        },
      },
    } as unknown as Stripe.Event;
    await applyStripeEvent(db, good, env);
    const org = await db.prepare(
      "SELECT plan, seat_quantity, billing_status FROM orgs WHERE id = ?",
    ).get<{ plan: string; seat_quantity: number; billing_status: string }>("org-c");
    expect(org?.plan).toBe("team");
    expect(org?.seat_quantity).toBe(4);
    expect(org?.billing_status).toBe("active");

    await db.prepare("INSERT INTO orgs (id, name, created_at, plan, billing_status) VALUES (?, ?, ?, ?, ?)")
      .run("org-u", "U", now, "none", "none");
    const unknown = {
      id: "evt_checkout_unknown",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_u",
          customer: "cus_u",
          subscription: "sub_u",
          metadata: { memracer_org_id: "org-u", plan: "enterprise-ish" },
        },
      },
    } as unknown as Stripe.Event;
    await applyStripeEvent(db, unknown, env);
    const orgU = await db.prepare(
      "SELECT plan, billing_status, stripe_customer_id FROM orgs WHERE id = ?",
    ).get<{ plan: string; billing_status: string; stripe_customer_id: string }>("org-u");
    // Fail closed: do not invent Team; customer still attached for portal later.
    expect(orgU?.plan).toBe("none");
    expect(orgU?.billing_status).toBe("none");
    expect(orgU?.stripe_customer_id).toBe("cus_u");
    await db.close();
  });

  it("pending invites consume seat capacity; existing org members do not", async () => {
    const db = openDb(":memory:");
    const now = Date.now();
    await db.prepare(
      "INSERT INTO orgs (id, name, created_at, plan, seat_quantity, billing_status) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("org1", "O", now, "team", 2, "active");
    await db.prepare("INSERT INTO projects (id, name, org_id, mediator_model) VALUES (?, ?, ?, ?)")
      .run("p1", "P1", "org1", "z-ai/glm-5.2");
    // Minimal better-auth-shaped tables (openDb does not create them without auth init).
    await db.exec(`
      CREATE TABLE IF NOT EXISTS "user" (
        id TEXT PRIMARY KEY, name TEXT, email TEXT, "emailVerified" INTEGER,
        "createdAt" TEXT, "updatedAt" TEXT
      );
      CREATE TABLE IF NOT EXISTS "member" (
        id TEXT PRIMARY KEY, "organizationId" TEXT, "userId" TEXT, role TEXT, "createdAt" TEXT
      );
      CREATE TABLE IF NOT EXISTS "invitation" (
        id TEXT PRIMARY KEY, "organizationId" TEXT, email TEXT, role TEXT, status TEXT,
        "expiresAt" TEXT, "createdAt" TEXT, "inviterId" TEXT, token TEXT
      );
    `);
    await db.prepare(
      `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, 1, ?, ?)`,
    ).run("u1", "Ada", "ada@example.com", new Date(now).toISOString(), new Date(now).toISOString());
    await db.prepare(
      `INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES (?, ?, ?, ?, ?)`,
    ).run("m1", "p1", "u1", "admin", new Date(now).toISOString());
    // One seat filled (ada). Cap 2. One pending invite → commitments 2 → cannot invite more.
    await db.prepare(
      `INSERT INTO "invitation" (id, "organizationId", email, role, status, "expiresAt", "createdAt", "inviterId", token)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "inv1",
      "p1",
      "bob@example.com",
      "human",
      "pending",
      new Date(now + 864e5).toISOString(),
      new Date(now).toISOString(),
      "u1",
      "tok1",
    );
    const { countOrgSeatCommitments } = await import("../src/billing/limits.js");
    expect(await countOrgSeatCommitments(db, "org1")).toBe(2);
    const gate = await assertCanAddSeat(db, { id: "org1", plan: "team", seat_quantity: 2, billing_status: "active" });
    expect(gate.ok).toBe(false);

    // Existing member invite does not need a free seat.
    const existing = await assertCanAddSeat(
      db,
      { id: "org1", plan: "team", seat_quantity: 2, billing_status: "active" },
      { existingOrgMember: true },
    );
    expect(existing.ok).toBe(true);
    await db.close();
  });
});

describe("stripe webhook idempotency + org attach", () => {
  it("dedupes events and activates Team×4 without deleting projects", async () => {
    const db = openDb(":memory:");
    const now = Date.now();
    await db.prepare("INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)").run("org-live", "Live", now);
    await db.prepare("INSERT INTO projects (id, name, org_id, mediator_model) VALUES (?, ?, ?, ?)")
      .run("proj-a", "A", "org-live", "z-ai/glm-5.2");
    await db.prepare("INSERT INTO projects (id, name, org_id, mediator_model) VALUES (?, ?, ?, ?)")
      .run("proj-b", "B", "org-live", "z-ai/glm-5.2");

    const event = {
      id: "evt_test_1",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test",
          customer: "cus_test",
          subscription: "sub_test",
          client_reference_id: "org-live",
          metadata: { memracer_org_id: "org-live", plan: "team" },
          customer_details: { email: "ops@example.com" },
        },
      },
    } as unknown as Stripe.Event;

    const first = await applyStripeEvent(db, event, env);
    expect(first.applied).toBe(true);
    const second = await applyStripeEvent(db, event, env);
    expect(second.applied).toBe(false);
    expect(second.reason).toBe("duplicate");

    const org = await db.prepare(
      "SELECT plan, billing_status, stripe_customer_id, stripe_subscription_id, billing_email FROM orgs WHERE id = ?",
    ).get<{
      plan: string;
      billing_status: string;
      stripe_customer_id: string;
      stripe_subscription_id: string;
      billing_email: string;
    }>("org-live");
    expect(org?.plan).toBe("team");
    expect(org?.billing_status).toBe("active");
    expect(org?.stripe_customer_id).toBe("cus_test");
    expect(org?.stripe_subscription_id).toBe("sub_test");

    const projects = await db.prepare("SELECT COUNT(*) AS n FROM projects WHERE org_id = ?").get<{ n: number }>("org-live");
    expect(projects?.n).toBe(2);

    // subscription update sets seats
    const subEvent = {
      id: "evt_test_2",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_test",
          customer: "cus_test",
          status: "active",
          current_period_end: Math.floor(Date.now() / 1000) + 86400,
          metadata: { memracer_org_id: "org-live", plan: "team" },
          items: { data: [{ quantity: 4, price: { id: "price_team_test" } }] },
        },
      },
    } as unknown as Stripe.Event;
    await applyStripeEvent(db, subEvent, env);
    const org2 = await db.prepare("SELECT seat_quantity, plan FROM orgs WHERE id = ?")
      .get<{ seat_quantity: number; plan: string }>("org-live");
    expect(org2?.seat_quantity).toBe(4);
    expect(org2?.plan).toBe("team");

    const again = await recordStripeEvent(db, "evt_test_2");
    expect(again).toBe("duplicate");

    await db.close();
  });
});

describe("stripe webhook ordering after cancel", () => {
  it("does not re-activate from a stale active event after cancel", async () => {
    const db = openDb(":memory:");
    const now = Date.now();
    await db.prepare("INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)").run("org-o", "O", now);

    const t0 = Math.floor(now / 1000) - 3600;
    const t1 = t0 + 100;
    const t2 = t0 + 200; // cancel is newest

    await applyStripeEvent(db, {
      id: "evt_active_old",
      type: "customer.subscription.updated",
      created: t1,
      data: {
        object: {
          id: "sub_o",
          customer: "cus_o",
          status: "active",
          current_period_end: t1 + 86400,
          metadata: { memracer_org_id: "org-o", plan: "team" },
          items: { data: [{ quantity: 4, price: { id: "price_team_test" } }] },
        },
      },
    } as unknown as Stripe.Event, env);

    let org = await db.prepare("SELECT plan, billing_status FROM orgs WHERE id=?")
      .get<{ plan: string; billing_status: string }>("org-o");
    expect(org?.billing_status).toBe("active");

    await applyStripeEvent(db, {
      id: "evt_cancel",
      type: "customer.subscription.deleted",
      created: t2,
      data: {
        object: {
          id: "sub_o",
          customer: "cus_o",
          status: "canceled",
          current_period_end: t2,
          metadata: { memracer_org_id: "org-o", plan: "team" },
          items: { data: [{ quantity: 4, price: { id: "price_team_test" } }] },
        },
      },
    } as unknown as Stripe.Event, env);

    org = await db.prepare("SELECT plan, billing_status FROM orgs WHERE id=?")
      .get<{ plan: string; billing_status: string }>("org-o");
    expect(org?.billing_status).toBe("canceled");
    expect(org?.plan).toBe("none");

    // Late replay of older "active" update — must not revive the plan.
    const stale = await applyStripeEvent(db, {
      id: "evt_active_stale",
      type: "customer.subscription.updated",
      created: t0,
      data: {
        object: {
          id: "sub_o",
          customer: "cus_o",
          status: "active",
          current_period_end: t0 + 86400,
          metadata: { memracer_org_id: "org-o", plan: "team" },
          items: { data: [{ quantity: 4, price: { id: "price_team_test" } }] },
        },
      },
    } as unknown as Stripe.Event, env);
    expect(stale.applied).toBe(false);
    expect(stale.reason).toMatch(/stale/i);

    org = await db.prepare("SELECT plan, billing_status FROM orgs WHERE id=?")
      .get<{ plan: string; billing_status: string }>("org-o");
    expect(org?.billing_status).toBe("canceled");
    expect(org?.plan).toBe("none");

    await db.close();
  });
});
