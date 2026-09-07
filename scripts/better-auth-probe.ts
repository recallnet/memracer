/**
 * better-auth probe: verification harness for the better-auth integration.
 *
 * Stands up a live in-process better-auth instance (Kysely over better-sqlite3,
 * in-memory) and exercises three questions the integration depends on:
 *
 *   Q1 — does a single API-key verify() carry a per-project role, or must the
 *        role resolve from member(userId, organizationId, role)?
 *   Q2 — the correct CLI package/command for generate/migrate against the
 *        pinned version (see also the versions printed below).
 *   Q3 — the exact account-table column names/casing the Kysely+better-sqlite3
 *        adapter actually generates, so the backfill SQL is keyed to reality.
 *
 * Run: pnpm tsx scripts/better-auth-probe.ts
 *
 * Verification-only. Touches nothing in src/. The findings this prints are
 * regression-guarded by tests/better-auth-probe.test.ts.
 */
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { organization } from "better-auth/plugins";
// NOTE (Q2): in better-auth 1.6.x the apiKey plugin lives in its own package
// `@better-auth/api-key`; in the 1.4.x line it was in-core (`better-auth/plugins`).
import { apiKey } from "@better-auth/api-key";

export interface ProbeResult {
  versions: { betterAuth: string; apiKeyPlugin: string };
  /** Column name -> declared type, per better-sqlite3 pragma table_info. */
  tableColumns: Record<string, Record<string, string>>;
  q1: {
    /** Keys present on the verifyApiKey() result's key record. */
    verifiedKeyFields: string[];
    /** Did the verify() payload carry an organization/project role directly? */
    verifyCarriesOrgRole: boolean;
    /** The role read from member(userId, organizationId, role). */
    memberRole: string | null;
    /**
     * The apikey table's owner column. In 1.6.x this is `referenceId` (holds the
     * owning userId by default); there is no organizationId column on the key.
     */
    keyOwnerField: string;
  };
}

/** Build the same options object used for both the live instance and getMigrations(). */
export function probeOptions(db: Database.Database) {
  return {
    baseURL: "http://localhost:3000",
    secret: "probe-secret-0123456789-abcdefghijklmnop",
    emailAndPassword: { enabled: true },
    database: db,
    plugins: [organization(), apiKey()],
  } as const;
}

function pragmaColumns(db: Database.Database, table: string): Record<string, string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
    type: string;
  }>;
  const out: Record<string, string> = {};
  for (const r of rows) out[r.name] = r.type;
  return out;
}

export async function runProbe(): Promise<ProbeResult> {
  const db = new Database(":memory:");
  const options = probeOptions(db);

  // Apply better-auth's own migrations through the built-in Kysely adapter —
  // the same routine `@better-auth/cli migrate` calls (Q2).
  const { runMigrations } = await getMigrations(options);
  await runMigrations();

  const auth = betterAuth(options);

  // Read the schema the adapter actually generated (Q3).
  const interestingTables = ["account", "user", "session", "apikey", "member", "organization"];
  const existing = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
      name: string;
    }>).map((r) => r.name),
  );
  const tableColumns: Record<string, Record<string, string>> = {};
  for (const t of interestingTables) {
    if (existing.has(t)) tableColumns[t] = pragmaColumns(db, t);
  }

  // --- Q1: create a user, an org membership with a role, and an API key on the
  // user; then verify the key and inspect what the verify() payload carries. ---
  const signUp = await auth.api.signUpEmail({
    body: { email: "coder@example.com", password: "probe-password-123", name: "coder" },
  });
  const userId = signUp.user.id;

  const org = await auth.api.createOrganization({
    body: { name: "Acme Project", slug: "acme-project" },
    headers: new Headers(),
    // createOrganization needs the acting user; use a fresh session via the returned token.
    // We instead add the membership directly through the adapter below to stay deterministic.
  }).catch(() => null);

  // Deterministic membership: write member(userId, organizationId, role) via the
  // adapter so role resolution does not depend on session plumbing.
  const orgId = org?.id ?? "org-probe";
  if (!org) {
    db.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)",
    ).run(orgId, "Acme Project", "acme-project", new Date().toISOString());
  }
  const memberId = "member-probe";
  db.prepare(
    "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)",
  ).run(memberId, orgId, userId, "coder", new Date().toISOString());

  const created = await auth.api.createApiKey({
    body: { userId, name: "coder-key" },
  });

  const verified = await auth.api.verifyApiKey({
    body: { key: created.key },
  });

  const keyRecord = (verified as { key?: Record<string, unknown> }).key ?? {};
  const verifiedKeyFields = Object.keys(keyRecord).sort();
  // The apiKey record models an owning userId + optional metadata/permissions,
  // but no organizationId and no org role column — so a project role cannot ride
  // on verify() alone; it must be read from member(userId, organizationId, role).
  const verifyCarriesOrgRole =
    "role" in keyRecord || "organizationId" in keyRecord || "projectId" in keyRecord;

  const memberRow = db
    .prepare("SELECT role FROM member WHERE userId = ? AND organizationId = ?")
    .get(userId, orgId) as { role: string } | undefined;

  const apikeyCols = tableColumns.apikey ?? {};
  const keyOwnerField = "referenceId" in apikeyCols ? "referenceId" : "userId";

  db.close();

  return {
    versions: {
      betterAuth: readVersion("better-auth"),
      apiKeyPlugin: readVersion("@better-auth/api-key"),
    },
    tableColumns,
    q1: {
      verifiedKeyFields,
      verifyCarriesOrgRole,
      memberRole: memberRow?.role ?? null,
      keyOwnerField,
    },
  };
}

function readVersion(pkg: string): string {
  // Read the installed version without importing the package's ./package.json
  // subpath (blocked by exports). Resolve node_modules path directly.
  const url = new URL(`../node_modules/${pkg}/package.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")).version as string;
}

// Executed directly (not imported by the test): print a human-readable report.
if (import.meta.url === `file://${process.argv[1]}`) {
  runProbe()
    .then((r) => {
      console.log("=== better-auth probe ===");
      console.log("versions:", r.versions);
      console.log("\n--- Q3: account table columns (name: sqlite type) ---");
      console.log(r.tableColumns.account);
      console.log("\n--- Q1: API-key verify() payload ---");
      console.log("verified key fields:", r.q1.verifiedKeyFields.join(", "));
      console.log("verify carries org/project role:", r.q1.verifyCarriesOrgRole);
      console.log("role from member(userId, orgId):", r.q1.memberRole);
      console.log("apiKey owner field:", r.q1.keyOwnerField);
      console.log("\n(full table columns)");
      for (const [t, cols] of Object.entries(r.tableColumns)) {
        console.log(`  ${t}: ${Object.keys(cols).join(", ")}`);
      }
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
