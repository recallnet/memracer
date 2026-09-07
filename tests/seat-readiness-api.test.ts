/**
 * GET /api/p/:project/seat-readiness — project-wide counts, no secrets.
 * Teammate-owned seats must make factoryReady true for an empty-key viewer.
 */
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
let cookieViewer: string;
let cookieOwner: string;
let ownerUserId: string;

async function signIn(db: Db, email: string, name: string): Promise<{ userId: string; cookie: string }> {
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

beforeEach(async () => {
  dbRef = openDb(":memory:");
  const made = createApp(dbRef, {
    driverFor: () => new FakeDriver(),
    workerOpts: { tickMs: 20, jobTimeoutMs: 2000 },
    sseKeepaliveMs: 40,
  });
  worker = made.worker;
  await authReady(dbRef);
  await dbRef.prepare("INSERT INTO projects (id, name, repo) VALUES (?, ?, ?)").run("demo", "Demo", "recallnet/demo");
  const owner = await signIn(dbRef, "owner@seat.test", "Owner");
  ownerUserId = owner.userId;
  cookieOwner = owner.cookie;
  await grantMembership(dbRef, owner.userId, "demo", "admin");
  const viewer = await signIn(dbRef, "viewer@seat.test", "Viewer");
  cookieViewer = viewer.cookie;
  await grantMembership(dbRef, viewer.userId, "demo", "human");
  await new Promise<void>((resolve) => {
    httpServer = made.app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterEach(async () => {
  worker.stop();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

function get(path: string, cookie: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { headers: { Cookie: cookie } });
}

describe("GET /api/p/:project/seat-readiness", () => {
  it("returns empty greenfield for a project with no seats and no tasks", async () => {
    const res = await get("/api/p/demo/seat-readiness", cookieViewer);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      factoryReady: false,
      humanSeats: 0,
      coderSeats: 0,
      hasTaskHistory: false,
      friggReady: false,
    });
  });

  it("counts teammate-owned seats so factoryReady is true for an empty-key viewer", async () => {
    const mintHuman = await fetch(`${baseUrl}/api/p/demo/api-keys`, {
      method: "POST",
      headers: { Cookie: cookieOwner, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "owner-human", type: "human" }),
    });
    expect(mintHuman.status).toBe(200);
    const mintCoder = await fetch(`${baseUrl}/api/p/demo/api-keys`, {
      method: "POST",
      headers: { Cookie: cookieOwner, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "owner-coder", type: "coder" }),
    });
    expect(mintCoder.status).toBe(200);

    const viewerKeys = await (await get("/api/p/demo/api-keys", cookieViewer)).json();
    expect(viewerKeys.keys).toEqual([]);

    const res = await get("/api/p/demo/seat-readiness", cookieViewer);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.factoryReady).toBe(true);
    expect(body.humanSeats).toBeGreaterThanOrEqual(1);
    expect(body.coderSeats).toBeGreaterThanOrEqual(1);
    expect(body.hasTaskHistory).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/sk-|key|secret/i);
  });

  it("sets hasTaskHistory when the project has any task", async () => {
    await dbRef
      .prepare(
        `INSERT INTO tasks (project_id, title, body, priority, state, submitted_by, created_at, updated_at)
         VALUES (?, ?, ?, 0, 'QUEUED', ?, ?, ?)`,
      )
      .run("demo", "Existing work", "body", "owner", Date.now(), Date.now());
    const body = await (await get("/api/p/demo/seat-readiness", cookieViewer)).json();
    expect(body.hasTaskHistory).toBe(true);
    expect(body.factoryReady).toBe(false);
  });

  it("401 without session; 404 for non-member project", async () => {
    expect((await fetch(`${baseUrl}/api/p/demo/seat-readiness`)).status).toBe(401);
    expect((await get("/api/p/missing/seat-readiness", cookieViewer)).status).toBe(404);
  });

  it("counts active oauth seats and ignores revoked oauth rows", async () => {
    const now = Date.now();
    await dbRef
      .prepare(
        `INSERT INTO oauth_seats (id, user_id, project_id, name, role, consent_code, created_at, updated_at, revoked_at)
         VALUES (?, ?, 'demo', 'oauth-h', 'human', ?, ?, ?, NULL)`,
      )
      .run("os-h", ownerUserId, "consent-h", now, now);
    await dbRef
      .prepare(
        `INSERT INTO oauth_seats (id, user_id, project_id, name, role, consent_code, created_at, updated_at, revoked_at)
         VALUES (?, ?, 'demo', 'oauth-c', 'coder', ?, ?, ?, NULL)`,
      )
      .run("os-c", ownerUserId, "consent-c", now, now);
    await dbRef
      .prepare(
        `INSERT INTO oauth_seats (id, user_id, project_id, name, role, consent_code, created_at, updated_at, revoked_at)
         VALUES (?, ?, 'demo', 'oauth-rev', 'coder', ?, ?, ?, ?)`,
      )
      .run("os-r", ownerUserId, "consent-r", now, now, now);

    const body = await (await get("/api/p/demo/seat-readiness", cookieViewer)).json();
    expect(body.factoryReady).toBe(true);
    expect(body.humanSeats).toBeGreaterThanOrEqual(1);
    expect(body.coderSeats).toBe(1); // revoked coder excluded
  });

  it("counts apikey with missing type as human (api-keys default)", async () => {
    const mintCoder = await fetch(`${baseUrl}/api/p/demo/api-keys`, {
      method: "POST",
      headers: { Cookie: cookieOwner, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "coder-seat", type: "coder" }),
    });
    expect(mintCoder.status).toBe(200);
    const mintHuman = await fetch(`${baseUrl}/api/p/demo/api-keys`, {
      method: "POST",
      headers: { Cookie: cookieOwner, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "human-seat", type: "human" }),
    });
    expect(mintHuman.status).toBe(200);
    const humanId = (await mintHuman.json()).id as string;
    // Strip type so metadata only has projectId — must still count as human.
    await dbRef
      .prepare("UPDATE apikey SET metadata = ? WHERE id = ?")
      .run(JSON.stringify({ projectId: "demo" }), humanId);

    const body = await (await get("/api/p/demo/seat-readiness", cookieViewer)).json();
    expect(body.factoryReady).toBe(true);
    expect(body.humanSeats).toBeGreaterThanOrEqual(1);
    expect(body.coderSeats).toBeGreaterThanOrEqual(1);
  });
});
