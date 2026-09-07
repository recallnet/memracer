// Part F3 — the custom-role admin API. An admin creates project roles; any
// member lists them; an enrollment minted for a custom role redeems into a seat
// tagged with that role slug (end-to-end custom role via enrollment).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { openDb, type Db } from "../src/db.js";
import { authReady } from "../src/auth/instance.js";
import { createApp } from "../src/server.js";
import { FakeDriver } from "../src/mediator/fake.js";
import type { MediatorWorker } from "../src/mediator/worker.js";
import { magicLinkSessionCookie } from "./helpers/auth.js";
import { seedDefaultRoles } from "../src/roles.js";

let httpServer: Server;
let baseUrl: string;
let worker: MediatorWorker;
let dbRef: Db;
let cookieAdmin: string;
let cookieMember: string;

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
  await seedDefaultRoles(dbRef, "demo");
  const admin = await signIn(dbRef, "admin@roles.test", "Admin");
  const member = await signIn(dbRef, "member@roles.test", "Member");
  cookieAdmin = admin.cookie;
  cookieMember = member.cookie;
  await grantMembership(dbRef, admin.userId, "demo", "admin");
  await grantMembership(dbRef, member.userId, "demo", "human");
  await new Promise<void>((resolve) => {
    httpServer = made.app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterEach(async () => {
  worker.stop();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

function createRole(cookie: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/p/demo/roles`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("custom role routes", () => {
  it("admin creates a role; members list human+coder+reviewer", async () => {
    const created = await createRole(cookieAdmin, {
      slug: "reviewer",
      kind: "worker",
      displayName: "Reviewer",
      systemPrompt: "Review PRs",
    });
    expect(created.status, await created.clone().text()).toBe(200);
    const row = (await created.json()) as { slug: string; kind: string };
    expect(row.slug).toBe("reviewer");
    expect(row.kind).toBe("worker");

    const list = await fetch(`${baseUrl}/api/p/demo/roles`, { headers: { Cookie: cookieMember } });
    expect(list.status).toBe(200);
    const roles = (await list.json()) as Array<{ slug: string }>;
    expect(roles.map((r) => r.slug).sort()).toEqual(["coder", "human", "reviewer"]);
  });

  it("rejects a duplicate slug with 409", async () => {
    expect((await createRole(cookieAdmin, { slug: "reviewer", kind: "worker", displayName: "Reviewer" })).status).toBe(200);
    const dup = await createRole(cookieAdmin, { slug: "reviewer", kind: "worker", displayName: "Reviewer 2" });
    expect(dup.status).toBe(409);
  });

  it("rejects an invalid slug and an invalid kind with 400", async () => {
    expect((await createRole(cookieAdmin, { slug: "Bad Slug", kind: "worker", displayName: "X" })).status).toBe(400);
    expect((await createRole(cookieAdmin, { slug: "ok", kind: "nonsense", displayName: "X" })).status).toBe(400);
  });

  it("rejects a non-admin creator with 403", async () => {
    const res = await createRole(cookieMember, { slug: "reviewer", kind: "worker", displayName: "Reviewer" });
    expect(res.status).toBe(403);
  });

  it("mints and redeems an enrollment for a custom role end-to-end", async () => {
    expect((await createRole(cookieAdmin, { slug: "reviewer", kind: "worker", displayName: "Reviewer" })).status).toBe(200);

    const mint = await fetch(`${baseUrl}/api/p/demo/enrollments`, {
      method: "POST",
      headers: { Cookie: cookieAdmin, "Content-Type": "application/json" },
      body: JSON.stringify({ role: "reviewer" }),
    });
    expect(mint.status, await mint.clone().text()).toBe(200);
    const { token } = (await mint.json()) as { token: string };

    const redeem = await fetch(`${baseUrl}/api/enroll/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(redeem.status, await redeem.clone().text()).toBe(200);
    const seat = (await redeem.json()) as { role: string; key: string };
    expect(seat.role).toBe("reviewer");
    expect(typeof seat.key).toBe("string");
  });
});
