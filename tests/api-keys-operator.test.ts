// The api-keys list + delete routes accept the operator Bearer token so the
// CLI can manage seats with the stored login credential — still per-user
// scoped: an operator only sees and revokes the keys they OWN. Session callers
// (browser cookie) keep working; that path is covered in dashboard-token-mgmt.
//
// Same in-memory SQLite harness as tests/cli-auth.test.ts (the operator-token
// login loopback) + tests/dashboard-token-mgmt.test.ts (session key CRUD).
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

async function signInHuman(db: Db, email: string, name: string): Promise<{ userId: string; cookie: string }> {
  const cookie = await magicLinkSessionCookie(db, email, name);
  const userId = (await db.prepare('SELECT id FROM "user" WHERE email = ?').get<{ id: string }>(email))!.id;
  return { userId, cookie };
}

async function grantMembership(db: Db, userId: string, projectId: string, role: string): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO "organization" (id, name, slug, "createdAt") VALUES (?, ?, ?, ?)')
    .run(projectId, projectId, projectId, new Date().toISOString());
  await db
    .prepare('INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES (?, ?, ?, ?, ?)')
    .run(`${userId}-${projectId}`, projectId, userId, role, new Date().toISOString());
}

let cookieAdmin: string;
let userAdmin: string;

beforeEach(async () => {
  dbRef = openDb(":memory:");
  const made = createApp(dbRef, {
    driverFor: () => new FakeDriver(),
    workerOpts: { tickMs: 20, jobTimeoutMs: 2000 },
    sseKeepaliveMs: 40,
  });
  worker = made.worker;
  await authReady(dbRef);
  await dbRef.prepare("INSERT INTO projects (id, name, repo) VALUES (?, ?, ?)").run("memracer", "Memracer", "recallnet/memracer");
  const a = await signInHuman(dbRef, "ada@memracer.test", "Ada");
  userAdmin = a.userId;
  cookieAdmin = a.cookie;
  await grantMembership(dbRef, userAdmin, "memracer", "admin");
  await new Promise<void>((resolve) => {
    httpServer = made.app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterEach(async () => {
  worker.stop();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

/** Drive the login loopback: authorize (session) → code → operator token. */
async function login(cookie = cookieAdmin): Promise<string> {
  const redirectUri = "http://127.0.0.1:56789/cb";
  const authorize = await fetch(
    `${baseUrl}/api/cli/authorize?redirect_uri=${encodeURIComponent(redirectUri)}&state=xyz`,
    { headers: { Cookie: cookie }, redirect: "manual" },
  );
  const code = new URL(authorize.headers.get("location")!).searchParams.get("code")!;
  const token = await fetch(`${baseUrl}/api/cli/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  return (await token.json()).token as string;
}

/** Mint a project seat via a browser session (POST api-keys stays session-only). */
async function createKey(cookie: string, name: string, type: "human" | "coder" = "human"): Promise<{ id: string }> {
  const res = await fetch(`${baseUrl}/api/p/memracer/api-keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ name, type }),
  });
  return { id: (await res.json()).id as string };
}

describe("api-keys list + delete accept the operator token (per-user scope)", () => {
  it("GET lists the operator's OWN seats via a Bearer operator token", async () => {
    const created = await createKey(cookieAdmin, "ada-laptop", "human");
    const operatorToken = await login();
    const res = await fetch(`${baseUrl}/api/p/memracer/api-keys`, {
      headers: { Authorization: `Bearer ${operatorToken}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.keys.map((k: { id: string }) => k.id)).toContain(created.id);
    expect(body.keys.map((k: { name: string }) => k.name)).toContain("ada-laptop");
  });

  it("DELETE revokes a seat the operator owns → 200, and the key is gone", async () => {
    const created = await createKey(cookieAdmin, "ada-seat", "coder");
    const operatorToken = await login();
    const del = await fetch(`${baseUrl}/api/p/memracer/api-keys/${created.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${operatorToken}` },
    });
    expect(del.status).toBe(200);
    expect(await dbRef.prepare("SELECT id FROM apikey WHERE id = ?").get(created.id)).toBeUndefined();
  });

  it("DELETE another user's seat with the operator token → 404 (per-user scope holds)", async () => {
    const bob = await signInHuman(dbRef, "bob@memracer.test", "Bob");
    await grantMembership(dbRef, bob.userId, "memracer", "admin");
    const bobsKey = await createKey(bob.cookie, "bob-seat", "human");
    // Ada's operator token cannot touch Bob's seat.
    const operatorToken = await login();
    const del = await fetch(`${baseUrl}/api/p/memracer/api-keys/${bobsKey.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${operatorToken}` },
    });
    expect(del.status).toBe(404);
    expect(await dbRef.prepare("SELECT id FROM apikey WHERE id = ?").get(bobsKey.id)).toBeDefined();
    // and Ada's operator list never surfaces Bob's seat
    const list = await (await fetch(`${baseUrl}/api/p/memracer/api-keys`, {
      headers: { Authorization: `Bearer ${operatorToken}` },
    })).json();
    expect(list.keys.map((k: { id: string }) => k.id)).not.toContain(bobsKey.id);
  });

  it("401s GET and DELETE with no auth at all", async () => {
    const created = await createKey(cookieAdmin, "ada-seat", "human");
    expect((await fetch(`${baseUrl}/api/p/memracer/api-keys`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/p/memracer/api-keys/${created.id}`, { method: "DELETE" })).status).toBe(401);
  });

  it("still serves session callers (browser cookie) unchanged", async () => {
    const created = await createKey(cookieAdmin, "session-seat", "human");
    const list = await (await fetch(`${baseUrl}/api/p/memracer/api-keys`, {
      headers: { Cookie: cookieAdmin },
    })).json();
    expect(list.keys.map((k: { id: string }) => k.id)).toContain(created.id);
    const del = await fetch(`${baseUrl}/api/p/memracer/api-keys/${created.id}`, {
      method: "DELETE",
      headers: { Cookie: cookieAdmin },
    });
    expect(del.status).toBe(200);
  });
});
