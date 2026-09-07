import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openDb } from "../src/db.js";
import { createApp } from "../src/server.js";
import { FakeDriver } from "../src/mediator/fake.js";
import type { GroomResult, MediatorContext, Submission } from "../src/mediator/driver.js";
import type { MediatorWorker } from "../src/mediator/worker.js";
import { betterAuthReady, seedMember } from "./helpers/auth.js";
import { parseToolResult } from "./helpers/async-human.js";

// Scripted groom: accept the submission with a grounded extraction, so the
// submit echo has a `reading` to build. Reuses the async-human harness (custom
// driver injected via createApp's driverFor).
class ExtractionGroomDriver extends FakeDriver {
  override async groom(_ctx: MediatorContext, _s: Submission): Promise<GroomResult> {
    return {
      action: "accept",
      title: "Normalize orders to nearest lot",
      body: "Round every order size down to the nearest valid szDecimals lot before submit.",
      priority: 0,
      rationale: "accepted with grounded extraction",
      reasoning: "restated the submission's intent before writing the brief",
      extraction: {
        subject: "normalize Hyperliquid orders to nearest lot",
        current_behavior: "raw size leaks wire rounding",
        desired_behavior: "normalized to szDecimals lot",
        in_scope: ["order sizing"],
        out_of_scope: ["funding"],
      },
    };
  }
}

let db: ReturnType<typeof openDb>;
let server: Server;
let worker: MediatorWorker;
let baseUrl: string;
let token: string;

beforeEach(async () => {
  db = openDb(":memory:");
  await betterAuthReady(db);
  await db.prepare("INSERT INTO projects (id, name) VALUES ('demo','Demo')").run();
  token = (await seedMember(db, { name: "dana", projectId: "demo", role: "human" })).token;
  const made = createApp(db, {
    driverFor: () => new ExtractionGroomDriver(),
    workerOpts: { tickMs: 10, jobTimeoutMs: 300_000 },
  });
  worker = made.worker;
  await new Promise<void>((resolve) => {
    server = made.app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});

afterEach(async () => {
  worker.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function connect(): Promise<Client> {
  const client = new Client({ name: "tools-human-submit-test", version: "0.0.1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(baseUrl), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  return client;
}

describe("human_submit reading echo", () => {
  it("returns the groom's grounded reading for the submitter to confirm", async () => {
    const client = await connect();
    const res = parseToolResult(await client.callTool({
      name: "human_submit",
      arguments: {
        project: "demo",
        title: "normalize orders",
        body: "FEATURE: normalize Hyperliquid orders to the nearest valid lot size",
        evidence: [],
        wait: true,
      },
    }));
    expect(res.reading.subject).toMatch(/normalize .* orders/i);
    expect(res.reading.confirm_prompt).toMatch(/is this what you meant/i);
    await client.close();
  });
});
