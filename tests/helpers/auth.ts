// Shared auth fixtures for the better-auth-only world (#90 — legacy static
// tokens deleted). A test that needs an authenticated caller mints a real
// better-auth identity: a user, an org (id == projectId) + member row carrying
// the role, and a headless API key that resolveMember() verifies. This is the
// direct replacement for the removed `INSERT INTO members/memberships` fixture.
//
// SQLite ONLY: better-auth is disabled on the PGlite test pool
// (authDatabase() → null), so suites that use these helpers open SQLite
// directly (openDb(":memory:")) rather than openTestDb(). betterAuthReady()
// makes that requirement explicit and fails loudly on a backend without it.
import { authFor, authReady, initAuth } from "../../src/auth/instance.js";
import { setEmailTransportForTests } from "../../src/email.js";
import type { Db } from "../../src/db.js";
import type { Role } from "../../src/auth.js";
import { makeSignature } from "better-auth/crypto";

let seq = 0;
const magicLinks = new Map<string, string>();

setEmailTransportForTests(async (message) => {
  const href = message.html.match(/href="([^"]+)"/)?.[1];
  if (!href) throw new Error("magic-link test transport received no link");
  magicLinks.set(message.to, href.replaceAll("&amp;", "&"));
});

export function latestMagicLink(email: string): string {
  const link = magicLinks.get(email);
  if (!link) throw new Error(`no magic link captured for ${email}`);
  return link;
}

interface AuthApi {
  signInMagicLink(args: {
    body: { email: string; name?: string; callbackURL?: string };
    headers: Headers;
  }): Promise<{ status: boolean }>;
  magicLinkVerify(args: {
    query: { token: string };
    headers: Headers;
  }): Promise<{ session: { token: string }; user: { id: string } }>;
  createApiKey(args: {
    body: { userId: string; name: string; metadata?: Record<string, unknown> };
  }): Promise<{ key: string }>;
}

function api(db: Db): AuthApi {
  initAuth(db);
  const handle = authFor(db);
  if (!handle) {
    throw new Error(
      "better-auth is not available on this backend — open SQLite with openDb(\":memory:\") and call authReady() (the PGlite pool disables better-auth).",
    );
  }
  return handle.auth.api as unknown as AuthApi;
}

const AUTH_SECRET = "memracer-dev-better-auth-secret-0123456789-abcdef";
const AUTH_HEADERS = new Headers({ origin: "http://localhost:3000" });

async function verifyMagicLink(db: Db, email: string, name?: string): Promise<{ userId: string; sessionToken: string }> {
  const auth = api(db);
  await auth.signInMagicLink({ body: { email, ...(name ? { name } : {}), callbackURL: "/dashboard" }, headers: AUTH_HEADERS });
  const link = latestMagicLink(email);
  const token = new URL(link).searchParams.get("token");
  if (!token) throw new Error("captured magic link has no token");
  const verified = await auth.magicLinkVerify({ query: { token }, headers: AUTH_HEADERS });
  return { userId: verified.user.id, sessionToken: verified.session.token };
}

/** Seed or authenticate a passwordless browser session and return its signed cookie. */
export async function magicLinkSessionCookie(db: Db, email: string, name?: string): Promise<string> {
  await betterAuthReady(db);
  const { sessionToken } = await verifyMagicLink(db, email, name);
  const signature = await makeSignature(sessionToken, process.env.BETTER_AUTH_SECRET || AUTH_SECRET);
  return `better-auth.session_token=${sessionToken}.${signature}`;
}

/**
 * Build (if needed) and await the better-auth instance for a Db. Call once
 * after openDb, before seeding identities — createApp also calls initAuth, but
 * a helper that seeds before createApp must trigger it here.
 */
export async function betterAuthReady(db: Db): Promise<void> {
  initAuth(db);
  await authReady(db);
}

/** Create the better-auth organization for a project (id == projectId). Idempotent. */
async function ensureOrg(db: Db, projectId: string, projectName: string): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO "organization" (id, name, slug, "createdAt") VALUES (?, ?, ?, ?)')
    .run(projectId, projectName, projectId, new Date().toISOString());
}

/** Grant an existing better-auth user a role on a project (adds the member row). */
export async function grantMembership(
  db: Db,
  userId: string,
  opts: { projectId: string; projectName?: string; role: Role },
): Promise<void> {
  await ensureOrg(db, opts.projectId, opts.projectName ?? opts.projectId);
  await db
    .prepare(
      'INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES (?, ?, ?, ?, ?)',
    )
    .run(`mem-${userId}-${opts.projectId}`, opts.projectId, userId, opts.role, new Date().toISOString());
}

export interface SeededMember {
  /** A better-auth API key usable as `Bearer ${token}`. */
  token: string;
  /** Stable database identity for the minted API-key seat. */
  keyId: string;
  userId: string;
  email: string;
}

/**
 * Seed a better-auth identity with a role on a project and return a usable API
 * key. The project's `projects` row must already exist (membershipsForUser
 * JOINs it); this creates the better-auth organization + member + API key.
 */
export async function seedMember(
  db: Db,
  opts: {
    name: string;
    projectId: string;
    projectName?: string;
    role: Role;
    metadata?: Record<string, unknown>;
    /** Set false only for fail-closed legacy-key regression tests. */
    projectScopedKey?: boolean;
  },
): Promise<SeededMember> {
  await betterAuthReady(db);
  const a = api(db);
  const email = `${opts.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "user"}-${++seq}@test.local`;
  const { userId } = await verifyMagicLink(db, email, opts.name);
  await grantMembership(db, userId, opts);
  const metadata = opts.projectScopedKey === false
    ? opts.metadata
    : {
        projectId: opts.projectId,
        // Admin is not a mintable seat type. Keep those broad-role test keys
        // untyped so they exercise the legacy membership-role compatibility
        // branch; explicit human/coder seats exercise credential role pinning.
        ...(opts.role === "admin" ? {} : { type: opts.role }),
        ...opts.metadata,
      };
  const created = await a.createApiKey({ body: { userId, name: opts.name, metadata } });
  const stored = await db
    .prepare('SELECT id FROM apikey WHERE "referenceId" = ? AND name = ? ORDER BY "createdAt" DESC LIMIT 1')
    .get<{ id: string }>(userId, opts.name);
  if (!stored) throw new Error(`seeded API key ${opts.name} was not persisted`);
  return { token: created.key, keyId: stored.id, userId, email };
}

/**
 * Mint a static API-key seat for an EXISTING user, pinned to a project + role.
 * Mirrors the seat rows the retired mint UI used to create, so tests can assert
 * seat-list rendering (or revoke) without driving the removed mint form — the
 * single onboarding path is now a generated enrollment prompt, not a named key.
 */
export async function seedProjectSeat(
  db: Db,
  opts: { userId: string; name: string; projectId: string; type: Role },
): Promise<{ keyId: string }> {
  await betterAuthReady(db);
  const a = api(db);
  await a.createApiKey({
    body: {
      userId: opts.userId,
      name: opts.name,
      metadata: { projectId: opts.projectId, type: opts.type },
    },
  });
  const stored = await db
    .prepare('SELECT id FROM apikey WHERE "referenceId" = ? AND name = ? ORDER BY "createdAt" DESC LIMIT 1')
    .get<{ id: string }>(opts.userId, opts.name);
  if (!stored) throw new Error(`seeded seat ${opts.name} was not persisted`);
  return { keyId: stored.id };
}

/** Sign in an already-seeded user and return the session cookie header value. */
export async function sessionCookie(db: Db, email: string): Promise<string> {
  return magicLinkSessionCookie(db, email);
}
