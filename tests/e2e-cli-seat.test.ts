// Part F4 — the full custom-role seat path, end to end through the real app:
// admin defines a role → mints an enrollment for it → a teammate redeems the
// token → the redeemed seat connects to MCP and gets the worker/coder tool
// surface. Redeeming the same token twice is rejected (single-use).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
let cookieAdmin: string;

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
  cookieAdmin = await magicLinkSessionCookie(dbRef, "admin@e2e.test", "Admin");
  const adminId = (await dbRef.prepare('SELECT id FROM "user" WHERE email = ?').get<{ id: string }>("admin@e2e.test"))!.id;
  await grantMembership(dbRef, adminId, "demo", "admin");
  await new Promise<void>((resolve) => {
    httpServer = made.app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterEach(async () => {
  worker.stop();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

describe("e2e: enrollment → custom role seat → MCP tool surface", () => {
  it("enrolls a reviewer, redeems once, and connects to the coder surface", async () => {
    // Admin defines the custom role.
    const createRole = await fetch(`${baseUrl}/api/p/demo/roles`, {
      method: "POST",
      headers: { Cookie: cookieAdmin, "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "reviewer", kind: "worker", displayName: "Reviewer" }),
    });
    expect(createRole.status, await createRole.clone().text()).toBe(200);

    // Admin mints an enrollment grant for that role.
    const mint = await fetch(`${baseUrl}/api/p/demo/enrollments`, {
      method: "POST",
      headers: { Cookie: cookieAdmin, "Content-Type": "application/json" },
      body: JSON.stringify({ role: "reviewer" }),
    });
    expect(mint.status).toBe(200);
    const { token } = (await mint.json()) as { token: string };

    // Teammate redeems the token into a role-scoped seat.
    const redeem = await fetch(`${baseUrl}/api/enroll/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(redeem.status, await redeem.clone().text()).toBe(200);
    const seat = (await redeem.json()) as { role: string; key: string; projectId: string; mcpUrl: string };
    expect(seat.role).toBe("reviewer");
    expect(seat.projectId).toBe("demo");
    expect(typeof seat.key).toBe("string");
    expect(seat.mcpUrl).toContain("/mcp");

    // The seat connects to MCP and receives the worker/coder tool surface.
    const client = new Client({ name: "e2e-cli-seat", version: "0.0.1" });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${seat.key}` } },
    });
    await client.connect(transport);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain("coder_claim_task");
      expect(names).not.toContain("human_submit");
    } finally {
      await client.close().catch(() => undefined);
    }

    // The grant is single-use: a second redemption is rejected.
    const again = await fetch(`${baseUrl}/api/enroll/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(again.status).toBe(409);
  }, 60_000);
});
