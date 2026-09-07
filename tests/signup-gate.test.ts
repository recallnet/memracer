// Invite-only signup gate (MEMRACER_INVITE_ONLY). When the flag is set, a
// self-serve magic-link sign-in is rejected unless the email already belongs to
// a user or has a pending, unexpired invitation. Admin/server-side invites
// (metadata.purpose === "invite") and existing members keep working; with the
// flag unset, signup is open (unchanged).
//
// SQLite only: better-auth is disabled on the PGlite pool, so we open SQLite
// directly (see tests/helpers/auth.ts). The before-hook runs on both the HTTP
// router and direct auth.api calls (dispatchAuthEndpoint), so exercising the
// gate through auth.api.signInMagicLink hits the exact same pipeline the
// /api/auth/sign-in/magic-link endpoint does.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { openDb } from "../src/db.js";
import type { Db } from "../src/db.js";
import { authFor } from "../src/auth/instance.js";
import { betterAuthReady, seedMember, latestMagicLink } from "./helpers/auth.js";

interface MagicLinkApi {
  signInMagicLink(args: {
    body: { email: string; name?: string; callbackURL?: string; metadata?: Record<string, unknown> };
    headers: Headers;
  }): Promise<{ status: boolean }>;
}

const HEADERS = new Headers({ origin: "http://localhost:3000" });

function magicLinkApi(db: Db): MagicLinkApi {
  const handle = authFor(db);
  if (!handle) throw new Error("better-auth unavailable on this backend");
  return handle.auth.api as unknown as MagicLinkApi;
}

async function userCount(db: Db, email: string): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM "user" WHERE lower(email) = ?')
    .get<{ n: number }>(email.toLowerCase());
  return Number(row?.n ?? 0);
}

async function insertPendingInvite(
  db: Db,
  email: string,
  inviterId: string,
  ttlMs = 60_000,
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO "invitation" (id, "organizationId", email, role, status, "expiresAt", "createdAt", "inviterId")' +
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      randomUUID(),
      "demo",
      email.toLowerCase(),
      "human",
      "pending",
      new Date(Date.now() + ttlMs).toISOString(),
      new Date().toISOString(),
      inviterId,
    );
}

/** Attempt a self-serve magic-link sign-in; resolves true if allowed, false if the gate rejected it. */
async function attemptSignIn(
  db: Db,
  email: string,
  extra?: { metadata?: Record<string, unknown> },
): Promise<{ allowed: boolean; status?: string }> {
  try {
    await magicLinkApi(db).signInMagicLink({
      body: { email, callbackURL: "/dashboard", ...(extra?.metadata ? { metadata: extra.metadata } : {}) },
      headers: HEADERS,
    });
    return { allowed: true };
  } catch (err) {
    const status = (err as { status?: string }).status;
    return { allowed: false, status };
  }
}

let db: ReturnType<typeof openDb>;

beforeEach(async () => {
  db = openDb(":memory:");
  await betterAuthReady(db);
  await db.prepare("INSERT INTO projects (id, name) VALUES ('demo','Demo')").run();
});

afterEach(() => {
  delete process.env.MEMRACER_INVITE_ONLY;
});

describe("invite-only signup gate (MEMRACER_INVITE_ONLY)", () => {
  it("(a) rejects a self-serve sign-in for an unknown email — no user, no email sent", async () => {
    const email = "stranger@nowhere.test";
    process.env.MEMRACER_INVITE_ONLY = "1";

    const result = await attemptSignIn(db, email);

    expect(result.allowed).toBe(false);
    expect(result.status).toBe("FORBIDDEN");
    // No user was created for the rejected email...
    expect(await userCount(db, email)).toBe(0);
    // ...and no magic-link email was dispatched (the send never ran).
    expect(() => latestMagicLink(email)).toThrow();
  });

  it("(b) allows an existing member to sign in", async () => {
    const member = await seedMember(db, { name: "member", projectId: "demo", role: "human" });
    process.env.MEMRACER_INVITE_ONLY = "1";

    const result = await attemptSignIn(db, member.email);

    expect(result.allowed).toBe(true);
    // The send ran: a magic link was captured for the member.
    expect(latestMagicLink(member.email)).toContain("token=");
  });

  it("(c) allows an email that has a pending, unexpired invitation", async () => {
    const email = "invited@team.test";
    // A real admin issues the invite (satisfies invitation.inviterId FK).
    const admin = await seedMember(db, { name: "admin", projectId: "demo", role: "admin" });
    await insertPendingInvite(db, email, admin.userId);
    expect(await userCount(db, email)).toBe(0); // the invitee is not yet a user
    process.env.MEMRACER_INVITE_ONLY = "1";

    const result = await attemptSignIn(db, email);

    expect(result.allowed).toBe(true);
    expect(latestMagicLink(email)).toContain("token=");
  });

  it("(d) with the flag unset, an unknown email is allowed (open signup, unchanged)", async () => {
    const email = "open-signup@anywhere.test";
    // MEMRACER_INVITE_ONLY deliberately not set.

    const result = await attemptSignIn(db, email);

    expect(result.allowed).toBe(true);
    expect(latestMagicLink(email)).toContain("token=");
  });
});
