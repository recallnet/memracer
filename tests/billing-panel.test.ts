import { describe, expect, it } from "vitest";
import { buildCheckoutSessionParams } from "../src/billing/stripe.js";
import {
  billingStateAttr,
  isActivePaidBilling,
  showBillingPortalCard,
} from "../src/dashboard/web/components/org-settings-view.js";

describe("isActivePaidBilling", () => {
  it("is true for active solo/team/enterprise", () => {
    expect(isActivePaidBilling({ plan: "team", billingStatus: "active" })).toBe(true);
    expect(isActivePaidBilling({ plan: "solo", billingStatus: "active" })).toBe(true);
    expect(isActivePaidBilling({ plan: "enterprise", billingStatus: "active" })).toBe(true);
  });

  it("is false for unpaid or inactive", () => {
    expect(isActivePaidBilling({ plan: "none", billingStatus: "active" })).toBe(false);
    expect(isActivePaidBilling({ plan: "team", billingStatus: "none" })).toBe(false);
    expect(isActivePaidBilling({ plan: "team", billingStatus: "past_due" })).toBe(false);
    expect(isActivePaidBilling(null)).toBe(false);
  });

  it("drives plan-card active state for redesign primitives", () => {
    // Structure tests live in org-settings-ux; gate remains the shared predicate.
    expect(isActivePaidBilling({ plan: "team", billingStatus: "active" })).toBe(true);
    expect(isActivePaidBilling({ plan: "team", billingStatus: "past_due" })).toBe(false);
  });
});

describe("past_due portal card", () => {
  it("shows Manage billing for past_due when customer exists", () => {
    expect(showBillingPortalCard({
      plan: "team",
      billingStatus: "past_due",
      hasCustomer: true,
    })).toBe(true);
    expect(showBillingPortalCard({
      plan: "team",
      billingStatus: "past_due",
      hasCustomer: false,
    })).toBe(false);
    expect(showBillingPortalCard({
      plan: "none",
      billingStatus: "past_due",
      hasCustomer: true,
    })).toBe(false);
  });

  it("data-billing-state distinguishes past_due from unpaid", () => {
    expect(billingStateAttr({ plan: "team", billingStatus: "past_due" })).toBe("past_due");
    expect(billingStateAttr({ plan: "none", billingStatus: "none" })).toBe("unpaid");
    expect(billingStateAttr({ plan: "team", billingStatus: "active" })).toBe("active");
  });
});

describe("Checkout success URL", () => {
  it("lands on org-settings with billing=success", () => {
    const params = buildCheckoutSessionParams(
      { orgId: "org_1", plan: "team", seats: 4 },
      {
        MEMRACER_PUBLIC_URL: "https://memracer.example",
        STRIPE_TEAM_PRICE_ID: "price_team",
      },
    );
    expect(params.success_url).toContain("view=org-settings");
    expect(params.success_url).toContain("billing=success");
    expect(params.success_url).toContain("org=org_1");
    expect(params.cancel_url).toContain("view=org-settings");
  });
});
