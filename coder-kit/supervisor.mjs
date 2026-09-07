#!/usr/bin/env node
// coder-kit/supervisor.mjs — queue-drainer for a dev machine.
//
// Connects to the memracer server with a coder token and loops forever on
// coder_check_work (empty → fixed idle sleep → re-check inside this process),
// followed by an explicit coder_claim_task only when work is available.
// Empty cycles never enter a model session. Each claimed task normally gets
// one fresh coder session; if that session exits while its lease remains live,
// the supervisor starts a recovery session for the same task. Each session
// gets a per-task workdir, generated --mcp-config, kit settings (hooks), and
// its own output log. Prompt tasks have a maxTaskMinutes watchdog; structurally
// marked goal tasks stay alive while coder_progress renews the server lease.
// Lease expiry remains the stalled-goal reclaim signal.
//
// Usage: node coder-kit/supervisor.mjs [config.json]
//        (defaults to config.json next to this file; see config.example.json)
import { createWriteStream, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildTaskPrompt } from "./task-prompt.mjs";
import { isGoalTask } from "./goal-task.mjs";

const kitDir = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.resolve(process.argv[2] ?? path.join(kitDir, "config.json"));
const config = {
  claudeCmd: "claude",
  claudeArgs: [],
  maxTaskMinutes: 45,
  waitTimeoutS: 90,
  idlePollS: 600,
  goalLeasePollS: 30,
  ...JSON.parse(readFileSync(configPath, "utf8")),
};
const settingsPath = path.join(kitDir, "settings.json"); // hooks (Part B)
const idlePollS = Number(config.idlePollS);
if (!Number.isFinite(idlePollS) || idlePollS < 0) {
  throw new Error("idlePollS must be a finite nonnegative number");
}
const goalLeasePollS = Number(config.goalLeasePollS);
if (!Number.isFinite(goalLeasePollS) || goalLeasePollS <= 0) {
  throw new Error("goalLeasePollS must be a finite positive number");
}

function log(msg) {
  console.log(`[supervisor] ${new Date().toISOString()} ${msg}`);
}

let child = null;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log(`${sig} — shutting down${child ? `; killing session pid=${child.pid}` : ""}`);
    if (child) child.kill("SIGKILL");
    process.exit(0);
  });
}

const client = new Client({ name: `memracer-supervisor/${config.agentName}`, version: "0.0.1" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(config.serverUrl), {
    requestInit: { headers: { Authorization: `Bearer ${config.token}` } },
  }),
);
log(`connected to ${config.serverUrl} as ${config.agentName}`);

async function call(name, args, timeoutMs = 60_000) {
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
  if (res.isError) throw new Error(`${name} failed: ${res.content?.[0]?.text}`);
  return JSON.parse(res.content[0].text);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTaskSession(brief) {
  const workdir = mkdtempSync(path.join(tmpdir(), `memracer-task-${brief.id}-`));
  const briefFile = path.join(workdir, ".memracer-task.json");
  writeFileSync(briefFile, JSON.stringify(brief, null, 2));
  const mcpConfigFile = path.join(workdir, "mcp-config.json");
  writeFileSync(
    mcpConfigFile,
    JSON.stringify(
      {
        mcpServers: {
          memracer: {
            type: "http",
            url: config.serverUrl,
            headers: { Authorization: `Bearer ${config.token}` },
          },
        },
      },
      null,
      2,
    ),
  );
  const logFile = path.join(workdir, "session.log");
  const out = createWriteStream(logFile);

  child = spawn(
    config.claudeCmd,
    [...config.claudeArgs, "-p", buildTaskPrompt(brief), "--mcp-config", mcpConfigFile, "--settings", settingsPath],
    {
      cwd: config.targetRepo,
      env: {
        ...process.env,
        MEMRACER_URL: config.serverUrl,
        MEMRACER_TOKEN: config.token,
        MEMRACER_TASK_FILE: briefFile,
        MEMRACER_TASK_ID: String(brief.id),
        // settings.json hook commands resolve through this, so the kit works
        // even when it lives outside the target repo ($CLAUDE_PROJECT_DIR).
        MEMRACER_KIT_DIR: kitDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  log(`spawned session pid=${child.pid} for task ${brief.id}; log: ${logFile}`);

  let killedByWatchdog = false;
  let killedByLeaseLoss = false;
  const session = child;
  const sessionExit = new Promise((resolve) => session.once("exit", (c, s) => resolve(c ?? `signal ${s}`)));
  const goalTask = isGoalTask(brief);
  const watchdog = goalTask
    ? null
    : setTimeout(() => {
        killedByWatchdog = true;
        log(`watchdog: task ${brief.id} exceeded ${config.maxTaskMinutes} min — killing session pid=${session.pid}`);
        session.kill("SIGKILL");
      }, config.maxTaskMinutes * 60_000);
  if (goalTask) log(`goal task ${brief.id}: static task-duration watchdog exempt; lease expiry detects stalls`);

  let code;
  if (!goalTask) {
    code = await sessionExit;
  } else {
    for (;;) {
      const outcome = await Promise.race([
        sessionExit.then((exitCode) => ({ kind: "exit", exitCode })),
        sleep(goalLeasePollS * 1000).then(() => ({ kind: "poll" })),
      ]);
      if (outcome.kind === "exit") {
        code = outcome.exitCode;
        break;
      }
      try {
        const heartbeat = await call("coder_heartbeat", {});
        if (!heartbeat.live_leases.some((lease) => lease.task_id === brief.id)) {
          killedByLeaseLoss = true;
          log(`goal task ${brief.id}: lease no longer live — killing stale session pid=${session.pid}`);
          session.kill("SIGKILL");
          code = await sessionExit;
          break;
        }
      } catch (err) {
        // A transient status failure must not kill valid work. The next poll
        // retries; coder_heartbeat is informational and never renews a lease.
        log(`goal task ${brief.id}: lease status check failed — ${(err instanceof Error ? err.message : String(err))}`);
      }
    }
  }
  if (watchdog) clearTimeout(watchdog);
  child = null;

  const heartbeat = await call("coder_heartbeat", {});
  const stillLeased = heartbeat.live_leases.some((l) => l.task_id === brief.id);
  log(
    `session for task ${brief.id} exited (${code})${killedByWatchdog ? " — killed by watchdog" : ""}${killedByLeaseLoss ? " — killed after lease loss" : ""}; ` +
      `lease ${stillLeased ? "still live" : "released"}`,
  );
  return { stillLeased, killedByWatchdog, killedByLeaseLoss };
}

async function runTask(brief) {
  for (;;) {
    const outcome = await runTaskSession(brief);
    if (!outcome.stillLeased) return;
    if (outcome.killedByWatchdog || outcome.killedByLeaseLoss) {
      log(`task ${brief.id} session ended by supervisor; server-side expiry will requeue any live lease`);
      return;
    }
    log(`task ${brief.id} remains leased after session exit — starting a recovery session`);
    await sleep(1000);
  }
}

const timeoutS = Math.max(1, Math.min(90, Math.floor(config.waitTimeoutS)));
for (;;) {
  const availability = await call("coder_check_work", { timeout_s: timeoutS }, (timeoutS + 30) * 1000);
  if (availability.available_count === 0) {
    log(`no work — sleeping ${idlePollS}s before re-poll`);
    await sleep(idlePollS * 1000);
    continue;
  }
  const brief = await call("coder_claim_task", {});
  if (brief === null) {
    log("work was claimed by another coder — resuming availability check");
    continue;
  }
  log(`claimed task ${brief.id}: ${brief.title}`);
  await runTask(brief);
}
