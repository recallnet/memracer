// Trajectory-level eval: drives multi-step orchestrator scenarios through the
// REAL Queue + MediatorWorker + FakeDriver, extracts the ordered action
// trajectory (decision kinds) plus the primary task's state path, and asserts
// against golden references (agentevals trajectory match) AND a deterministic
// FSM reachability check. The isolation eval (run.ts) scores single driver
// calls; the pipeline eval (pipeline.ts) scores single-pipeline DB outcomes;
// neither validates a multi-step run as a whole — the class of bug that
// produced the #75 park-loop. This suite closes that gap, fully offline.
import { createTrajectoryMatchEvaluator } from "agentevals";
import { openDb } from "../db.js";
import { Queue, DEFAULT_LEASE_TTL_MS } from "../queue.js";
import { MediatorWorker } from "../mediator/worker.js";
import { registerPipelines } from "../mediator/pipelines.js";
import type { MediatorDriver } from "../mediator/driver.js";

const JOB_WAIT_MS = 30_000;

interface Harness {
  db: ReturnType<typeof openDb>;
  queue: Queue;
  worker: MediatorWorker;
}

/** Fresh in-memory db + queue + worker wired through the real pipelines. */
async function withHarness<T>(driver: MediatorDriver, fn: (h: Harness) => Promise<T>): Promise<T> {
  const db = openDb(":memory:");
  await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
  const queue = new Queue(db);
  const worker = new MediatorWorker(db, { tickMs: 20, jobTimeoutMs: JOB_WAIT_MS });
  registerPipelines({ db, queue, worker, driverFor: () => driver });
  worker.start();
  try {
    return await fn({ db, queue, worker });
  } finally {
    worker.stop();
  }
}

/** The ordered action trajectory: decision kinds in the order they were logged. */
async function decisionKinds(db: Harness["db"]): Promise<string[]> {
  return (await db.prepare("SELECT kind FROM decision_log ORDER BY id").all<{ kind: string }>()).map((r) => r.kind);
}

// ── agentevals adapter ──────────────────────────────────────────────────────
// The only place agentevals is referenced: a decision-kind sequence is shaped
// as OpenAI assistant tool-call messages (one call per kind), then matched
// against a golden reference. Keeping this behind one function makes the
// library a one-file swap.

export type MatchMode = "strict" | "unordered" | "subset";

interface ChatMessageLike {
  role: "assistant";
  content: string;
  tool_calls: { id: string; type: "function"; function: { name: string; arguments: string } }[];
}

function toToolCallMessages(kinds: string[]): ChatMessageLike[] {
  return kinds.map((kind, i) => ({
    role: "assistant",
    content: "",
    tool_calls: [{ id: `call_${i}`, type: "function", function: { name: kind, arguments: "{}" } }],
  }));
}

export async function matchTrajectory(
  actualKinds: string[],
  expectedKinds: string[],
  mode: MatchMode,
): Promise<{ ok: boolean; comment: string }> {
  const evaluator = createTrajectoryMatchEvaluator({
    trajectoryMatchMode: mode,
    toolArgsMatchMode: "ignore",
  });
  const result = await evaluator({
    // agentevals types its inputs as chat-completion messages; the tool-call
    // shape above is structurally what it matches on, cast at this one boundary.
    outputs: toToolCallMessages(actualKinds) as never,
    referenceOutputs: toToolCallMessages(expectedKinds) as never,
  });
  const ok = result.score === true;
  return {
    ok,
    comment: ok
      ? `trajectory ${mode}-matches [${expectedKinds.join(", ")}]`
      : `trajectory mismatch (${mode}): expected [${expectedKinds.join(", ")}], got [${actualKinds.join(", ")}]`,
  };
}

// ── FSM reachability check ──────────────────────────────────────────────────
// Decision kinds and task states the orchestrator is allowed to produce, plus
// the legal state-transition edges drawn from queue.ts. A trajectory whose
// action kinds or state path leave these sets is rejected deterministically —
// this catches an illegal transition (e.g. QUEUED->DONE skipping CLAIMED) that
// a plain golden-sequence match would not.

export const LEGAL_KINDS = new Set([
  "create", "merge", "clarify", "priority", "approve", "revise",
  "answer", "escalate", "close", "update", "hold", "reopen",
]);

export const LEGAL_STATES = new Set([
  "INCUBATING", "QUEUED", "CLAIMED", "PLANNED", "EXECUTING", "AWAITING_MERGE", "DONE", "BLOCKED", "PARKED", "HELD",
]);

// from -> set of legal next states (self-loops are always allowed and not listed).
export const LEGAL_EDGES: Record<string, Set<string>> = {
  INCUBATING: new Set(["QUEUED"]),                       // seal groom graduates it
  QUEUED: new Set(["CLAIMED", "BLOCKED", "HELD"]),       // claimNext / groom clarification / hold
  CLAIMED: new Set(["EXECUTING", "PLANNED", "DONE", "AWAITING_MERGE", "BLOCKED", "PARKED", "QUEUED"]),
  EXECUTING: new Set(["PLANNED", "DONE", "AWAITING_MERGE", "BLOCKED", "PARKED", "QUEUED"]),
  PLANNED: new Set(["EXECUTING", "DONE", "AWAITING_MERGE", "PARKED", "QUEUED"]),
  AWAITING_MERGE: new Set(["DONE"]),                     // poller promotes merged-green
  BLOCKED: new Set(["QUEUED"]),                          // reopen
  PARKED: new Set(["QUEUED"]),                           // reopen
  HELD: new Set(["QUEUED"]),                             // reopen
  DONE: new Set(),                                       // terminal
};

export function checkFsm(kinds: string[], statePath: string[]): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  for (const k of kinds) {
    if (!LEGAL_KINDS.has(k)) failures.push(`illegal decision kind "${k}" (not in FSM legal set)`);
  }
  for (const s of statePath) {
    if (!LEGAL_STATES.has(s)) failures.push(`illegal state "${s}" (not in FSM legal set)`);
  }
  for (let i = 1; i < statePath.length; i++) {
    const from = statePath[i - 1]!;
    const to = statePath[i]!;
    if (from === to) continue; // self-loop: an unchanged step, always fine
    if (!LEGAL_STATES.has(from) || !LEGAL_STATES.has(to)) continue; // already flagged above
    if (!LEGAL_EDGES[from]?.has(to)) {
      failures.push(`illegal FSM transition ${from} -> ${to} (unreachable per queue.ts edges)`);
    }
  }
  return { ok: failures.length === 0, failures };
}

// ── scenarios ────────────────────────────────────────────────────────────────

export interface TrajectoryScenario {
  name: string;
  /** Match mode for the golden action-sequence comparison. */
  matchMode: MatchMode;
  /** Golden reference action trajectory (ordered decision kinds). */
  expectedKinds: string[];
  /**
   * Negative control: the scenario is expected to VIOLATE its golden trajectory
   * or FSM. The eval passes for a negative scenario only when the violation is
   * correctly detected (per-case ok = !passed).
   */
  negative?: boolean;
  /** Drives the scripted steps and returns the observed action trajectory + state path. */
  exec: (driver: MediatorDriver) => Promise<{ kinds: string[]; statePath: string[] }>;
}

/** Enqueue a groom job for a fresh submission and wait for it to finish. */
async function groom(h: Harness, id: number, submittedBy: string): Promise<void> {
  await h.worker.waitForJob(await h.worker.enqueue("p", "groom", { taskId: id, submittedBy }), JOB_WAIT_MS);
}

async function stateOf(queue: Queue, id: number): Promise<string> {
  return (await queue.brief(id)).state;
}

export const trajectoryScenarios: TrajectoryScenario[] = [
  {
    name: "accept",
    matchMode: "strict",
    expectedKinds: ["create"],
    exec: (driver) =>
      withHarness(driver, async (h) => {
        const id = await h.queue.submit("p", "dana", { title: "raw idea", body: "plain body", evidence: [] });
        const statePath = [await stateOf(h.queue, id)];
        await groom(h, id, "dana");
        statePath.push(await stateOf(h.queue, id));
        return { kinds: await decisionKinds(h.db), statePath };
      }),
  },
  {
    name: "merge",
    matchMode: "strict",
    expectedKinds: ["merge"],
    exec: (driver) =>
      withHarness(driver, async (h) => {
        const title = "Rate limit public API requests";
        const body = "Add a limiter for public API requests with a shared quota.";
        const target = await h.queue.submit("p", "dana", { title, body, evidence: [] });
        const dup = await h.queue.submit("p", "rui", {
          title,
          body: `Outcome: ${body}`,
          evidence: [],
        });
        const statePath = [await stateOf(h.queue, dup)];
        await groom(h, dup, "rui");
        // dup is dropped by the merge; the surviving target stays QUEUED.
        statePath.push(await stateOf(h.queue, target));
        return { kinds: await decisionKinds(h.db), statePath };
      }),
  },
  {
    name: "clarify-then-answer-then-accept",
    matchMode: "strict",
    expectedKinds: ["clarify", "create"],
    exec: (driver) =>
      withHarness(driver, async (h) => {
        const id = await h.queue.submit("p", "dana", {
          title: "vague ask",
          body: "CLARIFY: Which region should host it? Recommended: eu-west-1 — it matches the current deployment.",
          evidence: [],
        });
        const statePath = [await stateOf(h.queue, id)];
        await groom(h, id, "dana"); // -> clarify, opens a mediator question
        statePath.push(await stateOf(h.queue, id));
        const pending = await h.queue.pendingMediatorQuestion(id);
        await h.queue.answerQuestion(pending!.id, "eu-west-1", "dana");
        await groom(h, id, "dana"); // re-groom sees the Q&A -> accept (create)
        statePath.push(await stateOf(h.queue, id));
        return { kinds: await decisionKinds(h.db), statePath };
      }),
  },
  {
    name: "review-approve",
    matchMode: "strict",
    expectedKinds: ["approve"],
    exec: (driver) =>
      withHarness(driver, async (h) => {
        const id = await h.queue.submit("p", "dana", { title: "t", body: "b", evidence: [] });
        const statePath = [await stateOf(h.queue, id)];
        await h.queue.claimNext("p", "cc-1", DEFAULT_LEASE_TTL_MS);
        statePath.push(await stateOf(h.queue, id));
        await h.worker.waitForJob(
          await h.worker.enqueue("p", "review", { taskId: id, plan: "1. failing test. 2. fix. 3. run the suite.", agent: "cc-1" }),
          JOB_WAIT_MS,
        );
        statePath.push(await stateOf(h.queue, id));
        return { kinds: await decisionKinds(h.db), statePath };
      }),
  },
  {
    name: "review-revise-stays-CLAIMED",
    matchMode: "strict",
    expectedKinds: ["revise"],
    exec: (driver) =>
      withHarness(driver, async (h) => {
        const id = await h.queue.submit("p", "dana", { title: "t", body: "b", evidence: [] });
        const statePath = [await stateOf(h.queue, id)];
        await h.queue.claimNext("p", "cc-1", DEFAULT_LEASE_TTL_MS);
        statePath.push(await stateOf(h.queue, id));
        await h.worker.waitForJob(
          await h.worker.enqueue("p", "review", { taskId: id, plan: "a bad plan", agent: "cc-1" }),
          JOB_WAIT_MS,
        );
        statePath.push(await stateOf(h.queue, id)); // must stay CLAIMED
        return { kinds: await decisionKinds(h.db), statePath };
      }),
  },
  {
    name: "answer-escalate",
    matchMode: "strict",
    expectedKinds: ["escalate"],
    exec: (driver) =>
      withHarness(driver, async (h) => {
        const id = await h.queue.submit("p", "dana", { title: "t", body: "b", evidence: [] });
        const statePath = [await stateOf(h.queue, id)];
        await h.queue.claimNext("p", "cc-1", DEFAULT_LEASE_TTL_MS);
        statePath.push(await stateOf(h.queue, id));
        await h.worker.waitForJob(
          await h.worker.enqueue("p", "answer", { taskId: id, question: "please escalate this to the humans", agent: "cc-1" }),
          JOB_WAIT_MS,
        );
        statePath.push(await stateOf(h.queue, id));
        return { kinds: await decisionKinds(h.db), statePath };
      }),
  },
  {
    name: "close-own-task",
    matchMode: "strict",
    expectedKinds: ["close", "answer"],
    exec: (driver) =>
      withHarness(driver, async (h) => {
        const id = await h.queue.submit("p", "dana", { title: "wrong premise", body: "b", evidence: [] });
        const statePath = [await stateOf(h.queue, id)];
        await h.queue.claimNext("p", "cc-1", DEFAULT_LEASE_TTL_MS);
        statePath.push(await stateOf(h.queue, id));
        await h.worker.waitForJob(
          await h.worker.enqueue("p", "answer", { taskId: id, question: `close task ${id}: premise is wrong`, agent: "cc-1" }),
          JOB_WAIT_MS,
        );
        statePath.push(await stateOf(h.queue, id)); // -> DONE
        return { kinds: await decisionKinds(h.db), statePath };
      }),
  },
  {
    name: "warming-enhance-then-seal",
    matchMode: "strict",
    expectedKinds: ["merge", "create"],
    exec: (driver) =>
      withHarness(driver, async (h) => {
        const id = await h.queue.submit("p", "dana", {
          title: "warming idea",
          body: "plain body",
          evidence: [],
          warmForMs: 60_000,
        });
        const statePath = [await stateOf(h.queue, id)]; // INCUBATING
        // Human contribution during the warming period: mediator merges it.
        await h.worker.waitForJob(
          await h.worker.enqueue("p", "enhance", { taskId: id, contribution: "add a benchmark section", from: "rui" }),
          JOB_WAIT_MS,
        );
        statePath.push(await stateOf(h.queue, id)); // still INCUBATING
        // Seal groom at graduation: full groom pass, then INCUBATING -> QUEUED.
        await h.worker.waitForJob(
          await h.worker.enqueue("p", "seal", { taskId: id, submittedBy: "dana" }),
          JOB_WAIT_MS,
        );
        statePath.push(await stateOf(h.queue, id)); // QUEUED
        return { kinds: await decisionKinds(h.db), statePath };
      }),
  },

  // NEGATIVE CONTROL: the same review-approve run, but asserted against a WRONG
  // golden sequence AND fed a fabricated illegal FSM transition. The eval must
  // detect the violation — a negative scenario passes only when it correctly
  // FAILS both checks. This is the guard that the eval catches the #75-class
  // bug (wrong action sequence / illegal state jump).
  {
    name: "NEGATIVE-wrong-sequence-and-illegal-transition",
    matchMode: "strict",
    negative: true,
    expectedKinds: ["approve"], // deliberately wrong vs the "revise" the run produces
    exec: (driver) =>
      withHarness(driver, async (h) => {
        const id = await h.queue.submit("p", "dana", { title: "t", body: "b", evidence: [] });
        await h.queue.claimNext("p", "cc-1", DEFAULT_LEASE_TTL_MS);
        await h.worker.waitForJob(
          await h.worker.enqueue("p", "review", { taskId: id, plan: "a bad plan", agent: "cc-1" }),
          JOB_WAIT_MS,
        );
        // Real trajectory is ["revise"] (mismatches the "approve" golden), and we
        // splice in an illegal QUEUED -> DONE jump that skips CLAIMED.
        return { kinds: await decisionKinds(h.db), statePath: ["QUEUED", "DONE"] };
      }),
  },
];

// ── runner ───────────────────────────────────────────────────────────────────

export interface TrajectoryCaseResult {
  name: string;
  ok: boolean;
  failures: string[];
  ms: number;
}

export interface TrajectoryScorecard {
  passed: number;
  failed: number;
  perCase: TrajectoryCaseResult[];
}

export interface RunTrajectoryEvalOptions {
  /** Override the golden suite (used by scoring unit tests). */
  scenarios?: TrajectoryScenario[];
}

export async function runTrajectoryEval(
  driverFactory: () => MediatorDriver,
  opts: RunTrajectoryEvalOptions = {},
): Promise<TrajectoryScorecard> {
  const scenarios = opts.scenarios ?? trajectoryScenarios;
  const perCase: TrajectoryCaseResult[] = [];
  // Serial on purpose: each scenario owns a worker + sqlite handle.
  for (const s of scenarios) {
    const start = performance.now();
    let violations: string[];
    try {
      const { kinds, statePath } = await s.exec(driverFactory());
      const match = await matchTrajectory(kinds, s.expectedKinds, s.matchMode);
      const fsm = checkFsm(kinds, statePath);
      violations = [...(match.ok ? [] : [match.comment]), ...fsm.failures];
    } catch (err) {
      violations = [`scenario crashed: ${err instanceof Error ? err.message : String(err)}`];
    }
    const conforms = violations.length === 0;
    if (s.negative) {
      // A negative control must be caught: it passes only when it does NOT conform.
      perCase.push({
        name: s.name,
        ok: !conforms,
        failures: conforms ? ["negative control did NOT trigger — expected a trajectory/FSM violation, found none"] : [],
        ms: performance.now() - start,
      });
    } else {
      perCase.push({ name: s.name, ok: conforms, failures: violations, ms: performance.now() - start });
    }
  }
  const failed = perCase.filter((c) => !c.ok).length;
  return { passed: perCase.length - failed, failed, perCase };
}
