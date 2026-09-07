import { openDb, type Db } from "../db.js";
import type {
  GroomResult,
  MediatorContext,
  MediatorDriver,
  MemoryToolExecutor,
  Submission,
} from "../mediator/driver.js";
import { MemoryStore } from "../mediator/memory.js";
import { registerPipelines } from "../mediator/pipelines.js";
import { buildGroomPrompt } from "../mediator/prompts.js";
import { MediatorWorker } from "../mediator/worker.js";
import { Queue } from "../queue.js";

export interface OverMintEvalOptions {
  transformPrompt?: (prompt: string) => string;
}

export type OverMintTraceStep =
  | {
      kind: "tool";
      name: string;
      args: Record<string, unknown>;
      result: unknown;
    }
  | {
      kind: "reasoning";
      content: string;
    };

export interface OverMintCaseResult {
  name: string;
  ok: boolean;
  minted: boolean;
  overMinted: boolean;
  paths: string[];
  audit: string[];
  trace: OverMintTraceStep[];
  failures: string[];
}

export interface OverMintScorecard {
  cases: number;
  overMints: number;
  penalty: number;
  failed: number;
  promptFailures: string[];
  perCase: OverMintCaseResult[];
}

const REQUIRED_PROMPT_POLICIES: Array<[string, RegExp]> = [
  ["missing mandatory grep-before-write gate", /NO-SPRAWL WRITE GATE:[\s\S]*before EVERY okf_write[\s\S]*okf_grep/],
  ["missing update-existing-home rule", /If grep finds a relevant home[\s\S]*okf_update; okf_write is forbidden/],
  ["missing no-match requirement for new concepts", /NEW-CONCEPT EXCEPTION:[\s\S]*greps return no matching home/],
  ["missing explicit new-concept justification", /reasoning immediately before okf_write[\s\S]*explicitly justify why no existing concept can own it/],
  ["missing task-page anti-sprawl rule", /forbidden merely because the new input came from a different task|NEVER mint a new concept per task/],
];

const PROJECT_ID = "over-mint-eval";
const EXISTING_PATH = "tech/mediator-memory.md";
const REDUNDANT_PATH = "learnings/task-205-capture.md";
const NOVEL_PATH = "conventions/webhook-replay-policy.md";

const EXISTING_DOC = {
  path: EXISTING_PATH,
  type: "Architecture",
  title: "Mediator private memory",
  description: "How the mediator stores and maintains durable project knowledge.",
  tags: ["mediator", "memory", "okf"],
  body: "# Overview\n\nMediator memory is a DB-backed OKF bundle.\n\n# Components\n\nMemoryStore and scoped tools.\n\n# Data flow\n\nGrep before maintenance.\n\n# Citations\n\nTask 88.\n",
};

/** Score only prompt policy. Runtime memory writes deliberately remain ungated. */
export function scoreOverMintPrompt(prompt: string): string[] {
  return REQUIRED_PROMPT_POLICIES
    .filter(([, pattern]) => !pattern.test(prompt))
    .map(([failure]) => failure);
}

interface Policy {
  grepFirst: boolean;
  updateExisting: boolean;
  justifyNew: boolean;
}

function policyFrom(prompt: string): Policy {
  return {
    grepFirst: /before EVERY okf_write[\s\S]*call okf_grep/.test(prompt),
    updateExisting: /If grep finds a relevant home[\s\S]*use okf_update; okf_write is forbidden/.test(prompt),
    justifyNew: /reasoning immediately before okf_write[\s\S]*explicitly justify why no existing concept can own it/.test(prompt),
  };
}

function matchesFrom(result: unknown): { path: string }[] {
  if (!result || typeof result !== "object" || !("matches" in result)) return [];
  const matches = (result as { matches?: unknown }).matches;
  if (!Array.isArray(matches)) return [];
  return matches.filter(
    (match): match is { path: string } =>
      typeof match === "object" && match !== null && "path" in match && typeof match.path === "string",
  );
}

function resultError(result: unknown): string | undefined {
  if (!result || typeof result !== "object" || !("error" in result)) return undefined;
  return String((result as { error: unknown }).error);
}

type Scenario = "existing" | "novel";

/**
 * Deterministic stand-in for the model's tool policy, like groom-posture's
 * policy driver. Unlike a string-trace unit, this driver is invoked by the real
 * groom pipeline and dispatches the production project-scoped ctx.tools.
 */
class OverMintPolicyDriver implements MediatorDriver {
  readonly trace: OverMintTraceStep[] = [];
  prompt = "";

  constructor(
    private readonly scenario: Scenario,
    private readonly transformPrompt: (prompt: string) => string,
  ) {}

  private async dispatch(
    tools: MemoryToolExecutor,
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const result = await tools.dispatch(name, args);
    this.trace.push({ kind: "tool", name, args, result });
    return result;
  }

  async groom(ctx: MediatorContext, submission: Submission): Promise<GroomResult> {
    this.prompt = this.transformPrompt(buildGroomPrompt(ctx, submission));
    const policy = policyFrom(this.prompt);
    if (!ctx.tools) throw new Error("over-mint eval requires pipeline-provided scoped memory tools");

    let reasoning: string | undefined;
    if (this.scenario === "existing") {
      let matches: { path: string }[] = [];
      if (policy.grepFirst) {
        matches = matchesFrom(await this.dispatch(ctx.tools, "okf_grep", { query: "mediator memory" }));
      }
      if (policy.updateExisting && matches.length > 0) {
        const path = matches[0].path;
        await this.dispatch(ctx.tools, "okf_read", { path });
        await this.dispatch(ctx.tools, "okf_update", {
          path,
          body: `${EXISTING_DOC.body}\nThe mediator updates an existing home after grep finds it.\n`,
        });
        reasoning = "The grep found the standing mediator-memory home, so this turn updates it in place.";
      } else {
        // Dissimilar metadata avoids relying on the near-duplicate runtime
        // validator: a weakened prompt really does persist redundant sprawl.
        await this.dispatch(ctx.tools, "okf_write", {
          path: REDUNDANT_PATH,
          type: "Learning",
          title: "Task 205 capture",
          description: "Notes retained from current work.",
          tags: ["task-205"],
          body: "# What we learned\n\nMediator memory should grep before writing.\n\n# Evidence\n\nThe existing architecture concept owns this fact.\n\n# Consequence\n\nMaintain the current home.\n\n# Citations\n\nTask 205.\n",
        });
      }
    } else {
      let matches: { path: string }[] | undefined;
      if (policy.grepFirst) {
        matches = matchesFrom(await this.dispatch(ctx.tools, "okf_grep", { query: "webhook replay policy" }));
      }
      if (policy.justifyNew && matches?.length === 0) {
        reasoning = "Webhook replay policy is an independent durable convention; grep terms 'webhook replay policy' returned no matching home.";
        // The model's reasoning precedes its write tool call. The returned
        // GroomResult also carries this text into the real session stream.
        this.trace.push({ kind: "reasoning", content: reasoning });
      }
      await this.dispatch(ctx.tools, "okf_write", {
        path: NOVEL_PATH,
        type: "Convention",
        title: "Webhook replay policy",
        description: "Idempotency requirements for replayed webhook deliveries.",
        tags: ["webhooks", "idempotency"],
        body: "# Rule\n\nReplayed webhook deliveries reuse the original idempotency key.\n\n# Rationale\n\nRetries must not duplicate side effects.\n\n# Applies to\n\nAll inbound webhook handlers.\n\n# Citations\n\nTask 205.\n",
      });
    }

    return {
      action: "accept",
      title: submission.title,
      body: submission.body,
      priority: submission.priority,
      rationale: "deterministic over-mint policy fixture",
      reasoning,
    };
  }

  async review(): Promise<never> { throw new Error("review was not expected in over-mint eval"); }
  async answer(): Promise<never> { throw new Error("answer was not expected in over-mint eval"); }
  async discuss(): Promise<never> { throw new Error("discuss was not expected in over-mint eval"); }
  async enhance(): Promise<never> { throw new Error("enhance was not expected in over-mint eval"); }
  async conciliate(): Promise<never> { throw new Error("conciliate was not expected in over-mint eval"); }
  async eligibility(): Promise<never> { throw new Error("eligibility was not expected in over-mint eval"); }
}

interface PipelineFixture {
  db: Db;
  memory: MemoryStore;
  queue: Queue;
  worker: MediatorWorker;
  driver: OverMintPolicyDriver;
  taskId: number;
}

async function stopWorker(worker: MediatorWorker): Promise<void> {
  await worker.stopAndWait();
}

async function runPipelineFixture(
  scenario: Scenario,
  transformPrompt: (prompt: string) => string,
): Promise<PipelineFixture> {
  const db = openDb(":memory:");
  await db.prepare(`INSERT INTO projects (id, name) VALUES ('${PROJECT_ID}','Over-mint eval')`).run();
  const memory = new MemoryStore(db);
  await memory.upsert(PROJECT_ID, EXISTING_DOC);
  const queue = new Queue(db);
  const worker = new MediatorWorker(db, { tickMs: 5, jobTimeoutMs: 2_000 });
  const driver = new OverMintPolicyDriver(scenario, transformPrompt);
  registerPipelines({ db, queue, worker, driverFor: () => driver });
  const taskId = await queue.submit(PROJECT_ID, "eval", {
    title: scenario === "existing" ? "Maintain mediator memory" : "Record webhook replay policy",
    body: scenario === "existing"
      ? "Update the standing mediator-memory architecture with the grep-before-write learning."
      : "Record the independent durable convention for replayed webhook delivery idempotency.",
    priority: 2,
    evidence: [],
  });
  const job = await worker.waitForJob(
    await worker.enqueue(PROJECT_ID, "groom", { taskId, submittedBy: "eval" }),
    3_000,
  );
  if (job.status !== "done") {
    await stopWorker(worker);
    await db.close();
    throw new Error(`over-mint groom pipeline ${scenario} fixture ${job.status}: ${job.error ?? "unknown error"}`);
  }
  return { db, memory, queue, worker, driver, taskId };
}

function toolSteps(trace: OverMintTraceStep[]): Extract<OverMintTraceStep, { kind: "tool" }>[] {
  return trace.filter((step): step is Extract<OverMintTraceStep, { kind: "tool" }> => step.kind === "tool");
}

async function existingHomeCase(transformPrompt: (prompt: string) => string): Promise<{ result: OverMintCaseResult; prompt: string }> {
  const { db, memory, worker, driver, taskId } = await runPipelineFixture("existing", transformPrompt);
  try {
    const calls = toolSteps(driver.trace);
    const grep = calls.findIndex((step) => step.name === "okf_grep");
    const update = calls.findIndex((step) => step.name === "okf_update");
    const write = calls.findIndex((step) => step.name === "okf_write");
    const paths = (await memory.list(PROJECT_ID)).map((doc) => doc.path);
    const audit = (await db.prepare(
      `SELECT entry FROM memory_log WHERE project_id=? AND task_id=? ORDER BY id`,
    ).all<{ entry: string }>(PROJECT_ID, taskId)).map((row) => row.entry);
    const existing = await memory.get(PROJECT_ID, EXISTING_PATH);
    const failures: string[] = [];
    if (grep < 0) failures.push("existing-home change did not grep first");
    else if (!matchesFrom(calls[grep].result).some((match) => match.path === EXISTING_PATH)) {
      failures.push("production ctx.tools okf_grep did not find the seeded existing home");
    }
    if (update < 0 || (grep >= 0 && update < grep)) failures.push("existing-home change did not update the matched concept");
    if (write >= 0) failures.push("existing-home change called okf_write");
    if (paths.length !== 1 || paths[0] !== EXISTING_PATH) {
      failures.push(`existing-home fixture persisted unexpected paths: ${paths.join(", ")}`);
    }
    if (!existing?.body.includes("updates an existing home")) failures.push("seeded concept did not receive the durable update");
    if (write < 0 && (audit.length !== 1 || audit[0] !== `Updated knowledge: ${EXISTING_PATH}`)) {
      failures.push(`existing-home audit did not record only the canonical update: ${audit.join(", ")}`);
    }
    for (const step of calls) {
      const error = resultError(step.result);
      if (error) failures.push(`${step.name} failed: ${error}`);
    }
    return {
      prompt: driver.prompt,
      result: {
        name: "existing-home-grep-then-update",
        ok: failures.length === 0,
        minted: paths.includes(REDUNDANT_PATH),
        overMinted: paths.includes(REDUNDANT_PATH),
        paths,
        audit,
        trace: driver.trace,
        failures,
      },
    };
  } finally {
    await stopWorker(worker);
    await db.close();
  }
}

async function legitimateNewConceptCase(transformPrompt: (prompt: string) => string): Promise<OverMintCaseResult> {
  const { db, memory, worker, driver, taskId } = await runPipelineFixture("novel", transformPrompt);
  try {
    const calls = toolSteps(driver.trace);
    const grep = calls.findIndex((step) => step.name === "okf_grep");
    const write = calls.findIndex((step) => step.name === "okf_write");
    const justification = driver.trace.findIndex((step) => step.kind === "reasoning");
    const writeInFullTrace = driver.trace.findIndex((step) => step.kind === "tool" && step.name === "okf_write");
    const paths = (await memory.list(PROJECT_ID)).map((doc) => doc.path);
    const audit = (await db.prepare(
      `SELECT entry FROM memory_log WHERE project_id=? AND task_id=? ORDER BY id`,
    ).all<{ entry: string }>(PROJECT_ID, taskId)).map((row) => row.entry);
    const reasoningEvents = await db.prepare(
      `SELECT content FROM session_events WHERE project_id=? AND task_id=? AND type='reasoning' ORDER BY id`,
    ).all<{ content: string }>(PROJECT_ID, taskId);
    const failures: string[] = [];
    if (grep < 0 || grep > write) failures.push("new concept was not preceded by a real ctx.tools okf_grep call");
    else if (matchesFrom(calls[grep].result).length !== 0) failures.push("new-concept grep did not return a real no-match result");
    if (justification < 0 || justification > writeInFullTrace) failures.push("new concept lacked explicit pre-write justification");
    if (reasoningEvents.length !== 1 || !reasoningEvents[0].content.includes("no matching home")) {
      failures.push("groom pipeline did not persist the explicit new-concept justification");
    }
    if (write < 0) failures.push("legitimate independent concept was not written");
    if (!paths.includes(EXISTING_PATH) || !paths.includes(NOVEL_PATH) || paths.length !== 2) {
      failures.push(`new-concept fixture persisted unexpected paths: ${paths.join(", ")}`);
    }
    if (audit.length !== 1 || audit[0] !== `Wrote knowledge: ${NOVEL_PATH}`) {
      failures.push(`new-concept audit did not record the expected write: ${audit.join(", ")}`);
    }
    for (const step of calls) {
      const error = resultError(step.result);
      if (error) failures.push(`${step.name} failed: ${error}`);
    }
    const minted = paths.includes(NOVEL_PATH);
    return {
      name: "legitimate-new-concept",
      ok: failures.length === 0,
      minted,
      overMinted: minted && failures.length > 0,
      paths,
      audit,
      trace: driver.trace,
      failures,
    };
  } finally {
    await stopWorker(worker);
    await db.close();
  }
}

/** Hard gate: every redundant or unjustified persisted concept adds one penalty. */
export async function runOverMintEval(options: OverMintEvalOptions = {}): Promise<OverMintScorecard> {
  const transformPrompt = options.transformPrompt ?? ((value: string) => value);
  const existing = await existingHomeCase(transformPrompt);
  const perCase = [existing.result, await legitimateNewConceptCase(transformPrompt)];
  const promptFailures = scoreOverMintPrompt(existing.prompt);
  const overMints = perCase.filter((result) => result.overMinted).length;
  const caseFailures = perCase.filter((result) => !result.ok).length;
  return {
    cases: perCase.length,
    overMints,
    penalty: overMints,
    failed: caseFailures + promptFailures.length,
    promptFailures,
    perCase,
  };
}
