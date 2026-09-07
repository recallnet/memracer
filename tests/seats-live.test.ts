// GET /api/p/:project/seats/live — project-wide seat liveness for `memracer ps`.
// Real boot pattern (createApp → registerDashboard), mirroring
// tests/dashboard-token-mgmt.test.ts's in-memory SQLite + magic-link cookie.
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

let cookieA: string;

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
  cookieA = a.cookie;
  await grantMembership(dbRef, a.userId, "memracer", "admin");
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

async function createKey(name: string, type: "human" | "coder"): Promise<any> {
  return (await req("POST", "/api/p/memracer/api-keys", cookieA, { name, type })).json();
}

describe("GET /api/p/:project/seats/live", () => {
  it("returns every project seat with its role; unused seats are not live", async () => {
    const human = await createKey("human seat", "human");
    const coder = await createKey("coder seat", "coder");

    const res = await req("GET", "/api/p/memracer/seats/live", cookieA);
    expect(res.status).toBe(200);
    const seats = await res.json();
    expect(Array.isArray(seats)).toBe(true);
    expect(seats).toHaveLength(2);

    const byId = new Map(seats.map((s: any) => [s.keyId, s]));
    expect(byId.get(human.id)).toMatchObject({ role: "human", live: false });
    expect(byId.get(coder.id)).toMatchObject({ role: "coder", live: false });
  });

  it("marks a seat live after it authenticates", async () => {
    const coder = await createKey("active", "coder");
    const verified = await fetch(`${baseUrl}/api/p/memracer/queue`, {
      headers: { Authorization: `Bearer ${coder.key}` },
    });
    expect(verified.status).toBe(200);

    const seats = await (await req("GET", "/api/p/memracer/seats/live", cookieA)).json();
    expect(seats.find((s: any) => s.keyId === coder.id)).toMatchObject({ live: true });
  });

  it("401 unauthenticated, 404 for a non-member project", async () => {
    expect((await req("GET", "/api/p/memracer/seats/live")).status).toBe(401);
    expect((await req("GET", "/api/p/other/seats/live", cookieA)).status).toBe(404);
  });
});
