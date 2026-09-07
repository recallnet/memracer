/**
 * Regression: billing_last_event_created must exist on Postgres after startup
 * migration even when the live orgs table predates the column (CREATE TABLE IF
 * NOT EXISTS is a no-op). SQLite ensureColumns already covers that dialect.
 */
import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { renderSchema } from "../src/db/schema.js";
import { applyStripeEvent } from "../src/billing/webhooks.js";
import { openPgliteDb } from "./helpers/pglite.js";

const env = {
  STRIPE_SOLO_PRICE_ID: "price_solo_test",
  STRIPE_TEAM_PRICE_ID: "price_team_test",
  MEMRACER_PUBLIC_URL: "https://memracer.com",
};

describe("billing_last_event_created on Postgres", () => {
  it("adds the column on re-boot when a legacy orgs table lacks it, and webhooks write the watermark", async () => {
    const db = await openPgliteDb();
    // Simulate a pre-#394 production orgs table: column present from fresh DDL
    // then dropped — the only path that matches CREATE TABLE IF NOT EXISTS no-op.
    await db.exec("ALTER TABLE orgs DROP COLUMN IF EXISTS billing_last_event_created");
    const missing = await db
      .prepare(
        `SELECT 1 AS ok FROM information_schema.columns
          WHERE table_name = 'orgs' AND column_name = 'billing_last_event_created'`,
      )
      .get<{ ok: number }>();
    expect(missing).toBeUndefined();

    // Startup re-applies renderSchema (PostgresDb.open path).
    await db.exec(renderSchema("postgres"));
    await db.exec(renderSchema("postgres")); // idempotent

    const present = await db
      .prepare(
        `SELECT data_type FROM information_schema.columns
          WHERE table_name = 'orgs' AND column_name = 'billing_last_event_created'`,
      )
      .get<{ data_type: string }>();
    expect(present?.data_type).toMatch(/bigint|integer/i);

    const now = Date.now();
    await db
      .prepare("INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)")
      .run("org-pg", "PG Org", now);

    const event = {
      id: "evt_pg_checkout",
      type: "checkout.session.completed",
      created: Math.floor(now / 1000),
      data: {
        object: {
          id: "cs_pg",
          customer: "cus_pg",
          subscription: "sub_pg",
          metadata: { memracer_org_id: "org-pg", plan: "team", seat_quantity: "4" },
          customer_details: { email: "pg@example.com" },
        },
      },
    } as unknown as Stripe.Event;

    const result = await applyStripeEvent(db, event, env);
    expect(result.applied).toBe(true);

    const org = await db
      .prepare(
        `SELECT plan, billing_status, billing_last_event_created, seat_quantity
           FROM orgs WHERE id = ?`,
      )
      .get<{
        plan: string;
        billing_status: string;
        billing_last_event_created: number | null;
        seat_quantity: number;
      }>("org-pg");
    expect(org?.plan).toBe("team");
    expect(org?.billing_status).toBe("active");
    expect(org?.seat_quantity).toBe(4);
    expect(org?.billing_last_event_created).toBe(Math.floor(now / 1000) * 1000);

    await db.close();
  });
});
