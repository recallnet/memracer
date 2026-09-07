// tests/auth-ui.test.ts
//
// The visible half of better-auth (#73/#90): a signed-in human authenticates
// the dashboard with a session cookie (no Bearer token), lands on the shell,
// and the team endpoint lists the project's better-auth members. Legacy static
// tokens are gone (#90) — a would-be static token is rejected. SQLite-only:
// better-auth is disabled on the PGlite test backend (authDatabase() → null),
// so this drives openDb(":memory:") directly rather than openTestDb().
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { openDb, type Db } from "../src/db.js";
import { authReady } from "../src/auth/instance.js";
import { createApp } from "../src/server.js";
import { isOrgMember } from "../src/auth.js";
import { magicLinkSessionCookie } from "./helpers/auth.js";
import { FakeDriver } from "../src/mediator/fake.js";
import type { MediatorWorker } from "../src/mediator/worker.js";
import type { Queue } from "../src/queue.js";

let httpServer: Server;
let baseUrl: string;
let worker: MediatorWorker;
let db: Db;
let queue: Queue;

const EMAIL = "ada@alpha.test";

beforeEach(async () => {
  db = openDb(":memory:");
  await db.prepare("INSERT INTO projects (id, name, repo) VALUES (?, ?, ?)").run("alpha", "Alpha", "recallnet/alpha");
  const made = createApp(db, { driverFor: () => new FakeDriver(), workerOpts: { tickMs: 20, jobTimeoutMs: 2000 } });
  worker = made.worker;
  queue = made.queue;
  await authReady(db); // better-auth migrations create user/session/member/organization
  await new Promise<void>((resolve) => {
    httpServer = made.app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterEach(async () => {
  worker.stop();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

/** Sign up + grant an org membership + sign in; returns the session cookie header. */
async function signInWithMembership(role = "human"): Promise<string> {
  const cookie = await magicLinkSessionCookie(db, EMAIL, "Ada");
  const userId = (await db.prepare('SELECT id FROM "user" WHERE email = ?').get<{ id: string }>(EMAIL))!.id;
  await db
    .prepare('INSERT INTO "organization" (id, name, slug, "createdAt") VALUES (?, ?, ?, ?)')
    .run("alpha", "Alpha", "alpha", new Date().toISOString());
  await db
    .prepare('INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES (?, ?, ?, ?, ?)')
    .run("mem-ada", "alpha", userId, role, new Date().toISOString());
  return cookie;
}

describe("better-auth session lands authenticated on the dashboard (#73/#90)", () => {
  it("derives Org access from creator or any sibling Project membership", async () => {
    const cookie = await signInWithMembership("human");
    expect(cookie).toContain("session_token");
    const userId = (await db.prepare('SELECT id FROM "user" WHERE email = ?').get<{ id: string }>(EMAIL))!.id;
    await db
      .prepare("INSERT INTO orgs (id, name, created_by, created_at) VALUES (?, ?, ?, ?)")
      .run("org", "Org", "creator-only", Date.now());
    await db.prepare("UPDATE projects SET org_id = ? WHERE id = ?").run("org", "alpha");

    expect(await isOrgMember(db, "creator-only", "org")).toBe(true);
    expect(await isOrgMember(db, userId, "org")).toBe(true);
    expect(await isOrgMember(db, "outsider", "org")).toBe(false);
    expect(await isOrgMember(db, userId, "missing")).toBe(false);
  });

  it("a session cookie authenticates /api/me — no Bearer token needed", async () => {
    const cookie = await signInWithMembership("human");
    const res = await fetch(`${baseUrl}/api/me`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("Ada");
    expect(body.memberships).toEqual([
      { projectId: "alpha", projectName: "Alpha", repo: "recallnet/alpha", role: "human", orgId: null, orgName: null },
    ]);
  });

  it("the team endpoint lists the project's better-auth members", async () => {
    const cookie = await signInWithMembership("admin");
    const res = await fetch(`${baseUrl}/api/p/alpha/team`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const { members } = await res.json();
    expect(members).toEqual([
      expect.objectContaining({ name: "Ada", role: "admin", email: EMAIL }),
    ]);
  });

  it("a legacy static token is rejected — better-auth is the only auth (#90)", async () => {
    const res = await fetch(`${baseUrl}/api/me`, { headers: { Authorization: "Bearer tok-leg" } });
    expect(res.status).toBe(401);
  });

  it("no credentials → 401 (the dashboard redirects to /signin)", async () => {
    expect((await fetch(`${baseUrl}/api/me`)).status).toBe(401);
  });

  it("project archive is session-admin-only, exact-name confirmed, and notifies after commit", async () => {
    const cookie = await signInWithMembership("admin");
    const originalNotify = queue.notifyChanged.bind(queue);
    const notifications: Promise<{ projectId: string; archived: boolean }>[] = [];
    queue.notifyChanged = (projectId: string) => {
      notifications.push(
        db.prepare("SELECT archived_at FROM projects WHERE id=?").get<{ archived_at: number | null }>(projectId)
          .then((row) => ({ projectId, archived: row?.archived_at != null })),
      );
      originalNotify(projectId);
    };
    const wrong = await fetch(`${baseUrl}/api/p/alpha`, {
      method: "DELETE", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify({ name: "alpha" }),
    });
    expect(wrong.status).toBe(400);
    expect(await db.prepare("SELECT id FROM projects WHERE id=?").get("alpha")).toBeTruthy();
    const ok = await fetch(`${baseUrl}/api/p/alpha`, {
      method: "DELETE", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify({ name: "Alpha" }),
    });
    expect(ok.status).toBe(200);
    // Soft-delete: row remains with archived_at set
    const row = await db.prepare("SELECT id, archived_at FROM projects WHERE id=?").get<{ id: string; archived_at: number | null }>("alpha");
    expect(row?.id).toBe("alpha");
    expect(row?.archived_at).toBeTruthy();
    expect(await Promise.all(notifications)).toEqual([{ projectId: "alpha", archived: true }]);
  });

  it("project deletion returns 401 without a session and 403 for a non-admin", async () => {
    expect((await fetch(`${baseUrl}/api/p/alpha`, { method: "DELETE" })).status).toBe(401);
    const cookie = await signInWithMembership("human");
    const res = await fetch(`${baseUrl}/api/p/alpha`, {
      method: "DELETE", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify({ name: "Alpha" }),
    });
    expect(res.status).toBe(403);
  });

  it("project deletion hides both an existing foreign project and a missing id behind 404", async () => {
    const cookie = await signInWithMembership("admin");
    await db.prepare("INSERT INTO projects (id,name) VALUES (?,?)").run("beta", "Beta");
    for (const id of ["beta", "missing"]) {
      const res = await fetch(`${baseUrl}/api/p/${id}`, {
        method: "DELETE", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify({ name: "Beta" }),
      });
      expect(res.status, id).toBe(404);
    }
  });

  it("serializes competing confirmed archives so exactly one succeeds", async () => {
    const cookie = await signInWithMembership("admin");
    const remove = () => fetch(`${baseUrl}/api/p/alpha`, {
      method: "DELETE", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify({ name: "Alpha" }),
    });
    const statuses = (await Promise.all([remove(), remove()])).map((res) => res.status).sort();
    expect(statuses).toEqual([200, 404]);
    const row = await db.prepare("SELECT archived_at FROM projects WHERE id=?").get<{ archived_at: number | null }>("alpha");
    expect(row?.archived_at).toBeTruthy();
  });
});
