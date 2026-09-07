// Part F2 — a seat's ROLE KIND (not the literal slug) selects the MCP tool
// surface. A custom worker-kind role ("reviewer") must resolve to the coder
// surface with no change to tools.ts; a human-kind role gets the human surface.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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
let adminId: string;

async function grantMembership(db: Db, userId: string, projectId: string, role: string): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO "organization" (id, name, slug, "createdAt") VALUES (?, ?, ?, ?)')
    .run(projectId, projectId, projectId, new Date().toISOString());
  await db
    .prepare('INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES (?, ?, ?, ?, ?)')
    .run(`${userId}-${projectId}`, projectId, userId, role, new Date().toISOString());
}

beforeEach(async () => {
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || "memracer-dev-better-auth-secret-0123456789-abcdef";
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
  const cookie = await magicLinkSessionCookie(dbRef, "admin@surface.test", "Admin");
  adminId = (await dbRef.prepare('SELECT id FROM "user" WHERE email = ?').get<{ id: string }>("admin@surface.test"))!.id;
  await grantMembership(dbRef, adminId, "demo", "admin");
  await new Promise<void>((resolve) => {
    httpServer = made.app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  void cookie;
});

afterEach(async () => {
  worker.stop();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

/** Mint a seat key via a directly-inserted enrollment for an arbitrary role slug. */
async function mintSeatForRole(role: string): Promise<string> {
  const token = `mzr_enrl_${randomUUID()}`;
  const hash = createHash("sha256").update(token).digest("hex");
  await dbRef
    .prepare(
      `INSERT INTO seat_enrollments
         (id, project_id, role, token_hash, created_by, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(randomUUID(), "demo", role, hash, adminId, Date.now() + 600_000, Date.now());
  const res = await fetch(`${baseUrl}/api/enroll/redeem`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  const body = (await res.json()) as { key: string; role: string };
  expect(body.role).toBe(role);
  return body.key;
}

async function toolNames(token: string): Promise<string[]> {
  const client = new Client({ name: "role-surface-test", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    return tools.map((t) => t.name);
  } finally {
    await client.close().catch(() => undefined);
  }
}

describe("role kind drives the tool surface", () => {
  it("a custom worker role (reviewer) gets the coder surface", async () => {
    await dbRef
      .prepare(
        `INSERT INTO roles (project_id, slug, kind, display_name, always_available, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("demo", "reviewer", "worker", "Reviewer", 0, Date.now());

    const names = await toolNames(await mintSeatForRole("reviewer"));
    expect(names).toContain("coder_claim_task");
    expect(names).not.toContain("human_submit");
  });

  it("a human role gets the human surface", async () => {
    const names = await toolNames(await mintSeatForRole("human"));
    expect(names).toContain("human_submit");
    expect(names).not.toContain("coder_claim_task");
  });
});
