// MCP BYOK fail-fast: tools/call without org/project key → isError + Org Settings.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openDb } from "../src/db.js";
import { createApp } from "../src/server.js";
import { FakeDriver } from "../src/mediator/fake.js";
import type { MediatorWorker } from "../src/mediator/worker.js";
import { betterAuthReady, seedMember } from "./helpers/auth.js";
import { encryptSecret } from "../src/secrets.js";
import { randomUUID } from "node:crypto";

const SECRETS_ENV = { BETTER_AUTH_SECRET: "test-secret-key-for-byok-envelope-32b" };

let db: ReturnType<typeof openDb>;
let server: Server;
let worker: MediatorWorker;
let baseUrl: string;
let tokH: string;
let tokC: string;
const prevOpenrouter = process.env.OPENROUTER_API_KEY;
const prevStrict = process.env.MEMRACER_BYOK_STRICT;

beforeEach(async () => {
  process.env.BETTER_AUTH_SECRET = SECRETS_ENV.BETTER_AUTH_SECRET;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.MEMRACER_BYOK_STRICT;

  db = openDb(":memory:");
  await betterAuthReady(db);
  await db
    .prepare("INSERT INTO orgs (id, name, created_by, created_at) VALUES (?, ?, ?, ?)")
    .run("org-gate", "Gate Org", "user-1", Date.now());
  await db
    .prepare("UPDATE orgs SET plan = ?, seat_quantity = ?, billing_status = ? WHERE id = ?")
    .run("team", 5, "active", "org-gate");
  await db
    .prepare(
      "INSERT INTO projects (id, name, org_id, repo, created_by, mediator_model) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run("demo", "Demo", "org-gate", "recallnet/demo-app", "user-1", "z-ai/glm-5.2");

  tokH = (await seedMember(db, { name: "dana", projectId: "demo", role: "human" })).token;
  tokC = (await seedMember(db, { name: "cc-7f2", projectId: "demo", role: "coder" })).token;

  const made = createApp(db, {
    driverFor: () => new FakeDriver(),
    workerOpts: { tickMs: 10, jobTimeoutMs: 2000 },
  });
  worker = made.worker;
  await new Promise<void>((resolve) => {
    server = made.app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});

afterEach(async () => {
  if (prevOpenrouter === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = prevOpenrouter;
  if (prevStrict === undefined) delete process.env.MEMRACER_BYOK_STRICT;
  else process.env.MEMRACER_BYOK_STRICT = prevStrict;
  worker.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: "mcp-inference-gate", version: "0.0.1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(baseUrl), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

function errorText(result: { isError?: boolean; content?: unknown }): string {
  const content = result.content as { type: string; text?: string }[] | undefined;
  return (content ?? []).map((c) => c.text ?? "").join(" ");
}

async function addOrgKey(secret = "sk-test-org-key-abcdef"): Promise<void> {
  const enc = encryptSecret(secret, SECRETS_ENV);
  const id = randomUUID();
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO org_provider_keys
         (id, org_id, label, ciphertext, iv, tag, last4, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, "org-gate", "prod", enc.ciphertext, enc.iv, enc.tag, secret.slice(-4), "user-1", now);
  await db.prepare("UPDATE orgs SET default_provider_key_id = ? WHERE id = ?").run(id, "org-gate");
}

describe("MCP inference fail-fast (BYOK only)", () => {
  it("fails human_status with isError + Org Settings when no key even if host OPENROUTER is set", async () => {
    process.env.OPENROUTER_API_KEY = "sk-host-should-not-unlock-mcp";
    const human = await connect(tokH);
    const res = await human.callTool({
      name: "human_status",
      arguments: { project: "demo" },
    });
    expect(res.isError).toBe(true);
    expect(errorText(res)).toMatch(/Org Settings/i);
    await human.close();
  });

  it("fails coder_check_work with isError + Org Settings when no key", async () => {
    process.env.OPENROUTER_API_KEY = "sk-host-ignored";
    const coder = await connect(tokC);
    const res = await coder.callTool({
      name: "coder_check_work",
      arguments: { project: "demo", timeout_s: 1 },
    });
    expect(res.isError).toBe(true);
    expect(errorText(res)).toMatch(/Org Settings/i);
    await coder.close();
  });

  it("succeeds human_status after an org default key is configured", async () => {
    await addOrgKey();
    const human = await connect(tokH);
    const res = await human.callTool({
      name: "human_status",
      arguments: { project: "demo" },
    });
    expect(res.isError).not.toBe(true);
    const text = errorText(res);
    expect(text).toMatch(/projects|tasks|attention/i);
    await human.close();
  });

  it("succeeds with project_secret and no org table key", async () => {
    const secret = "sk-project-only-secret";
    const enc = encryptSecret(secret, SECRETS_ENV);
    await db
      .prepare(
        `UPDATE projects SET
           provider_key_mode = 'project_secret',
           project_key_ciphertext = ?,
           project_key_iv = ?,
           project_key_tag = ?,
           project_key_last4 = ?
         WHERE id = ?`,
      )
      .run(enc.ciphertext, enc.iv, enc.tag, secret.slice(-4), "demo");

    const coder = await connect(tokC);
    const res = await coder.callTool({
      name: "coder_check_work",
      arguments: { project: "demo", timeout_s: 1 },
    });
    expect(res.isError).not.toBe(true);
    await coder.close();
  });

  it("fails with Subscribe message when org has no paid plan", async () => {
    await db
      .prepare("UPDATE orgs SET plan = ?, seat_quantity = ?, billing_status = ? WHERE id = ?")
      .run("none", 0, "inactive", "org-gate");
    await addOrgKey();
    const human = await connect(tokH);
    const res = await human.callTool({
      name: "human_status",
      arguments: { project: "demo" },
    });
    expect(res.isError).toBe(true);
    expect(errorText(res)).toMatch(/Subscribe|plan|Org Settings/i);
    await human.close();
  });
});
