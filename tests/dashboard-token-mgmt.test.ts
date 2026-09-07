// tests/dashboard-token-mgmt.test.ts
//
// Task 0 of the account/team/project/token plan: the token-management surface
// the dashboard UI drives — create a project API key (tagged human|coder),
// list the caller's keys for a project (never the secret), revoke one, and
// list a project's members. All of it rides better-auth's apikey/org plugins,
// so these tests force the SQLite backend (better-auth is disabled on the
// PGlite pool) via openDb(":memory:") — mirroring better-auth-phase2.test.ts.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { openDb, type Db } from "../src/db.js";
import { authReady } from "../src/auth/instance.js";
import { createApp } from "../src/server.js";
import { FakeDriver } from "../src/mediator/fake.js";
import type { MediatorWorker } from "../src/mediator/worker.js";
import { magicLinkSessionCookie } from "./helpers/auth.js";

let httpServer: Server;
let baseUrl: string;
let worker: MediatorWorker;
let dbRef: Db;

/** Sign a human up + in, returning their user id and a Cookie header value. */
async function signInHuman(db: Db, email: string, name: string): Promise<{ userId: string; cookie: string }> {
  const cookie = await magicLinkSessionCookie(db, email, name);
  const userId = (await db.prepare('SELECT id FROM "user" WHERE email = ?').get<{ id: string }>(email))!.id;
  return { userId, cookie };
}

/** A member row (organizationId ↔ projects.id) so the caller passes scoped().
 *  member.organizationId FKs the better-auth organization table, so ensure a
 *  matching org row (id = project id, as the backfill lays it down). */
async function grantMembership(db: Db, userId: string, projectId: string, role: string): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO "organization" (id, name, slug, "createdAt") VALUES (?, ?, ?, ?)')
    .run(projectId, projectId, projectId, new Date().toISOString());
  await db
    .prepare('INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES (?, ?, ?, ?, ?)')
    .run(`${userId}-${projectId}`, projectId, userId, role, new Date().toISOString());
}

let cookieA: string;
let userA: string;

beforeEach(async () => {
  dbRef = openDb(":memory:");
  await createReady();
});

async function createReady(): Promise<void> {
  const made = createApp(dbRef, {
    driverFor: () => new FakeDriver(),
    workerOpts: { tickMs: 20, jobTimeoutMs: 2000 },
    sseKeepaliveMs: 40,
  });
  worker = made.worker;
  await authReady(dbRef);
  await dbRef.prepare("INSERT INTO projects (id, name, repo) VALUES (?, ?, ?)").run("memracer", "memracer", "recallnet/memracer");
  const a = await signInHuman(dbRef, "ada@memracer.test", "Ada");
  userA = a.userId;
  cookieA = a.cookie;
  await grantMembership(dbRef, userA, "memracer", "admin");
  await new Promise<void>((resolve) => {
    httpServer = made.app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
}

afterEach(async () => {
  worker.stop();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

function req(method: string, path: string, cookie?: string, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function createKey(
  name: string,
  type?: "human" | "coder",
  clarificationMode?: "form" | "text",
): Promise<{ status: number; body: any }> {
  const res = await req(
    "POST",
    "/api/p/memracer/api-keys",
    cookieA,
    type ? { name, type, clarificationMode } : { name },
  );
  return { status: res.status, body: await res.json() };
}

describe("token management — POST /api/p/:project/api-keys", () => {
  it("mints a key, returns the secret exactly once, and tags it human by default", async () => {
    const { status, body } = await createKey("laptop");
    expect(status).toBe(200);
    expect(body).toMatchObject({ name: "laptop", type: "human" });
    expect(body.clarificationMode).toBe("text");
    expect(body.id).toBeTypeOf("string");
    expect(body.start).toBeTypeOf("string");
    // the plaintext secret is present exactly here, on creation
    expect(body.key).toBeTypeOf("string");
    expect(body.key.length).toBeGreaterThan(8);
  });

  it("marks an agent-driven human seat for in-band text clarifications", async () => {
    const { body } = await createKey("agent", "human", "text");
    expect(body.clarificationMode).toBe("text");
    const row = await dbRef
      .prepare("SELECT metadata FROM apikey WHERE id = ?")
      .get<{ metadata: string }>(body.id);
    expect(JSON.parse(row!.metadata)).toMatchObject({
      projectId: "memracer",
      type: "human",
      clarificationMode: "text",
    });
  });

  it("stores an explicit coder type in the key metadata", async () => {
    const { body } = await createKey("fleet", "coder");
    expect(body.type).toBe("coder");
    // metadata landed on the underlying apikey row
    const row = await dbRef
      .prepare('SELECT metadata FROM apikey WHERE id = ?')
      .get<{ metadata: string }>(body.id);
    expect(JSON.parse(row!.metadata)).toMatchObject({ projectId: "memracer", type: "coder" });
  });

  it("generates distinct human-readable names when callers omit or repeat the bare type", async () => {
    const first = await createKey("", "coder");
    const second = await createKey("coder", "coder");
    expect(first.body.name).toMatch(/^Coder seat [0-9A-F]{6}$/);
    expect(second.body.name).toMatch(/^Coder seat [0-9A-F]{6}$/);
    expect(second.body.name).not.toBe(first.body.name);
  });

  it("401 unauthenticated, 404 for a project the caller is not a member of", async () => {
    expect((await req("POST", "/api/p/memracer/api-keys", undefined, { name: "x" })).status).toBe(401);
    expect((await req("POST", "/api/p/other/api-keys", cookieA, { name: "x" })).status).toBe(404);
  });
});

describe("token management — GET /api/p/:project/api-keys", () => {
  it("lists auditable display metadata, never the secret", async () => {
    const created = await createKey("laptop", "human");
    const res = await req("GET", "/api/p/memracer/api-keys", cookieA);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).toMatchObject({
      id: created.body.id,
      name: "laptop",
      type: "human",
      clarificationMode: "text",
      prefix: created.body.id.slice(0, 8),
      lastUsedAt: null,
    });
    expect(body.keys[0].createdAt).toBeDefined();
    expect(body.keys[0]).not.toHaveProperty("start");
    expect(body.keys[0]).not.toHaveProperty("key");
    // the secret never appears anywhere in the list payload
    expect(JSON.stringify(body)).not.toContain(created.body.key);
  });

  it("gives legacy bare-type names a distinct display label", async () => {
    const created = await createKey("legacy", "human");
    await dbRef.prepare("UPDATE apikey SET name = ? WHERE id = ?").run("human", created.body.id);
    const body = await (await req("GET", "/api/p/memracer/api-keys", cookieA)).json();
    expect(body.keys[0].name).toBe(`Human seat ${created.body.id.slice(0, 8)}`);
  });

  it("reports when a key was last used after successful bearer verification", async () => {
    const created = await createKey("active seat", "coder");
    const before = Date.now();
    const verified = await fetch(`${baseUrl}/api/p/memracer/queue`, {
      headers: { Authorization: `Bearer ${created.body.key}` },
    });
    expect(verified.status).toBe(200);

    const body = await (await req("GET", "/api/p/memracer/api-keys", cookieA)).json();
    expect(body.keys[0].lastUsedAt).toBeGreaterThanOrEqual(before);
  });

  it("normalizes Better Auth ISO timestamps for seats and member join dates", async () => {
    const created = await createKey("timestamped seat", "human");
    const fixedCreated = "2026-07-15T12:03:07.245Z";
    const fixedLastUsed = "2026-07-27T15:22:28.811Z";
    await dbRef.prepare('UPDATE apikey SET "createdAt" = ?, "lastRequest" = ? WHERE id = ?')
      .run(fixedCreated, fixedLastUsed, created.body.id);
    await dbRef.prepare('UPDATE "member" SET "createdAt" = ? WHERE "organizationId" = ? AND "userId" = ?')
      .run(fixedCreated, "memracer", userA);

    const keys = await (await req("GET", "/api/p/memracer/api-keys", cookieA)).json();
    expect(keys.keys[0]).toMatchObject({
      id: created.body.id,
      createdAt: Date.parse(fixedCreated),
      lastUsedAt: Date.parse(fixedLastUsed),
    });
    const team = await (await req("GET", "/api/p/memracer/team", cookieA)).json();
    expect(team.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: userA, joinedAt: Date.parse(fixedCreated) }),
    ]));
  });

  it("scopes to the caller and to the project — no other user's or other project's keys", async () => {
    await createKey("ada-key", "human");
    // a second project + membership for the same user, with its own key
    await dbRef.prepare("INSERT INTO projects (id, name, repo) VALUES (?, ?, ?)").run("beta", "Beta", null);
    await grantMembership(dbRef, userA, "beta", "admin");
    await req("POST", "/api/p/beta/api-keys", cookieA, { name: "beta-key", type: "coder" });

    const memracer = await (await req("GET", "/api/p/memracer/api-keys", cookieA)).json();
    expect(memracer.keys.map((k: { name: string }) => k.name)).toEqual(["ada-key"]);

    // a different user with their own memracer key must not see ada's, nor she theirs
    const bob = await signInHuman(dbRef, "bob@memracer.test", "Bob");
    await grantMembership(dbRef, bob.userId, "memracer", "admin");
    await req("POST", "/api/p/memracer/api-keys", bob.cookie, { name: "bob-key", type: "human" });
    const bobList = await (await req("GET", "/api/p/memracer/api-keys", bob.cookie)).json();
    expect(bobList.keys.map((k: { name: string }) => k.name)).toEqual(["bob-key"]);
    const adaList = await (await req("GET", "/api/p/memracer/api-keys", cookieA)).json();
    expect(adaList.keys.map((k: { name: string }) => k.name)).toEqual(["ada-key"]);
  });
});

describe("token management — PATCH /api/p/:project/api-keys/:id", () => {
  it("keeps an owned human seat on text delivery", async () => {
    const created = await createKey("agent", "human");
    const changed = await req(
      "PATCH",
      `/api/p/memracer/api-keys/${created.body.id}`,
      cookieA,
      { clarificationMode: "text" },
    );
    expect(changed.status).toBe(200);
    expect(await changed.json()).toEqual({ id: created.body.id, clarificationMode: "text" });
    const listed = await (await req("GET", "/api/p/memracer/api-keys", cookieA)).json();
    expect(listed.keys[0].clarificationMode).toBe("text");

    const restored = await req(
      "PATCH",
      `/api/p/memracer/api-keys/${created.body.id}`,
      cookieA,
      { clarificationMode: "form" },
    );
    expect(restored.status).toBe(200);
    expect((await (await req("GET", "/api/p/memracer/api-keys", cookieA)).json()).keys[0]
      .clarificationMode).toBe("text");
  });

  it("ignores mode values while preserving coder and ownership checks", async () => {
    const human = await createKey("human", "human");
    expect(
      (await req("PATCH", `/api/p/memracer/api-keys/${human.body.id}`, cookieA, {
        clarificationMode: "toast",
      })).status,
    ).toBe(200);

    const coder = await createKey("coder", "coder");
    expect(
      (await req("PATCH", `/api/p/memracer/api-keys/${coder.body.id}`, cookieA, {
        clarificationMode: "text",
      })).status,
    ).toBe(404);

    const bob = await signInHuman(dbRef, "mode-bob@memracer.test", "Mode Bob");
    await grantMembership(dbRef, bob.userId, "memracer", "admin");
    expect(
      (await req("PATCH", `/api/p/memracer/api-keys/${human.body.id}`, bob.cookie, {
        clarificationMode: "text",
      })).status,
    ).toBe(404);
  });
});

describe("token management — DELETE /api/p/:project/api-keys/:id", () => {
  it("revokes the caller's key: create → list(1) → delete → list(0)", async () => {
    const created = await createKey("laptop", "human");
    expect((await (await req("GET", "/api/p/memracer/api-keys", cookieA)).json()).keys).toHaveLength(1);
    const del = await req("DELETE", `/api/p/memracer/api-keys/${created.body.id}`, cookieA);
    expect(del.status).toBe(200);
    expect((await (await req("GET", "/api/p/memracer/api-keys", cookieA)).json()).keys).toHaveLength(0);
    // the underlying apikey row is gone — the secret can no longer authenticate
    expect(await dbRef.prepare("SELECT id FROM apikey WHERE id = ?").get(created.body.id)).toBeUndefined();
  });

  it("404s deleting another user's key or a key from another project", async () => {
    const created = await createKey("ada-key", "human");
    const bob = await signInHuman(dbRef, "bob@memracer.test", "Bob");
    await grantMembership(dbRef, bob.userId, "memracer", "admin");
    // bob cannot revoke ada's key
    expect((await req("DELETE", `/api/p/memracer/api-keys/${created.body.id}`, bob.cookie)).status).toBe(404);
    // and it survives
    expect(await dbRef.prepare("SELECT id FROM apikey WHERE id = ?").get(created.body.id)).toBeDefined();
  });
});
