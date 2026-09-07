import type { Command } from "commander";
import { queueDepth } from "../api.js";
import { CredentialStore } from "../credentials.js";
import { readSeatEnv } from "../seat-env.js";
import { readEventStream } from "../sse.js";

/** The connection + defaults `memracer wait` blocks against. */
export interface WaitContext {
  baseUrl: string;
  token: string;
  project?: string;
  role?: string;
}

/**
 * The result of blocking on the stream: the server pushed a fresh claimable
 * count (`available`), or the caller must re-check over HTTP ("recheck" — an old
 * server that doesn't push counts, a dropped connection, or the wait cap).
 */
export type Wake = { available: number } | "recheck";

export interface WaitDeps {
  /** The seat env (inside a seat folder) or the operator credential; null if neither. */
  context: () => WaitContext | null;
  queueDepth: (baseUrl: string, token: string, project: string, role: string) => Promise<number>;
  /**
   * Block on the project stream until the server pushes a claimable count, tells
   * us to re-check, drops, or `maxWaitMs` elapses. Never rejects — this is the
   * push wait, and the model burns nothing while it blocks here.
   */
  awaitChange: (eventsUrl: string, token: string, maxWaitMs: number) => Promise<Wake>;
  now: () => number;
  log: (msg: string) => void;
}

export interface WaitOpts {
  project?: string;
  role?: string;
  /** Timeout in seconds; 0 (default) waits forever. */
  timeout?: number;
  /** Single depth check, no stream. */
  once?: boolean;
}

/** Cap on a single SSE connection before a defensive reconnect (not a poll — the push is the wake). */
const DEFAULT_MAX_WAIT_MS = 15 * 60 * 1000;

/**
 * Block cheaply until a seat's role has claimable work, then exit 0. This is the
 * zero-token PUSH waiter: it subscribes to the project's Server-Sent Events
 * stream with its role, and the server pushes the claimable count in-band — on
 * connect and on every change — so a parked coder makes no requests at all and
 * the model stays asleep. The server's reclaim sweep emits a change for every
 * transition into claimability (including expired leases), so no work is missed
 * without a poll loop. Against an older server that does not push counts, it
 * falls back to one cheap depth check per change. Returns the process exit code.
 */
export async function runWait(opts: WaitOpts, deps: WaitDeps): Promise<number> {
  const ctx = deps.context();
  if (!ctx) {
    throw new Error(
      "Not logged in and no seat env found — run `memracer login`, or run inside a seat folder.",
    );
  }
  const project = opts.project ?? ctx.project;
  if (!project) {
    throw new Error("--project <id> is required (no seat project in context).");
  }
  const role = opts.role ?? ctx.role ?? "coder";
  const timeoutS = opts.timeout ?? 0;
  const deadline = timeoutS > 0 ? deps.now() + timeoutS * 1000 : null;
  const eventsUrl = `${ctx.baseUrl}/api/p/${encodeURIComponent(project)}/events?role=${encodeURIComponent(role)}`;

  const claimable = async (): Promise<boolean> => {
    const available = await deps.queueDepth(ctx.baseUrl, ctx.token, project, role);
    if (available > 0) {
      deps.log(`work available: ${available}`);
      return true;
    }
    return false;
  };

  // Catch work already queued before we subscribed (also the --once path and the
  // fallback for a server that doesn't push counts), then (for --once) stop.
  if (await claimable()) return 0;
  if (opts.once) {
    deps.log("work available: 0");
    return 1;
  }

  for (;;) {
    if (deadline !== null && deps.now() >= deadline) {
      deps.log(`no work within ${timeoutS}s`);
      return 1;
    }
    const maxWaitMs = deadline !== null ? Math.max(0, deadline - deps.now()) : DEFAULT_MAX_WAIT_MS;
    const wake = await deps.awaitChange(eventsUrl, ctx.token, maxWaitMs);
    if (wake === "recheck") {
      if (await claimable()) return 0;
    } else if (wake.available > 0) {
      deps.log(`work available: ${wake.available}`);
      return 0;
    }
    // wake.available === 0 → a fresh snapshot said no work; keep waiting.
  }
}

/** Resolve the waiter context: prefer the seat env, fall back to the operator credential. */
function resolveContext(): WaitContext | null {
  const seat = readSeatEnv(process.cwd());
  if (seat) return { baseUrl: seat.baseUrl, token: seat.token, project: seat.project, role: seat.role };
  const credential = new CredentialStore().load();
  if (credential) return { baseUrl: credential.baseUrl, token: credential.token };
  return null;
}

/** The `available` count from a `queue` frame's data, or 0 if it can't be parsed. */
export function parseAvailable(data: string): number {
  try {
    const n = (JSON.parse(data) as { available?: number }).available;
    return typeof n === "number" ? n : 0;
  } catch {
    return 0;
  }
}

/** Reconnect no more than this often when the stream errors or the server closes it. */
const RECONNECT_MIN_MS = 2_000;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The production push wait: hold ONE SSE connection open and process frames on
 * it. A `queue` frame carries the claimable count — a positive one resolves with
 * the work in hand (no follow-up request); a zero one keeps waiting on the same
 * connection. A bare `changed` from a server that never pushes counts falls back
 * to an HTTP re-check. The wait cap, a drop, or a close resolve "recheck",
 * rate-limited to RECONNECT_MIN_MS so a flapping server can't spin.
 */
async function awaitChange(eventsUrl: string, token: string, maxWaitMs: number): Promise<Wake> {
  const start = Date.now();
  const controller = new AbortController();
  let outcome: Wake | null = null;
  let sawQueue = false;
  const timer = setTimeout(() => controller.abort(), maxWaitMs);
  try {
    await readEventStream(
      eventsUrl,
      token,
      (frame) => {
        if (frame.event === "queue") {
          sawQueue = true;
          const available = parseAvailable(frame.data);
          if (available > 0) {
            outcome = { available };
            controller.abort();
          }
          // available === 0 → stay on this connection and wait for the next frame.
        } else if (frame.event === "changed" && !sawQueue) {
          // Older server that doesn't push counts — go re-check over HTTP.
          outcome = "recheck";
          controller.abort();
        }
      },
      { signal: controller.signal },
    );
  } catch {
    // Our own abort (work/timeout) or a dropped connection — fall through.
  } finally {
    clearTimeout(timer);
  }
  if (outcome) return outcome;
  const elapsed = Date.now() - start;
  if (elapsed < RECONNECT_MIN_MS) await sleep(RECONNECT_MIN_MS - elapsed);
  return "recheck";
}

export function registerWait(program: Command): void {
  program
    .command("wait")
    .description("Block until the seat's role has claimable work, then exit (zero model tokens)")
    .option("--project <id>", "project to watch (inferred from the seat env when omitted)")
    .option("--role <role>", "role whose queue to watch (default: coder)")
    .option("--timeout <sec>", "give up after N seconds (0 = wait forever)", (v) => Number(v), 0)
    .option("--once", "check once and exit instead of waiting for a push")
    .action(async (options: WaitOpts) => {
      const code = await runWait(options, {
        context: resolveContext,
        queueDepth: (b, t, p, r) => queueDepth(b, t, p, r),
        awaitChange,
        now: () => Date.now(),
        log: (m) => console.log(m),
      });
      process.exitCode = code;
    });
}
