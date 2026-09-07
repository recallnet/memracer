import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { openDb, type Db } from "../src/db.js";
import { createApp } from "../src/server.js";
import { FakeDriver } from "../src/mediator/fake.js";
import type { MediatorWorker } from "../src/mediator/worker.js";
import { betterAuthReady, grantMembership, sessionCookie, seedMember } from "./helpers/auth.js";

let db: Db;
let server: Server;
let worker: MediatorWorker;
let baseUrl: string;
let adminCookie: string;
let memberCookie: string;
let adminUserId: string;
let memberUserId: string;

beforeEach(async () => {
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || "test-secret-key-for-byok-envelope-32b";
  db = openDb(":memory:");
  await betterAuthReady(db);
  await db.prepare("INSERT INTO orgs (id, name, created_by, created_at) VALUES (?, ?, ?, ?)").run(
    "org1",
    "Org One",
    "placeholder",
    Date.now(),
  );
  await db.prepare(
    "INSERT INTO projects (id, name, repo, org_id) VALUES (?, ?, ?, ?)",
  ).run("p1", "Project One", "acme/one", "org1");
  const admin = await seedMember(db, {
    name: "ada",
    projectId: "p1",
    projectName: "Project One",
    role: "admin",
  });
  adminUserId = admin.userId;
  adminCookie = await sessionCookie(db, admin.email);
  await db.prepare("UPDATE orgs SET created_by = ? WHERE id = ?").run(adminUserId, "org1");

  const member = await seedMember(db, {
    name: "bob",
    projectId: "p1",
    projectName: "Project One",
    role: "human",
  });
  memberUserId = member.userId;
  memberCookie = await sessionCookie(db, member.email);
  void memberUserId;
  void grantMembership;

  const made = createApp(db, { driverFor: () => new FakeDriver() });
  worker = made.worker;
  await new Promise<void>((resolve, reject) => {
    server = made.app.listen(0, "127.0.0.1", (error?: Error) => (error ? reject(error) : resolve()));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  worker.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function api(path: string, cookie: string, init?: RequestInit) {
  return fetch(`${baseUrl}/api${path}`, {
    ...init,
    headers: {
      Cookie: cookie,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

describe("org settings BYOK API", () => {
  it("lets org admin store a provider key (secret never returned) and resolve settings", async () => {
    const created = await api("/orgs/org1/provider-keys", adminCookie, {
      method: "POST",
      body: JSON.stringify({ label: "prod", secret: "sk-or-v1-secret-value-42" }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.last4).toBe("e-42");
    expect(JSON.stringify(createdBody)).not.toContain("sk-or-v1-secret-value-42");

    const settings = await api("/orgs/org1/settings", adminCookie);
    expect(settings.status).toBe(200);
    const body = await settings.json();
    expect(body.isAdmin).toBe(true);
    expect(body.providerId).toBe("openrouter");
    expect(body.resolvedLiteModel).toBe("google/gemini-3.1-flash-lite");
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0].isDefault).toBe(true);
    expect(body.keys[0].last4).toBe("e-42");
    expect(JSON.stringify(body)).not.toContain("sk-or-v1-secret-value-42");
  });

  it("blocks non-admin mutations and enforces org_admins_only project create", async () => {
    const deniedKey = await api("/orgs/org1/provider-keys", memberCookie, {
      method: "POST",
      body: JSON.stringify({ label: "nope", secret: "sk-x" }),
    });
    expect(deniedKey.status).toBe(403);

    const policy = await api("/orgs/org1/settings", adminCookie, {
      method: "PATCH",
      body: JSON.stringify({ projectCreatePolicy: "org_admins_only" }),
    });
    expect(policy.status).toBe(200);

    const deniedCreate = await api("/orgs/org1/projects", memberCookie, {
      method: "POST",
      body: JSON.stringify({ name: "Should Fail" }),
    });
    expect(deniedCreate.status).toBe(403);

    const adminCreate = await api("/orgs/org1/projects", adminCookie, {
      method: "POST",
      body: JSON.stringify({ name: "Admin Project" }),
    });
    expect(adminCreate.status).not.toBe(403);
  });
});
