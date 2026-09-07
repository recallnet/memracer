/**
 * L1: Bearer token initialize against a real local MCP HTTP endpoint.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openDb, type Db } from "../src/db.js";
import { createApp } from "../src/server.js";
import { FakeDriver } from "../src/mediator/fake.js";
import type { MediatorWorker } from "../src/mediator/worker.js";
import { betterAuthReady, seedMember } from "./helpers/auth.js";

let httpServer: Server;
let worker: MediatorWorker;
let db: Db;
let mcpUrl: string;
let token: string;

beforeEach(async () => {
  db = openDb(":memory:");
  await betterAuthReady(db);
  await db.prepare("INSERT INTO projects (id, name, repo) VALUES (?, ?, ?)").run(
    "demo",
    "Demo",
    "acme/demo",
  );
  // Billing gate: Frigg requires paid plan on real driver; FakeDriver still needs org for member seed.
  await db
    .prepare("INSERT INTO orgs (id, name, created_at, plan, seat_quantity, billing_status) VALUES (?, ?, ?, ?, ?, ?)")
    .run("org-demo", "Demo Org", Date.now(), "team", 10, "active");
  await db.prepare("UPDATE projects SET org_id = ? WHERE id = ?").run("org-demo", "demo");
  token = (await seedMember(db, { name: "coder", projectId: "demo", role: "coder" })).token;
  const made = createApp(db, {
    driverFor: () => new FakeDriver(),
    workerOpts: { tickMs: 20, jobTimeoutMs: 2000 },
  });
  worker = made.worker;
  await new Promise<void>((resolve) => {
    httpServer = made.app.listen(0, () => resolve());
  });
  mcpUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`;
});

afterEach(async () => {
  worker.stop();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await db.close();
});

describe("L1 MCP HTTP smoke — Bearer initialize", () => {
  it("connects with Authorization Bearer and lists tools", async () => {
    const client = new Client({ name: "smoke", version: "0.0.1" });
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.length).toBeGreaterThan(0);
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("coder_check_work");
    await client.close();
  });

  it("rejects missing Bearer", async () => {
    const client = new Client({ name: "smoke-bad", version: "0.0.1" });
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
    await expect(client.connect(transport)).rejects.toThrow();
  });
});
