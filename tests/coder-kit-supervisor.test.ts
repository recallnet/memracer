// tests/coder-kit-supervisor.test.ts — integration: real server in-process,
// supervisor.mjs as a child process, stub coder standing in for `claude`.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openDb, type Db } from "../src/db.js";
import { betterAuthReady, seedMember } from "./helpers/auth.js";
import { createApp } from "../src/server.js";
import { FakeDriver } from "../src/mediator/fake.js";
import type { MediatorWorker } from "../src/mediator/worker.js";
import { LEASE_RECOVERY_GRACE_MS } from "../src/queue.js";
import { mergedGreenPrVerifier } from "./helpers/pr-verifier.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUPERVISOR = path.join(ROOT, "coder-kit", "supervisor.mjs");
const STUB = path.join(ROOT, "tests", "fixtures", "stub-coder.mjs");

let httpServer: Server;
let baseUrl: string;
let worker: MediatorWorker;
let dbRef: Db;
let tempDir: string;
let supervisor: ChildProcess | null = null;
let supervisorOut = "";
let tokH: string;
let tokC: string;
let leaseAgentId: string;

beforeEach(async () => {
  dbRef = openDb(":memory:");
  // Repo must match the stub-coder PR URL (recallnet/demo).
  await dbRef.prepare("INSERT INTO projects (id, name, repo) VALUES ('demo','Demo','recallnet/demo')").run();
  await betterAuthReady(dbRef);
  tokH = (await seedMember(dbRef, { name: "dana", projectId: "demo", role: "human" })).token;
  const coder = await seedMember(dbRef, { name: "cc-7f2", projectId: "demo", role: "coder" });
  tokC = coder.token;
  leaseAgentId = coder.keyId;
  const made = createApp(dbRef, {
    driverFor: () => new FakeDriver(),
    workerOpts: { tickMs: 20, jobTimeoutMs: 2000 },
    prVerifier: mergedGreenPrVerifier(),
  });
  worker = made.worker;
  await new Promise<void>((resolve) => {
    httpServer = made.app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`;
  tempDir = mkdtempSync(path.join(tmpdir(), "coder-kit-test-"));
  supervisorOut = "";
});

afterEach(async () => {
  await stopSupervisor();
  worker.stop();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  rmSync(tempDir, { recursive: true, force: true });
});

function writeConfig(overrides: Record<string, unknown> = {}): string {
  const configPath = path.join(tempDir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      serverUrl: baseUrl,
      token: tokC,
      agentName: "cc-7f2",
      targetRepo: tempDir,
      claudeCmd: process.execPath,
      claudeArgs: [STUB],
      maxTaskMinutes: 5,
      waitTimeoutS: 1,
      idlePollS: 0.05,
      goalLeasePollS: 0.1,
      ...overrides,
    }),
  );
  return configPath;
}

function startSupervisor(configPath: string, env: Record<string, string> = {}): void {
  supervisor = spawn(process.execPath, [SUPERVISOR, configPath], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  supervisor.stdout!.on("data", (d: Buffer) => (supervisorOut += d.toString()));
  supervisor.stderr!.on("data", (d: Buffer) => (supervisorOut += d.toString()));
}

async function stopSupervisor(): Promise<void> {
  const child = supervisor;
  supervisor = null;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  await Promise.race([exited, sleep(2000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor<T>(
  fn: () => T | undefined | false | Promise<T | undefined | false>,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n--- supervisor output ---\n${supervisorOut}`);
    await sleep(25);
  }
}

async function taskRow(id: number): Promise<{ state: string; lease_agent: string | null; result_summary: string | null }> {
  return (await dbRef
    .prepare("SELECT state, lease_agent, result_summary FROM tasks WHERE id=?")
    .get<{ state: string; lease_agent: string | null; result_summary: string | null }>(id)) as {
    state: string;
    lease_agent: string | null;
    result_summary: string | null;
  };
}

async function humanClient(): Promise<Client> {
  const client = new Client({ name: "test-human", version: "0.0.1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(baseUrl), {
      requestInit: { headers: { Authorization: `Bearer ${tokH}` } },
    }),
  );
  return client;
}

function parse(result: { content?: unknown }) {
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0].text);
}

function spawnedPids(): number[] {
  return [...supervisorOut.matchAll(/spawned session pid=(\d+)/g)].map((m) => Number(m[1]));
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("coder-kit supervisor", { retry: 3 }, () => {
  it("keeps repeated empty checks in one live process with the configured idle sleep", async () => {
    startSupervisor(writeConfig({ idlePollS: 0.2 }));
    await waitFor(() => (supervisorOut.match(/no work — sleeping/g) ?? []).length >= 2, 8000, "two idle cycles");

    const timestamps = [...supervisorOut.matchAll(/\[supervisor\] (\S+) no work — sleeping 0\.2s/g)].map((match) =>
      Date.parse(match[1]),
    );
    expect(timestamps.length).toBeGreaterThanOrEqual(2);
    expect(timestamps[1] - timestamps[0]).toBeGreaterThanOrEqual(1100);
    expect(supervisor!.exitCode).toBeNull();
    expect(spawnedPids()).toHaveLength(0);
  }, 12_000);

  it("parks on an empty queue and drains submissions with one fresh stub session per task", async () => {
    startSupervisor(writeConfig());

    // (a) empty queue: supervisor parks — polls without claiming anything.
    // waitFor rather than a fixed sleep: under launchd background QoS (the
    // mini's deploy gate) startup is CPU-throttled and a 2s window flakes.
    await waitFor(() => /no work/.test(supervisorOut), 15000, "supervisor park log");
    expect(supervisor!.exitCode).toBeNull();
    expect(spawnedPids()).toHaveLength(0);
    expect(await dbRef.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 0 });

    // (b) submission wakes it: stub claims, reports progress, completes → DONE.
    const dana = await humanClient();
    const first = parse(
      await dana.callTool({
        name: "human_submit",
        arguments: { title: "Rate limit ingest", body: "add limiter", evidence: [] },
      }),
    );
    const task1: number = first.task.id;
    await waitFor(async () => (await taskRow(task1)).lease_agent === leaseAgentId, 5000, "task 1 claim");
    await waitFor(async () => (await taskRow(task1)).state === "DONE", 10_000, "task 1 DONE");
    expect((await taskRow(task1)).result_summary).toMatch(/^done(\n\nverification: .+)?$/);

    // (c) a second task gets a second, fresh stub session.
    const second = parse(
      await dana.callTool({
        name: "human_submit",
        arguments: { title: "Throttle exports", body: "cap export rate", evidence: [] },
      }),
    );
    const task2: number = second.task.id;
    await waitFor(async () => (await taskRow(task2)).lease_agent === leaseAgentId, 5000, "task 2 claim");
    await waitFor(async () => (await taskRow(task2)).state === "DONE", 10_000, "task 2 DONE");

    const pids = spawnedPids();
    expect(pids).toHaveLength(2);
    expect(pids[0]).not.toBe(pids[1]);

    await dana.close();
    await stopSupervisor();
    // stopSupervisor awaits the supervisor's own exit, but the stub
    // grandchildren it spawned die asynchronously after it — wait for each
    // rather than asserting instantly (raced on a loaded CI runner).
    for (const pid of pids) await waitFor(() => !pidAlive(pid), 5000, `stub ${pid} death`);
  }, 30_000);

  it("watchdog kills a hung session at maxTaskMinutes (fractional minutes)", async () => {
    // 0.04 min = 2.4 s
    startSupervisor(writeConfig({ maxTaskMinutes: 0.04 }), { STUB_MODE: "hang" });

    const dana = await humanClient();
    parse(
      await dana.callTool({
        name: "human_submit",
        arguments: { title: "Never finishes", body: "hang", evidence: [] },
      }),
    );
    const pid = await waitFor(() => spawnedPids()[0], 5000, "stub spawn");
    expect(pidAlive(pid)).toBe(true);

    await waitFor(() => supervisorOut.includes("killed by watchdog"), 8000, "watchdog kill log");
    await waitFor(() => !pidAlive(pid), 2000, "stub process death");
    expect(supervisorOut).toMatch(/watchdog: task \d+ exceeded 0\.04 min/);

    // Stub never talked to the server, so the lease stays live; server-side
    // expiry requeues it later — the supervisor logs exactly that.
    expect(supervisorOut).toMatch(/lease still live/);
    const row = await dbRef.prepare("SELECT state, lease_agent FROM tasks LIMIT 1").get();
    expect(row).toMatchObject({ lease_agent: leaseAgentId });

    await dana.close();
    await stopSupervisor();
    expect(pidAlive(pid)).toBe(false);
  }, 20_000);

  it("starts a recovery session when a worker exits while retaining an active lease", async () => {
    const prematureExitFile = path.join(tempDir, "premature-exit");
    startSupervisor(writeConfig(), {
      STUB_MODE: "premature-exit",
      STUB_PREMATURE_EXIT_FILE: prematureExitFile,
    });

    const dana = await humanClient();
    const submitted = parse(
      await dana.callTool({
        name: "human_submit",
        arguments: { title: "Recover unfinished task", body: "finish after worker exit", evidence: [] },
      }),
    );
    const taskId: number = submitted.task.id;

    await waitFor(() => supervisorOut.includes("remains leased after session exit"), 5000, "lease recovery log");
    expect((await taskRow(taskId)).lease_agent).not.toBeNull();
    await waitFor(async () => (await taskRow(taskId)).state === "DONE", 12_000, "recovered task DONE");

    expect(spawnedPids()).toHaveLength(2);
    expect(await taskRow(taskId)).toMatchObject({ state: "DONE", lease_agent: null });
    expect(supervisorOut).not.toContain("server-side expiry will requeue");

    await dana.close();
  }, 20_000);

  it("keeps a live-leased canonical goal past the duration watchdog, then kills it after lease loss", async () => {
    const stopProgressFile = path.join(tempDir, "stop-goal-progress");
    const progressStoppedFile = path.join(tempDir, "goal-progress-stopped");
    startSupervisor(writeConfig({ maxTaskMinutes: 0.02 }), {
      STUB_MODE: "goal-progress",
      STUB_PROGRESS_STOP_FILE: stopProgressFile,
      STUB_PROGRESS_STOPPED_FILE: progressStoppedFile,
    });

    const dana = await humanClient();
    parse(
      await dana.callTool({
        name: "human_submit",
        arguments: {
          title: "Keep working to green",
          body: "Goal: all checks pass.\nVerify: pnpm test; PASS means exit 0.\nInvariants: preserve APIs; do not change migrations.",
          evidence: [],
        },
      }),
    );
    const pid = await waitFor(() => spawnedPids()[0], 5000, "goal stub spawn");
    await waitFor(() => supervisorOut.includes("static task-duration watchdog exempt"), 5000, "goal exemption log");
    await sleep(1800);

    expect(pidAlive(pid)).toBe(true);
    expect(supervisorOut).not.toContain("killed by watchdog");
    const notes = await dbRef.prepare("SELECT COUNT(*) AS n FROM task_notes").get<{ n: number }>();
    expect(notes!.n).toBeGreaterThan(1);

    // Stop progress without stopping the child, then move its lease beyond
    // the owner-recovery grace so heartbeat observes ownership loss.
    writeFileSync(stopProgressFile, "stop");
    await waitFor(() => existsSync(progressStoppedFile), 5000, "goal progress stop acknowledgement");
    await dbRef.prepare("UPDATE tasks SET lease_expires_at=? WHERE lease_agent=?").run(Date.now() - LEASE_RECOVERY_GRACE_MS - 1, leaseAgentId);
    await waitFor(() => supervisorOut.includes("lease no longer live — killing stale session"), 5000, "goal lease-loss kill");
    await waitFor(() => !pidAlive(pid), 5000, "goal stub death after lease loss");
    await waitFor(() => supervisorOut.includes("killed after lease loss"), 5000, "goal lease-loss completion log");

    await dana.close();
    await stopSupervisor();
  }, 15_000);
});
