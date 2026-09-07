// tests/coder-kit-hooks.test.ts — the kit's hook scripts run as real child
// processes against a live in-process server, exactly as Claude Code would
// invoke them: hook input JSON on stdin, MEMRACER_* in the environment.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openDb } from "../src/db.js";
import { betterAuthReady, seedMember } from "./helpers/auth.js";
import { createApp } from "../src/server.js";
import { FakeDriver } from "../src/mediator/fake.js";
import type { MediatorWorker } from "../src/mediator/worker.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STOP_HOOK = path.join(ROOT, "coder-kit", "hooks", "stop-heartbeat.sh");
const PRECOMPACT_HOOK = path.join(ROOT, "coder-kit", "hooks", "precompact-brief.sh");

let httpServer: Server;
let baseUrl: string;
let worker: MediatorWorker;
let dbRef: ReturnType<typeof openDb>;
let tempDir: string;
let tokH: string;
let tokC: string;
const clients: Client[] = [];

beforeEach(async () => {
  dbRef = openDb(":memory:");
  await dbRef.prepare("INSERT INTO projects (id, name) VALUES ('demo','Demo')").run();
  await betterAuthReady(dbRef);
  tokH = (await seedMember(dbRef, { name: "dana", projectId: "demo", role: "human" })).token;
  tokC = (await seedMember(dbRef, { name: "cc-7f2", projectId: "demo", role: "coder" })).token;
  const made = createApp(dbRef, { driverFor: () => new FakeDriver(), workerOpts: { tickMs: 20, jobTimeoutMs: 2000 } });
  worker = made.worker;
  await new Promise<void>((resolve) => {
    httpServer = made.app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`;
  tempDir = mkdtempSync(path.join(tmpdir(), "coder-kit-hooks-"));
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  worker.stop();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  rmSync(tempDir, { recursive: true, force: true });
});

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: `test-${token}`, version: "0.0.1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(baseUrl), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  clients.push(client);
  return client;
}

function parse(result: { content?: unknown }) {
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0].text);
}

/** Submit a task as the human and claim it as the coder; returns the task id. */
async function claimedTask(): Promise<number> {
  const dana = await connect(tokH);
  const submitted = parse(
    await dana.callTool({
      name: "human_submit",
      arguments: { title: "Rate limit ingest", body: "Add a limiter. Accept: p95 under 200ms.", evidence: [] },
    }),
  );
  const coder = await connect(tokC);
  const brief = parse(await coder.callTool({ name: "coder_claim_task", arguments: {} }));
  expect(brief.id).toBe(submitted.task.id);
  return brief.id as number;
}

interface HookRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runHook(script: string, stdin: unknown, env: Record<string, string | undefined>): Promise<HookRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(script, [], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.write(JSON.stringify(stdin));
    child.stdin.end();
  });
}

const stopInput = (active: boolean) => ({
  session_id: "abc123",
  transcript_path: "/tmp/nope.jsonl",
  cwd: "/tmp",
  hook_event_name: "Stop",
  stop_hook_active: active,
  last_assistant_message: "Done for now.",
});

describe("stop-heartbeat.sh", { retry: 3 }, () => {
  it("blocks the stop and names the leased task id", async () => {
    const taskId = await claimedTask();
    const run = await runHook(STOP_HOOK, stopInput(false), { MEMRACER_URL: baseUrl, MEMRACER_TOKEN: tokC });
    expect(run.code).toBe(0);
    const out = JSON.parse(run.stdout);
    expect(out.decision).toBe("block");
    expect(out.reason).toContain(String(taskId));
  }, 15_000);

  it("allows the stop when no lease is held", async () => {
    const run = await runHook(STOP_HOOK, stopInput(false), { MEMRACER_URL: baseUrl, MEMRACER_TOKEN: tokC });
    expect(run.code).toBe(0);
    expect(run.stdout.trim()).toBe("");
  }, 15_000);

  it("exits 0 silently when stop_hook_active is true, even with a lease held", async () => {
    await claimedTask();
    const run = await runHook(STOP_HOOK, stopInput(true), { MEMRACER_URL: baseUrl, MEMRACER_TOKEN: tokC });
    expect(run.code).toBe(0);
    expect(run.stdout.trim()).toBe("");
  }, 15_000);

  it("exits 0 silently when MEMRACER_URL / MEMRACER_TOKEN are missing", async () => {
    await claimedTask();
    for (const env of [{}, { MEMRACER_URL: baseUrl }, { MEMRACER_TOKEN: tokC }]) {
      const run = await runHook(STOP_HOOK, stopInput(false), env);
      expect(run.code).toBe(0);
      expect(run.stdout.trim()).toBe("");
    }
  }, 15_000);
});

const sessionStartInput = {
  session_id: "abc123",
  transcript_path: "/tmp/nope.jsonl",
  cwd: "/tmp",
  hook_event_name: "SessionStart",
  source: "compact",
};

describe("precompact-brief.sh", { retry: 3 }, () => {
  it("re-injects the task brief as SessionStart additionalContext", async () => {
    const briefFile = path.join(tempDir, ".memracer-task.json");
    writeFileSync(
      briefFile,
      JSON.stringify({ id: 7, title: "Rate limit ingest", body: "Add a limiter. Accept: p95 under 200ms." }),
    );
    const run = await runHook(PRECOMPACT_HOOK, sessionStartInput, { MEMRACER_TASK_FILE: briefFile });
    expect(run.code).toBe(0);
    const out = JSON.parse(run.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(out.hookSpecificOutput.additionalContext).toContain("Rate limit ingest");
    expect(out.hookSpecificOutput.additionalContext).toContain("Accept: p95 under 200ms.");
    expect(out.hookSpecificOutput.additionalContext).toContain("7");
  });

  it("exits 0 silently when the brief file is missing or the env var is unset", async () => {
    for (const env of [{}, { MEMRACER_TASK_FILE: path.join(tempDir, "gone.json") }]) {
      const run = await runHook(PRECOMPACT_HOOK, sessionStartInput, env);
      expect(run.code).toBe(0);
      expect(run.stdout.trim()).toBe("");
    }
  });
});
