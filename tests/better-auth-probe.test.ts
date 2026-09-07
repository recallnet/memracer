// tests/better-auth-probe.test.ts
//
// Regression-guards the three better-auth findings the integration depends
// on. Runs the same live,
// in-memory stand-up (Kysely over better-sqlite3) as scripts/better-auth-probe.ts
// and asserts the load-bearing conclusions. Verification-only — no src/ code is
// exercised; this keeps the documented answers honest against the pinned version.
import { describe, expect, it } from "vitest";
import { runProbe } from "../scripts/better-auth-probe.js";

describe("better-auth verification", () => {
  it("Q1: an API-key verify() does NOT carry a per-project org role", async () => {
    const r = await runProbe();

    // The verified key record models an owner + rate-limit + permissions/metadata,
    // but no organization/project role column.
    expect(r.q1.verifyCarriesOrgRole).toBe(false);
    expect(r.q1.verifiedKeyFields).not.toContain("role");
    expect(r.q1.verifiedKeyFields).not.toContain("organizationId");

    // The role must therefore resolve from member(userId, organizationId, role).
    expect(r.q1.memberRole).toBe("coder");

    // Keys are owned by `referenceId` (the userId by default) — not an org.
    expect(r.q1.keyOwnerField).toBe("referenceId");
  });

  it("Q3: the account table generates camelCase columns (Kysely + better-sqlite3)", async () => {
    const r = await runProbe();
    const account = r.tableColumns.account;
    expect(account).toBeDefined();

    // Exact column set/casing the adapter produced — the backfill SQL is keyed
    // to these names verbatim.
    expect(Object.keys(account).sort()).toEqual(
      [
        "accessToken",
        "accessTokenExpiresAt",
        "accountId",
        "createdAt",
        "id",
        "idToken",
        "password",
        "providerId",
        "refreshToken",
        "refreshTokenExpiresAt",
        "scope",
        "updatedAt",
        "userId",
      ].sort(),
    );

    // camelCase, not snake_case: the column is `accountId`, never `account_id`.
    expect(account).toHaveProperty("accountId");
    expect(account).not.toHaveProperty("account_id");
  });

  it("pins the versions the findings were verified against", async () => {
    const r = await runProbe();
    expect(r.versions.betterAuth).toBe("1.6.23");
    // Q2: in 1.6.x the apiKey plugin ships as the separate @better-auth/api-key.
    expect(r.versions.apiKeyPlugin).toBe("1.6.23");
  });
});
