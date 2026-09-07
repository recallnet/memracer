// human-kit SessionStart hook: pull human_status, surface it as session
// context, and deliver each durable attention episode to this desktop once.

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function parseRpcResponse(contentType, body) {
  if (contentType.includes("text/event-stream")) {
    for (const line of body.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const message = JSON.parse(line.slice(5).trim());
      if (message.result || message.error) return message;
    }
    throw new Error("no JSON-RPC result in SSE response");
  }
  return JSON.parse(body);
}

export async function fetchHumanStatus(url, token, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "human_status", arguments: {} },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`human_status HTTP ${response.status}`);
  const rpc = parseRpcResponse(response.headers.get("content-type") ?? "", await response.text());
  if (rpc.error) throw new Error(`human_status JSON-RPC ${rpc.error.code ?? "error"}`);
  return JSON.parse(rpc.result.content[0].text);
}

function statePath(env = process.env) {
  return env.MEMRACER_ALERT_STATE_FILE || path.join(homedir(), ".cache", "memracer", "human-attention-seen.json");
}

export function readSeen(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return new Set(Array.isArray(parsed.episode_ids) ? parsed.episode_ids.filter((id) => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

export function writeSeen(file, seen) {
  mkdirSync(path.dirname(file), { recursive: true });
  const ids = [...seen].slice(-500);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ episode_ids: ids }, null, 2), { mode: 0o600 });
  renameSync(temporary, file);
}

export function notificationText(alert) {
  const scope = alert.task_id == null ? "Project" : `#${alert.task_id}`;
  return `[${alert.project}] ${scope} ${alert.title}. ${alert.reason} ${alert.recovery}`;
}

function notificationEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("MEMRACER_")));
}

function terminalNotifierPath(env) {
  if (env.MEMRACER_TERMINAL_NOTIFIER && path.isAbsolute(env.MEMRACER_TERMINAL_NOTIFIER)) {
    return env.MEMRACER_TERMINAL_NOTIFIER;
  }
  return ["/opt/homebrew/bin/terminal-notifier", "/usr/local/bin/terminal-notifier"].find(existsSync) ?? null;
}

export function notifyDesktop(
  alert,
  run = spawnSync,
  platform = process.platform,
  env = process.env,
) {
  if (platform !== "darwin") return false;
  const message = notificationText(alert);
  const target = alert.dashboard_url || alert.task_uri;
  const childOptions = { encoding: "utf8", env: notificationEnv(env), timeout: 10_000 };
  const notifier = terminalNotifierPath(env);
  if (notifier) {
    const terminal = run(
      notifier,
      ["-title", "memracer needs attention", "-message", message, ...(target ? ["-open", target] : []), "-group", `memracer-${alert.episode_id}`],
      childOptions,
    );
    if (!terminal.error && terminal.status === 0) return true;
  }

  // macOS ships osascript. Its notification is not link-aware, so the task
  // pointer stays in the injected context; terminal-notifier is the clickable
  // path and is recommended by the kit README.
  const fallback = run(
    "/usr/bin/osascript",
    [
      "-e",
      "on run argv",
      "-e",
      "display notification (item 2 of argv) with title (item 1 of argv)",
      "-e",
      "end run",
      "memracer needs attention",
      message,
    ],
    childOptions,
  );
  return !fallback.error && fallback.status === 0;
}

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5_000;

/** Serialize read→notify→write across concurrent SessionStart processes. */
export async function acquireStateLock(file, now = () => Date.now()) {
  const lock = `${file}.lock`;
  mkdirSync(path.dirname(file), { recursive: true });
  const deadline = now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, created_at: now() }));
      closeSync(fd);
      return () => {
        try {
          unlinkSync(lock);
        } catch {
          // Another process recovered an already-stale lock; nothing remains.
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        if (now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lock);
          continue;
        }
      } catch {
        continue;
      }
      if (now() >= deadline) throw new Error("timed out waiting for local attention-delivery lock");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

export function renderContext(status) {
  const alerts = status.attention_alerts ?? [];
  const lines = ["memracer SessionStart status (fresh pull):"];
  if (alerts.length > 0) {
    lines.push("", "ATTENTION — open human-directed items:");
    for (const alert of alerts) {
      const scope = alert.task_id == null ? "Project" : `#${alert.task_id}`;
      lines.push(
        `- [${alert.project}] ${scope} ${alert.title}; ${alert.reason}`,
        `  Recovery: ${alert.recovery}`,
        ...(alert.dashboard_url || alert.task_uri ? [`  Open: ${alert.dashboard_url || alert.task_uri}`] : []),
      );
    }
  }
  lines.push("", `Full human_status result: ${JSON.stringify(status)}`);
  return lines.join("\n");
}

export async function runHook({
  env = process.env,
  fetchImpl = fetch,
  run = spawnSync,
  platform = process.platform,
  input = process.stdin,
} = {}) {
  // Drain hook input even though SessionStart fields are not needed.
  for await (const _chunk of input) {
    // discard
  }
  const url = env.MEMRACER_URL;
  const token = env.MEMRACER_TOKEN;
  if (!url || !token) return null;

  const status = await fetchHumanStatus(url, token, fetchImpl);
  const output = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: renderContext(status),
    },
  };
  const file = statePath(env);
  let release;
  try {
    release = await acquireStateLock(file);
  } catch (error) {
    console.error(`memracer attention delivery skipped; session continues: ${error instanceof Error ? error.message : String(error)}`);
    return output;
  }
  try {
    const seen = readSeen(file);
    let changed = false;
    for (const alert of status.attention_alerts ?? []) {
      if (seen.has(alert.episode_id)) continue;
      if (notifyDesktop(alert, run, platform, env)) {
        seen.add(alert.episode_id);
        changed = true;
      }
    }
    if (changed) writeSeen(file, seen);
  } finally {
    release();
  }
  return output;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const output = await runHook();
    if (output) process.stdout.write(JSON.stringify(output));
  } catch (error) {
    console.error(`memracer SessionStart status failed; continuing without it: ${error instanceof Error ? error.message : String(error)}`);
  }
}
