// tests/auth-betterauth-only.test.ts
//
// #90 — better-auth is the ONLY auth. The legacy static-token path, the
// MEMRACER_LEGACY_TOKENS flag, and the members/memberships tables are gone.
// This suite pins the four load-bearing guarantees of the cutover:
//   (a) a better-auth session authenticates a human,
//   (b) a coder's API key authenticates and resolves exactly the coder role,
//   (c) a legacy-shaped static token is REJECTED (no flag brings it back),
//   (d) role fidelity holds — a key/session confers only its granted role.
// SQLite in-memory: better-auth's verified backend (the PGlite pool disables it).
import { describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db.js";
import { resolveMember, resolveSession } from "../src/auth.js";
import { authFor } from "../src/auth/instance.js";
import { betterAuthReady, latestMagicLink, seedMember, grantMembership, sessionCookie } from "./helpers/auth.js";

async function fresh(): Promise<Db> {
  const db = openDb(":memory:");
  await betterAuthReady(db);
  return db;
}

describe("#90 better-auth-only — the legacy tables are gone", () => {
  it("neither members nor memberships exists in the schema", async () => {
    const db = await fresh();
    const tables = new Set(
      (
        await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<{ name: string }>()
      ).map((r) => r.name),
    );
    expect(tables.has("members")).toBe(false);
    expect(tables.has("memberships")).toBe(false);
    // better-auth's own identity tables are present.
    for (const t of ["user", "session", "organization", "member", "apikey"]) {
      expect(tables.has(t), `expected better-auth table ${t}`).toBe(true);
    }
    await db.close();
  });
});

describe("#90 (a) a better-auth session authenticates a human", () => {
  it("resolveSession maps a signed-in human's cookie to their Member", async () => {
    const db = await fresh();
    await db.prepare("INSERT INTO projects (id, name, repo) VALUES (?, ?, ?)").run("alpha", "Alpha", "recallnet/alpha");
    const human = await seedMember(db, { name: "Ada", projectId: "alpha", projectName: "Alpha", role: "human" });
    const cookie = await sessionCookie(db, human.email);
    expect(cookie).toContain("session_token");
    const member = await resolveSession(db, { cookie });
    expect(member).not.toBeNull();
    expect(member!.name).toBe("Ada");
    expect(member!.memberships).toEqual([
      { projectId: "alpha", projectName: "Alpha", repo: "recallnet/alpha", role: "human", orgId: null, orgName: null },
    ]);
    await db.close();
  });

  it("magic-link verification stores a hash, expires in 15 minutes, and rejects replay", async () => {
    const db = await fresh();
    const auth = authFor(db)!.auth.api as any;
    const email = "magic-link-replay@test.local";
    const headers = new Headers({ origin: "http://localhost:3000" });
    await auth.signInMagicLink({ body: { email, callbackURL: "/dashboard" }, headers });
    const link = latestMagicLink(email);
    const token = new URL(link).searchParams.get("token");
    expect(token).toBeTruthy();
    const stored = await db
      .prepare('SELECT identifier, value, "expiresAt" FROM verification ORDER BY "createdAt" DESC LIMIT 1')
      .get<{ identifier: string; value: string; expiresAt: string }>();
    expect(stored).toBeTruthy();
    expect(stored!.identifier).not.toBe(token);
    expect(JSON.parse(stored!.value)).toMatchObject({ email });
    expect(new Date(stored!.expiresAt).getTime()).toBeGreaterThan(Date.now() + 14 * 60 * 1000);

    await auth.magicLinkVerify({ query: { token }, headers });
    await expect(auth.magicLinkVerify({ query: { token }, headers })).rejects.toThrow();
    await db.close();
  });
});

describe("#90 (b) a coder API key authenticates and resolves the coder role", () => {
  it("resolveMember maps a coder's Bearer API key to exactly the coder role", async () => {
    const db = await fresh();
    await db.prepare("INSERT INTO projects (id, name, repo) VALUES (?, ?, ?)").run("memracer", "memracer", "recallnet/memracer");
    const coder = await seedMember(db, { name: "coder-fleet", projectId: "memracer", role: "coder" });
    const member = await resolveMember(db, `Bearer ${coder.token}`);
    expect(member).not.toBeNull();
    expect(member!.memberships).toEqual([
      { projectId: "memracer", projectName: "memracer", repo: "recallnet/memracer", role: "coder", orgId: null, orgName: null },
    ]);
    // role fidelity: the key confers coder, never an elevated role.
    expect(member!.memberships.every((m) => m.role === "coder")).toBe(true);
    await db.close();
  });
});

describe("typed API-key seats", () => {
  it("uses the credential role without changing the owner's Project membership", async () => {
    const db = await fresh();
    await db.prepare("INSERT INTO projects (id, name, repo) VALUES (?, ?, ?)").run("alpha", "Alpha", null);
    const owner = await seedMember(db, { name: "Admin", projectId: "alpha", role: "admin" });
    const key = await authFor(db)!.auth.api.createApiKey({
      body: { userId: owner.userId, name: "Coder seat", metadata: { projectId: "alpha", type: "coder" } },
    });
    expect(await resolveMember(db, `Bearer ${key.key}`)).toMatchObject({
      memberships: [{ projectId: "alpha", role: "coder" }],
    });
    const stored = await db.prepare('SELECT role FROM "member" WHERE "userId" = ? AND "organizationId" = ?')
      .get<{ role: string }>(owner.userId, "alpha");
    expect(stored?.role).toBe("admin");
    await db.close();
  });
});

describe("#90 (c) a legacy static token is REJECTED", () => {
  it("a Bearer that is not a better-auth API key resolves to null — even with the old flag set", async () => {
    const db = await fresh();
    await db.prepare("INSERT INTO projects (id, name, repo) VALUES (?, ?, ?)").run("memracer", "memracer", null);
    // The old seeded shape and the retired flag no longer grant anything.
    process.env.MEMRACER_LEGACY_TOKENS = "1";
    expect(await resolveMember(db, "Bearer mr_seeded_legacy_token")).toBeNull();
    expect(await resolveMember(db, "Bearer coder-fleet")).toBeNull();
    delete process.env.MEMRACER_LEGACY_TOKENS;
    await db.close();
  });
});

describe("#101 API-key project scope and browser-session identity scope", () => {
  it("an API key exposes only its declared project while a browser session still exposes all projects", async () => {
    const db = await fresh();
    await db.prepare("INSERT INTO projects (id, name, repo) VALUES (?, ?, ?)").run("p-human", "P Human", null);
    await db.prepare("INSERT INTO projects (id, name, repo) VALUES (?, ?, ?)").run("p-coder", "P Coder", null);
    const m = await seedMember(db, { name: "mara", projectId: "p-human", projectName: "P Human", role: "human" });
    await grantMembership(db, m.userId, { projectId: "p-coder", projectName: "P Coder", role: "coder" });
    const apiMember = await resolveMember(db, `Bearer ${m.token}`);
    expect(apiMember!.memberships.map((x) => [x.projectId, x.role])).toEqual([["p-human", "human"]]);

    const cookie = await sessionCookie(db, m.email);
    const browserMember = await resolveSession(db, { cookie });
    expect(browserMember!.memberships.map((x) => [x.projectId, x.role])).toEqual([
      ["p-coder", "coder"],
      ["p-human", "human"],
    ]);
    await db.close();
  });
});
