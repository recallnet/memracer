// S1/S2: the CLI login loopback + operator-token acceptance (D3). A signed-in
// browser session authorizes (→ single-use login code); the CLI exchanges the
// code for an identity-wide OPERATOR key; that key then mints seat enrollments
// and lists live seats on any project the user admins — no dashboard round-trip.
//
// Same harness as tests/seat-enrollment-routes.test.ts: in-memory SQLite (the
// only backend where better-auth is enabled) + a magic-link session cookie.
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

/** Drive the whole loopback: authorize (with a session) → code → operator token. */
async function login(cookie = cookieAdmin): Promise<string> {
  const redirectUri = "http://127.0.0.1:56789/cb";
  const authorize = await fetch(
    `${baseUrl}/api/cli/authorize?redirect_uri=${encodeURIComponent(redirectUri)}&state=xyz`,
    { headers: { Cookie: cookie }, redirect: "manual" },
  );
  expect(authorize.status).toBe(302);
  const location = new URL(authorize.headers.get("location")!);
  const code = location.searchParams.get("code")!;
  const token = await fetch(`${baseUrl}/api/cli/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  expect(token.status).toBe(200);
  return (await token.json()).token as string;
}

describe("CLI login loopback — /api/auth/cli/*", () => {
  it("authorize with a session 302-redirects to the loopback with a code + state", async () => {
    const redirectUri = "http://127.0.0.1:56789/cb";
    const res = await fetch(
      `${baseUrl}/api/cli/authorize?redirect_uri=${encodeURIComponent(redirectUri)}&state=xyz`,
      { headers: { Cookie: cookieAdmin }, redirect: "manual" },
    );
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin).toBe("http://127.0.0.1:56789");
    expect(location.pathname).toBe("/cb");
    expect(location.searchParams.get("code")).toBeTruthy();
    expect(location.searchParams.get("state")).toBe("xyz");
  });

  it("paste flow: with no redirect_uri, renders the code as a page the operator copies", async () => {
    const res = await fetch(`${baseUrl}/api/cli/authorize`, { headers: { Cookie: cookieAdmin } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    const code = /<pre[^>]*>([^<]+)<\/pre>/.exec(html)?.[1]?.trim();
    expect(code).toBeTruthy();
    // the displayed code exchanges for an operator token just like the loopback code
    const tok = await fetch(`${baseUrl}/api/cli/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    expect(tok.status).toBe(200);
    expect((await tok.json()).token).toBeTypeOf("string");
  });

  it("paste flow still requires a session (401 when signed out)", async () => {
    const res = await fetch(`${baseUrl}/api/cli/authorize`, { redirect: "manual" });
    expect(res.status).toBe(401);
  });

  it("exchanges the code for an operator token, then rejects a replay of the same code", async () => {
    const redirectUri = "http://localhost:5000/cb";
    const authorize = await fetch(
      `${baseUrl}/api/cli/authorize?redirect_uri=${encodeURIComponent(redirectUri)}&state=s`,
      { headers: { Cookie: cookieAdmin }, redirect: "manual" },
    );
    const code = new URL(authorize.headers.get("location")!).searchParams.get("code")!;
    const first = await fetch(`${baseUrl}/api/cli/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    expect(first.status).toBe(200);
    const body = await first.json();
    expect(body.token).toBeTypeOf("string");
    expect(body.userId).toBe(userAdmin);
    // the operator key is a real, identity-wide better-auth apikey
    const meta = await dbRef.prepare("SELECT metadata FROM apikey WHERE id = ?").get<{ metadata: string }>(
      // find it by owner + name
      (await dbRef.prepare('SELECT id FROM apikey WHERE "referenceId" = ? ORDER BY "createdAt" DESC LIMIT 1').get<{ id: string }>(userAdmin))!.id,
    );
    expect(JSON.parse(meta!.metadata)).toMatchObject({ type: "operator" });

    // single-use: a second exchange of the same code fails
    const replay = await fetch(`${baseUrl}/api/cli/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    expect(replay.status).toBe(400);
  });

  it("rejects a non-loopback redirect_uri (400)", async () => {
    const res = await fetch(
      `${baseUrl}/api/cli/authorize?redirect_uri=${encodeURIComponent("https://evil.example/cb")}&state=s`,
      { headers: { Cookie: cookieAdmin }, redirect: "manual" },
    );
    expect(res.status).toBe(400);
  });

  it("401s authorize without a session", async () => {
    const res = await fetch(
      `${baseUrl}/api/cli/authorize?redirect_uri=${encodeURIComponent("http://127.0.0.1:1/cb")}&state=s`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(401);
  });

  it("400s a token exchange for an unknown code", async () => {
    const res = await fetch(`${baseUrl}/api/cli/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "nope" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("operator token mints enrollments + lists seats (CLI-managed tokens)", () => {
  it("mints an enrollment on a project the operator admins via Bearer", async () => {
    const operatorToken = await login();
    const res = await fetch(`${baseUrl}/api/p/memracer/enrollments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${operatorToken}` },
      body: JSON.stringify({ role: "coder" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toMatch(/^mzr_enrl_/);
    expect(body.role).toBe("coder");
    expect(body.prompt).toBeTypeOf("string");
  });

  it("lists live seats via the operator token", async () => {
    const operatorToken = await login();
    const res = await fetch(`${baseUrl}/api/p/memracer/seats/live`, {
      headers: { Authorization: `Bearer ${operatorToken}` },
    });
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  it("403s an operator token for a project the user is NOT an admin of", async () => {
    // A second project where the operator is a non-admin member.
    await dbRef.prepare("INSERT INTO projects (id, name, repo) VALUES (?, ?, ?)").run("beta", "Beta", null);
    await grantMembership(dbRef, userAdmin, "beta", "human");
    const operatorToken = await login();
    const res = await fetch(`${baseUrl}/api/p/beta/enrollments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${operatorToken}` },
      body: JSON.stringify({ role: "coder" }),
    });
    expect(res.status).toBe(403);
  });
});
