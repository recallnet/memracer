/**
 * Live, opt-in acceptance eval for a coder running without coder-kit/supervisor.mjs.
 *
 * The harness supplies one clean Claude session with only a memracer MCP config
 * and the user turn "Begin." It does not tell the agent how to poll. Once the
 * server observes several empty read-only checks, the harness verifies that the main
 * transcript stayed flat, queues a fixture task, and grades the lifecycle.
 *
 * Usage: pnpm eval:bare-coder
 * Optional: BARE_CODER_EVAL_TIMEOUT_MS=360000 BARE_CODER_EVAL_MODEL=sonnet
 *           BARE_CODER_EVAL_WAIT_S=1 BARE_CODER_EVAL_IDLE_CYCLES=3
 *           MEMRACER_IDLE_POLL_S=1
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openDb, type Db } from "../src/db.js";
import {
  hasUniqueCompetingClaimSplit,
  idleSnapshotsUnchanged,
  type ClaimReturn,
  type IdleDbSnapshot,
} from "../src/eval/bare-coder-grader.js";
import { DEFAULT_LEASE_TTL_MS } from "../src/queue.js";
import { createApp } from "../src/server.js";
import { FakeDriver } from "../src/mediator/fake.js";
import { betterAuthReady, seedMember } from "../tests/helpers/auth.js";

const timeoutMs = Number(process.env.BARE_CODER_EVAL_TIMEOUT_MS ?? 360_000);
const evalWaitS = Number(process.env.BARE_CODER_EVAL_WAIT_S ?? 1);
const requiredIdleCycles = Number(process.env.BARE_CODER_EVAL_IDLE_CYCLES ?? 3);
const idlePollS = Number(process.env.MEMRACER_IDLE_POLL_S ?? 1);
const claudeCmd = process.env.BARE_CODER_EVAL_CLAUDE_CMD ?? "claude";
const tempDir = mkdtempSync(path.join(tmpdir(), "memracer-bare-coder-eval-"));

interface TaskState {
  state: string;
  lease_agent: string | null;
  plan_approved_at: number | null;
}

interface EvalState {
  transcriptCheckCalls: number;
  serverCheckStarts: number[];
  emptyReturns: number;
  emptyObserved: boolean;
  recheckAfterEmpty: boolean;
  assistantTurns: number;
  usageTokens: number;
  idleBaseline: { turns: number; tokens: number } | null;
  idleTurnsFlat: boolean;
  idleTokensFlat: boolean;
  idleCadenceOk: boolean;
  taskId: number | null;
  raceTaskId: number | null;
  sentinelTaskId: number | null;
  claimCalls: number;
  serverClaimReturns: ClaimReturn[];
  competitorClaimedTaskId: number | null;
  idleDbBaseline: IdleDbSnapshot | null;
  idleDbSnapshots: IdleDbSnapshot[];
  progressCalls: number;
  completeCalls: number;
  postCompleteCheck: boolean;
  toolSequence: string[];
}

const state: EvalState = {
  transcriptCheckCalls: 0,
  serverCheckStarts: [],
  emptyReturns: 0,
  emptyObserved: false,
  recheckAfterEmpty: false,
  assistantTurns: 0,
  usageTokens: 0,
  idleBaseline: null,
  idleTurnsFlat: false,
  idleTokensFlat: false,
  idleCadenceOk: false,
  taskId: null,
  raceTaskId: null,
  sentinelTaskId: null,
  claimCalls: 0,
  serverClaimReturns: [],
  competitorClaimedTaskId: null,
  idleDbBaseline: null,
  idleDbSnapshots: [],
  progressCalls: 0,
  completeCalls: 0,
  postCompleteCheck: false,
  toolSequence: [],
};

let db: Db | undefined;
let server: Server | undefined;
let worker: ReturnType<typeof createApp>["worker"] | undefined;
let child: ChildProcess | undefined;
let competitorClient: Client | undefined;
let childOutput = "";
let taskDone = false;
let resolvePass: (() => void) | undefined;
let rejectRun: ((error: Error) => void) | undefined;
const checkToolIds = new Set<string>();

function toolContent(message: unknown): Array<Record<string, unknown>> {
  if (!message || typeof message !== "object") return [];
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) ? (content.filter((item) => item && typeof item === "object") as Array<Record<string, unknown>>) : [];
}

function parsesAsEmptyAvailability(value: unknown): boolean {
  if (typeof value === "string") {
    try {
      return parsesAsEmptyAvailability(JSON.parse(value));
    } catch {
      return false;
    }
  }
  if (Array.isArray(value)) return value.some(parsesAsEmptyAvailability);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.available_count === 0) return true;
    return parsesAsEmptyAvailability(record.text) || parsesAsEmptyAvailability(record.content);
  }
  return false;
}

function tokenUsage(message: unknown): number {
  if (!message || typeof message !== "object") return 0;
  const usage = (message as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return 0;
  return Object.entries(usage as Record<string, unknown>)
    .filter(([key, value]) => key.endsWith("_tokens") && typeof value === "number")
    .reduce((sum, [, value]) => sum + (value as number), 0);
}

async function submitFixture(): Promise<void> {
  if (state.taskId !== null || !worker) return;
  state.raceTaskId = await evalQueue.submit(
    "demo",
    "eval-human",
    {
      title: "Competing claim uniqueness probe",
      body: "The second eval coder claims this task; the primary coder must never receive it.",
      evidence: [],
    },
  );
  state.taskId = await evalQueue.submit(
    "demo",
    "eval-human",
    {
      title: "Complete the supervisor-less coder acceptance fixture",
      body: [
        "Exercise the memracer coder protocol without editing files.",
        "Propose a plan, report progress, then complete this task.",
        "Use PR URL https://github.com/recallnet/memracer/pull/1 and PR description:",
        '"Supervisor-less coder evaluation fixture; no repository changes required."',
        "Acceptance: coder_complete succeeds and the task reaches DONE.",
      ].join("\n"),
      evidence: [],
    },
  );
  process.stderr.write(`[eval] ${state.emptyReturns} idle checks observed with flat main thread; queued fixture task #${state.taskId}\n`);
}

async function idleDbSnapshot(): Promise<IdleDbSnapshot> {
  if (!db) throw new Error("database unavailable");
  return {
    tasks: await db.prepare(
      `SELECT id, state, lease_agent, lease_expires_at, plan_deadline, updated_at, queue_generation
       FROM tasks ORDER BY id`,
    ).all(),
    attempts: await db.prepare(
      "SELECT id, task_id, agent, outcome, notes, created_at FROM attempts ORDER BY id",
    ).all(),
    projects: await db.prepare(
      "SELECT id, claim_generation, last_active_lease_at FROM projects ORDER BY id",
    ).all(),
  };
}

function parseToolJson(result: unknown): unknown {
  const content = (result as { content?: unknown } | null)?.content as Array<{ type?: string; text?: string }> | undefined;
  const text = content?.find((item) => item.type === "text")?.text;
  return text === undefined ? undefined : JSON.parse(text);
}

let evalQueue: ReturnType<typeof createApp>["queue"];

async function observeEvent(event: Record<string, unknown>): Promise<void> {
  const message = event.message;
  if (event.type === "assistant") {
    state.assistantTurns += 1;
    state.usageTokens += tokenUsage(message);
  }
  for (const block of toolContent(message)) {
    if (block.type === "tool_use" && typeof block.name === "string" && typeof block.id === "string") {
      state.toolSequence.push(block.name);
      if (block.name.endsWith("coder_check_work")) {
        state.transcriptCheckCalls += 1;
        checkToolIds.add(block.id);
        if (state.emptyObserved) state.recheckAfterEmpty = true;
        if (taskDone) state.postCompleteCheck = true;
      }
      if (block.name.endsWith("coder_claim_task")) state.claimCalls += 1;
      if (block.name.endsWith("coder_progress")) state.progressCalls += 1;
      if (block.name.endsWith("coder_complete")) state.completeCalls += 1;
    }
    if (block.type === "tool_result" && typeof block.tool_use_id === "string" && checkToolIds.has(block.tool_use_id)) {
      checkToolIds.delete(block.tool_use_id);
      if (parsesAsEmptyAvailability(block.content)) {
        state.emptyObserved = true;
      }
    }
  }
  if (taskDone && state.postCompleteCheck) resolvePass?.();
}

async function taskState(): Promise<TaskState | null> {
  if (!db || state.taskId === null) return null;
  return (
    (await db
      .prepare("SELECT state, lease_agent, plan_approved_at FROM tasks WHERE id = ?")
      .get<TaskState>(state.taskId)) ?? null
  );
}

async function raceTaskState(): Promise<{ state: string; lease_agent: string | null } | null> {
  if (!db || state.raceTaskId === null) return null;
  return (
    (await db.prepare("SELECT state, lease_agent FROM tasks WHERE id = ?")
      .get<{ state: string; lease_agent: string | null }>(state.raceTaskId)) ?? null
  );
}

async function cleanup(): Promise<void> {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((resolve) => child!.once("exit", () => resolve()));
    child.kill("SIGTERM");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await competitorClient?.close().catch(() => undefined);
  worker?.stop();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  await db?.close();
  rmSync(tempDir, { recursive: true, force: true });
}

async function main(): Promise<void> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 30_000) throw new Error("BARE_CODER_EVAL_TIMEOUT_MS must be at least 30000");
  if (!Number.isFinite(evalWaitS) || evalWaitS <= 0) throw new Error("BARE_CODER_EVAL_WAIT_S must be positive");
  if (!Number.isInteger(requiredIdleCycles) || requiredIdleCycles < 3) {
    throw new Error("BARE_CODER_EVAL_IDLE_CYCLES must be an integer of at least 3");
  }
  if (!Number.isFinite(idlePollS) || idlePollS < 0) throw new Error("MEMRACER_IDLE_POLL_S must be nonnegative");
  db = openDb(":memory:");
  await db.prepare("INSERT INTO projects (id, name) VALUES ('demo', 'Demo')").run();
  await betterAuthReady(db);
  const coder = await seedMember(db, { name: "bare-coder", projectId: "demo", role: "coder" });
  const competitor = await seedMember(db, { name: "bare-competitor", projectId: "demo", role: "coder" });
  const made = createApp(db, { driverFor: () => new FakeDriver(), workerOpts: { tickMs: 20, jobTimeoutMs: 2_000 } });
  evalQueue = made.queue;
  state.sentinelTaskId = await evalQueue.submit(
    "demo",
    "eval-human",
    { title: "Idle purity sentinel", body: "Keep this live lease byte-stable during empty checks.", evidence: [] },
  );
  await evalQueue.claimNext("demo", "bare-competitor", DEFAULT_LEASE_TTL_MS);
  state.idleDbBaseline = await idleDbSnapshot();

  const claimNextAny = evalQueue.claimNextAny.bind(evalQueue);
  evalQueue.claimNextAny = async (projectIds, agent, ttlMs) => {
    const brief = await claimNextAny(projectIds, agent, ttlMs);
    state.serverClaimReturns.push({ agent, taskId: brief?.id ?? null });
    return brief;
  };
  const checkWorkAny = evalQueue.checkWorkAny.bind(evalQueue);
  evalQueue.checkWorkAny = async (projectIds, agent, _timeoutS, peekLimit) => {
    if (state.emptyObserved) state.recheckAfterEmpty = true;
    if (taskDone) state.postCompleteCheck = true;
    state.serverCheckStarts.push(Date.now());
    if (state.serverCheckStarts.length === 2) {
      state.idleBaseline = { turns: state.assistantTurns, tokens: state.usageTokens };
    }
    const availability = await checkWorkAny(projectIds, agent, evalWaitS, peekLimit);
    if (availability.available_count === 0) {
      state.emptyObserved = true;
      state.emptyReturns += 1;
      if (state.taskId === null) {
        state.idleDbSnapshots.push(await idleDbSnapshot());
        if (
          state.idleDbBaseline === null ||
          !idleSnapshotsUnchanged(state.idleDbBaseline, state.idleDbSnapshots)
        ) {
          rejectRun?.(new Error("coder_check_work mutated tasks, attempts, or project claim fields during idle"));
        }
      }
      if (state.emptyReturns >= requiredIdleCycles && state.taskId === null) {
        const starts = state.serverCheckStarts;
        const minimumGapMs = (evalWaitS + idlePollS) * 1_000 - 250;
        const offModelGaps = starts.slice(2).map((started, index) => started - starts[index + 1]);
        state.idleCadenceOk = offModelGaps.length > 0 && offModelGaps.every((gap) => gap >= minimumGapMs);
        state.idleTurnsFlat = state.idleBaseline !== null && state.assistantTurns === state.idleBaseline.turns;
        state.idleTokensFlat = state.idleBaseline !== null && state.usageTokens === state.idleBaseline.tokens;
        if (!state.idleTurnsFlat || !state.idleTokensFlat || !state.idleCadenceOk) {
          rejectRun?.(
            new Error(
              `idle loop crossed the model path: ${JSON.stringify({
                baseline: state.idleBaseline,
                turns: state.assistantTurns,
                tokens: state.usageTokens,
                starts,
                minimumGapMs,
              })}`,
            ),
          );
        } else {
          await submitFixture();
        }
      }
    } else if (state.competitorClaimedTaskId === null) {
      if (!competitorClient || state.raceTaskId === null) {
        throw new Error("positive availability arrived before the competing coder was ready");
      }
      const result = await competitorClient.callTool({ name: "coder_claim_task", arguments: {} });
      if (result.isError) throw new Error(`competing coder claim failed: ${JSON.stringify(result.content)}`);
      const claimed = parseToolJson(result) as { id?: number } | null;
      state.competitorClaimedTaskId = claimed?.id ?? null;
      if (state.competitorClaimedTaskId !== state.raceTaskId) {
        throw new Error(
          `competing coder claimed ${state.competitorClaimedTaskId ?? "null"}; expected race task ${state.raceTaskId}`,
        );
      }
    }
    return availability;
  };
  worker = made.worker;
  server = made.app.listen(0);
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  competitorClient = new Client({ name: "bare-coder-eval-competitor", version: "0.0.1" });
  await competitorClient.connect(
    new StreamableHTTPClientTransport(new URL(baseUrl), {
      requestInit: { headers: { Authorization: `Bearer ${competitor.token}` } },
    }),
  );
  const mcpConfig = path.join(tempDir, "mcp.json");
  writeFileSync(
    mcpConfig,
    JSON.stringify({
      mcpServers: {
        memracer: { type: "http", url: baseUrl, headers: { Authorization: `Bearer ${coder.token}` } },
      },
    }),
  );

  const args = [
    "-p",
    "Begin.",
    "--mcp-config",
    mcpConfig,
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--disable-slash-commands",
    "--allowedTools",
    "Bash,mcp__memracer__*",
    "--permission-mode",
    "bypassPermissions",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
  ];
  if (process.env.BARE_CODER_EVAL_MODEL) args.push("--model", process.env.BARE_CODER_EVAL_MODEL);
  const agentVersion = execFileSync(claudeCmd, ["--version"], { encoding: "utf8" }).trim();

  const pass = new Promise<void>((resolve, reject) => {
    resolvePass = resolve;
    rejectRun = reject;
  });
  child = spawn(claudeCmd, args, {
    cwd: tempDir,
    env: {
      ...process.env,
      MEMRACER_URL: baseUrl,
      MEMRACER_TOKEN: coder.token,
      MEMRACER_IDLE_POLL_S: String(idlePollS),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    childOutput += chunk.toString();
    process.stderr.write(chunk);
  });
  let buffer = "";
  child.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      childOutput += `${line}\n`;
      try {
        void observeEvent(JSON.parse(line) as Record<string, unknown>).catch((error) => rejectRun?.(error));
      } catch {
        // Non-JSON diagnostics are retained for failure output but do not grade the run.
      }
    }
  });
  child.once("exit", (code, signal) => {
    if (!taskDone || !state.postCompleteCheck) rejectRun?.(new Error(`agent exited before acceptance (code=${code}, signal=${signal})`));
  });

  const monitor = setInterval(() => {
    void taskState()
      .then((row) => {
        taskDone = row?.state === "DONE";
        if (taskDone && state.postCompleteCheck) resolvePass?.();
      })
      .catch((error) => rejectRun?.(error));
  }, 100);
  const timeout = setTimeout(() => rejectRun?.(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);

  try {
    await pass;
  } finally {
    clearInterval(monitor);
    clearTimeout(timeout);
  }

  const row = await taskState();
  const raceRow = await raceTaskState();
  const idleDbPure =
    state.idleDbBaseline !== null &&
    state.idleDbSnapshots.length >= requiredIdleCycles &&
    idleSnapshotsUnchanged(state.idleDbBaseline, state.idleDbSnapshots);
  const uniqueClaimSplit =
    state.raceTaskId !== null &&
    state.taskId !== null &&
    hasUniqueCompetingClaimSplit({
      claims: state.serverClaimReturns,
      primaryAgent: "bare-coder",
      competitorAgent: "bare-competitor",
      raceTaskId: state.raceTaskId,
      lifecycleTaskId: state.taskId,
    });
  const passed =
    state.emptyObserved &&
    state.recheckAfterEmpty &&
    state.emptyReturns >= requiredIdleCycles &&
    state.idleTurnsFlat &&
    state.idleTokensFlat &&
    state.idleCadenceOk &&
    idleDbPure &&
    state.claimCalls > 0 &&
    uniqueClaimSplit &&
    raceRow?.state === "CLAIMED" &&
    raceRow.lease_agent === "bare-competitor" &&
    state.progressCalls > 0 &&
    state.completeCalls > 0 &&
    state.postCompleteCheck &&
    row?.state === "DONE" &&
    row.plan_approved_at !== null;
  const result = {
    passed,
    agent: agentVersion,
    prompt: "Begin.",
    supervisor: false,
    empty_observed: state.emptyObserved,
    transcript_check_calls: state.transcriptCheckCalls,
    server_check_calls: state.serverCheckStarts.length,
    empty_returns: state.emptyReturns,
    server_check_starts: state.serverCheckStarts,
    idle_baseline: state.idleBaseline,
    assistant_turns: state.assistantTurns,
    usage_tokens: state.usageTokens,
    idle_turns_flat: state.idleTurnsFlat,
    idle_tokens_flat: state.idleTokensFlat,
    idle_cadence_ok: state.idleCadenceOk,
    idle_db_pure: idleDbPure,
    idle_db_snapshots_checked: state.idleDbSnapshots.length,
    recheck_after_empty: state.recheckAfterEmpty,
    sentinel_task_id: state.sentinelTaskId,
    race_task_id: state.raceTaskId,
    race_task_state: raceRow?.state,
    race_task_owner: raceRow?.lease_agent,
    competitor_claimed_task_id: state.competitorClaimedTaskId,
    unique_claim_split: uniqueClaimSplit,
    server_claim_returns: state.serverClaimReturns,
    task_id: state.taskId,
    task_state: row?.state,
    plan_approved: row?.plan_approved_at != null,
    coder_claim_calls: state.claimCalls,
    coder_progress_calls: state.progressCalls,
    coder_complete_calls: state.completeCalls,
    returned_to_check_after_complete: state.postCompleteCheck,
    tool_sequence: state.toolSequence,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!passed) throw new Error(`bare-coder outcome grader failed: ${JSON.stringify(result)}`);
}

main()
  .catch((error) => {
    const tail = childOutput.slice(-16_000).replaceAll(/Bearer [A-Za-z0-9._-]+/g, "Bearer [REDACTED]");
    process.stderr.write(`[eval] FAILED: ${error instanceof Error ? error.message : String(error)}\n${tail}\n`);
    process.exitCode = 1;
  })
  .finally(cleanup);
