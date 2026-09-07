// A3/A4: the seat-enrollment routes, driven through the real app (createApp →
// registerDashboard → registerSeatEnrollment). An admin mints a short-lived
// grant; anyone holding the token redeems it exactly once into a role-scoped
// seat key. Mirrors tests/dashboard-token-mgmt.test.ts's harness (in-memory
// SQLite for better-auth, magic-link session cookie, member rows for scope).
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

/** A member row (organizationId ↔ projects.id) so the caller passes scoped(). */
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

async function mint(role?: string, cookie = cookieAdmin): Promise<{ status: number; body: any }> {
  const res = await req("POST", "/api/p/memracer/enrollments", cookie, role ? { role } : {});
  return { status: res.status, body: await res.json() };
}

describe("mint enrollment — POST /api/p/:project/enrollments", () => {
  it("admin mints a grant: token, prompt, role, future expiry", async () => {
    const { status, body } = await mint("coder");
    expect(status).toBe(200);
    expect(body.token).toMatch(/^mzr_enrl_/);
    expect(body.role).toBe("coder");
    expect(body.prompt).toContain(`memracer enroll ${body.token}`);
    expect(body.expiresAt).toBeGreaterThan(Date.now());
    // only the hash is persisted, never the plaintext token
    const row = await dbRef
      .prepare("SELECT token_hash FROM seat_enrollments WHERE project_id = ?")
      .get<{ token_hash: string }>("memracer");
    expect(row!.token_hash).not.toContain(body.token);
  });

  it("defaults the role to coder when omitted", async () => {
    const { body } = await mint();
    expect(body.role).toBe("coder");
  });

  it("403 for a non-admin member", async () => {
    const bob = await signInHuman(dbRef, "bob@memracer.test", "Bob");
    await grantMembership(dbRef, bob.userId, "memracer", "human");
    expect((await mint("coder", bob.cookie)).status).toBe(403);
  });
});

describe("redeem enrollment — POST /api/enroll/redeem", () => {
  it("redeems once into a role-scoped seat, then rejects a second use", async () => {
    const { body: minted } = await mint("coder");
    const res = await req("POST", "/api/enroll/redeem", undefined, { token: minted.token });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.key).toBeTypeOf("string");
    expect(body.key.length).toBeGreaterThan(8);
    expect(body.keyId).toBeTypeOf("string");
    expect(body.role).toBe("coder");
    // project + projectId are the project id used in the mint URL (/api/p/memracer/...)
    expect(body.projectId).toBe("memracer");
    expect(body.project).toBe("memracer");
    // projectName is the human-readable display name for the CLI
    expect(body.projectName).toBe("Memracer");
    expect(body.mcpUrl).toContain("/mcp");
    // the minted seat key carries the role in its better-auth metadata
    const meta = await dbRef.prepare("SELECT metadata FROM apikey WHERE id = ?").get<{ metadata: string }>(body.keyId);
    expect(JSON.parse(meta!.metadata)).toMatchObject({ projectId: "memracer", type: "coder" });

    // second redemption is refused (single-use claim)
    const again = await req("POST", "/api/enroll/redeem", undefined, { token: minted.token });
    expect(again.status).toBe(409);
  });

  it("410 for an expired grant", async () => {
    const { body: minted } = await mint("coder");
    await dbRef.prepare("UPDATE seat_enrollments SET expires_at = 1").run();
    expect((await req("POST", "/api/enroll/redeem", undefined, { token: minted.token })).status).toBe(410);
  });

  it("404 for an unknown token", async () => {
    expect((await req("POST", "/api/enroll/redeem", undefined, { token: "mzr_enrl_nope" })).status).toBe(404);
  });
});
