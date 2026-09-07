import { buildEnhancePrompt, buildGroomPrompt } from "../mediator/prompts.js";
import { openDb } from "../db.js";
import { Queue } from "../queue.js";
import { MediatorWorker } from "../mediator/worker.js";
import { registerPipelines } from "../mediator/pipelines.js";
import type { MediatorContext, MediatorDriver, Submission } from "../mediator/driver.js";
import { isGoalTaskBody } from "../../coder-kit/goal-task.mjs";

export type TaskStructure = "goal" | "prompt";

export interface GoalStructureFixture {
  name: string;
  submission: Submission;
  expectedBody: string;
  preservedText: string[];
  expected: TaskStructure;
}

const baseSubmission = { taskId: 1, priority: 2 as const, submittedBy: "eval", evidence: [] };

export const goalStructureFixtures: GoalStructureFixture[] = [
  {
    name: "auth-tests-pass",
    submission: {
      ...baseSubmission,
      title: "Make the auth suite pass",
      body: "All auth tests pass. Verify with `pnpm vitest run tests/auth`; PASS means exit 0 and 24/24 tests. Preserve public auth behavior and do not change migrations.",
    },
    expectedBody: "Goal: all auth tests pass.\nVerify: pnpm vitest run tests/auth; PASS means exit 0 and 24/24 tests.\nInvariants: preserve public auth behavior; do not change migrations.",
    preservedText: ["pnpm vitest run tests/auth", "exit 0 and 24/24 tests", "public auth behavior", "do not change migrations"],
    expected: "goal",
  },
  {
    name: "p95-under-120ms",
    submission: {
      ...baseSubmission,
      title: "Bring search p95 below 120 ms",
      body: "Search p95 is below 120 ms. Run `pnpm bench search --json`; PASS means reported p95_ms < 120. Preserve result ordering and do not change the public response schema.",
    },
    expectedBody: "Goal: search p95 is below 120 ms.\nVerify: pnpm bench search --json; PASS means reported p95_ms < 120.\nInvariants: preserve result ordering; do not change the public response schema.",
    preservedText: ["pnpm bench search --json", "p95_ms < 120", "result ordering", "do not change the public response schema"],
    expected: "goal",
  },
  {
    name: "close-migrate-v2-issues",
    submission: {
      ...baseSubmission,
      title: "Close migrate-v2 issues with a passing PR",
      body: "Every migrate-v2 issue is closed by a passing PR. Run `sh -c 'open=$(gh issue list --label migrate-v2 --state open --json number); prs=$(gh pr list --state merged --search \"label:migrate-v2\" --json number --jq \".[].number\"); test \"$open\" = \"[]\" && test -n \"$prs\" && for pr in $prs; do gh pr checks \"$pr\" --required || exit 1; done'`; PASS means exit 0 after finding zero open issues, at least one matching merged PR, and green required checks for every matching PR. Preserve v1 compatibility and do not edit archived migrations.",
    },
    expectedBody: "Goal: every migrate-v2 issue is closed by a passing PR.\nVerify: sh -c 'open=$(gh issue list --label migrate-v2 --state open --json number); prs=$(gh pr list --state merged --search \"label:migrate-v2\" --json number --jq \".[].number\"); test \"$open\" = \"[]\" && test -n \"$prs\" && for pr in $prs; do gh pr checks \"$pr\" --required || exit 1; done'; PASS means exit 0 after finding zero open issues, at least one matching merged PR, and green required checks for every matching PR.\nInvariants: preserve v1 compatibility; do not edit archived migrations.",
    preservedText: ["gh issue list --label migrate-v2", "gh pr checks \"$pr\" --required", "zero open issues", "green required checks for every matching PR", "v1 compatibility", "do not edit archived migrations"],
    expected: "goal",
  },
  {
    name: "rename-function",
    submission: { ...baseSubmission, title: "Rename a function", body: "Rename parseThing to parseRecord." },
    expectedBody: "Outcome: parseThing is named parseRecord.\nEvidence: requested rename.\nPointers: locate parseThing in the repository.\nAcceptance criteria: rename the definition and references.\nVerification: run the repository test suite.\nOut-of-scope: behavioral changes.\nConstraints: preserve the existing API behavior.",
    preservedText: ["parseThing", "parseRecord"],
    expected: "prompt",
  },
  {
    name: "explain-x",
    submission: { ...baseSubmission, title: "Explain X", body: "Explain how the queue ordering works." },
    expectedBody: "Outcome: explain how queue ordering works.\nEvidence: explanation requested.\nPointers: inspect the queue implementation.\nAcceptance criteria: describe ordering and ties.\nVerification: compare the explanation with implementation.\nOut-of-scope: code changes.\nConstraints: cite only verified behavior.",
    preservedText: ["explain how queue ordering works"],
    expected: "prompt",
  },
];

export interface GoalStructureCaseResult {
  name: string;
  expected: TaskStructure;
  actual: TaskStructure;
  ok: boolean;
  failures: string[];
}

export interface GoalStructureScorecard {
  passed: number;
  failed: number;
  perCase: GoalStructureCaseResult[];
}

const PROMPT_SECTIONS = [
  "Outcome:",
  "Evidence:",
  "Pointers:",
  "Acceptance criteria:",
  "Verification:",
  "Out-of-scope:",
  "Constraints:",
];

const FORBIDDEN_GOAL_CAPS = /max(?:imum)?[- ]?(?:runs?|turns?)|token budget|stop[- ]after[- ](?:n|\d+)/i;

function classifyEmittedBody(body: string): TaskStructure {
  return isGoalTaskBody(body) ? "goal" : "prompt";
}

const evalContext: MediatorContext = {
  projectId: "goal-structure-eval",
  projectName: "Goal structure eval",
  queue: [],
  decisions: [],
  memory: "",
};

function unused(method: string): () => Promise<never> {
  return async () => {
    throw new Error(`${method} was not expected in the goal-structure eval`);
  };
}

function scriptedDriver(fixture: GoalStructureFixture): MediatorDriver {
  return {
    groom: async () => ({
      action: "accept",
      title: fixture.submission.title,
      body: fixture.expectedBody,
      priority: fixture.submission.priority,
      rationale: "deterministic labeled goal-structure candidate",
    }),
    enhance: async () => ({
      action: "merge",
      body: fixture.expectedBody,
      rationale: "deterministic enhancement preserves the candidate structure",
    }),
    review: unused("review"),
    answer: unused("answer"),
    discuss: unused("discuss"),
    conciliate: unused("conciliate"),
    eligibility: unused("eligibility"),
  };
}

async function persistedDriverBodies(fixture: GoalStructureFixture): Promise<{ groomed: string; enhanced: string }> {
  const db = openDb(":memory:");
  await db.prepare("INSERT INTO projects (id, name) VALUES ('goal-structure-eval','Goal structure eval')").run();
  const queue = new Queue(db);
  const worker = new MediatorWorker(db, { tickMs: 10, jobTimeoutMs: 10_000 });
  registerPipelines({ db, queue, worker, driverFor: () => scriptedDriver(fixture) });
  worker.start();
  try {
    const id = await queue.submit("goal-structure-eval", "eval", {
      title: fixture.submission.title,
      body: fixture.submission.body,
      priority: fixture.submission.priority,
      evidence: fixture.submission.evidence,
      warmForMs: 60 * 60 * 1000,
    });
    const groom = await worker.waitForJob(
      await worker.enqueue("goal-structure-eval", "groom", { taskId: id, submittedBy: "eval" }),
      10_000,
    );
    if (groom.status !== "done") throw new Error(`groom pipeline ${groom.status}: ${groom.error ?? "unknown error"}`);
    const groomed = (await queue.brief(id)).body;
    const enhance = await worker.waitForJob(
      await worker.enqueue("goal-structure-eval", "enhance", {
        taskId: id,
        contribution: "Add stronger regression coverage without changing the requested outcome.",
        from: "eval",
      }),
      10_000,
    );
    if (enhance.status !== "done") throw new Error(`enhance pipeline ${enhance.status}: ${enhance.error ?? "unknown error"}`);
    return { groomed, enhanced: (await queue.brief(id)).body };
  } finally {
    worker.stop();
  }
}

export function scoreGoalStructureBody(fixture: GoalStructureFixture, body: string): string[] {
  const actual = classifyEmittedBody(body);
  const prompt = buildGroomPrompt(evalContext, fixture.submission);
  const enhancePrompt = buildEnhancePrompt(evalContext, {
    taskId: fixture.submission.taskId,
    title: fixture.submission.title,
    body,
    contribution: "Add stronger regression coverage without changing the requested outcome.",
    from: "eval",
  });
  const failures: string[] = [];

  if (actual !== fixture.expected) failures.push(`classified ${actual}, expected ${fixture.expected}`);
  for (const text of fixture.preservedText) {
    if (!body.includes(text)) failures.push(`emitted body lost required text: ${text}`);
  }
  if (FORBIDDEN_GOAL_CAPS.test(body)) failures.push("emitted body contains forbidden cap language");
  if (actual === "goal") {
    const lines = body.split("\n");
    if (lines.length !== 3 || !lines[0].startsWith("Goal: ") || !lines[1].startsWith("Verify: ") || !lines[2].startsWith("Invariants: ")) {
      failures.push("goal body is not exactly Goal/Verify/Invariants");
    }
    if (!/^Verify: \S.*; PASS means \S/m.test(body)) failures.push("goal Verify line lacks an exact command or pass signal");
    if (!/keep iterating/i.test(prompt) || !/coder_progress/.test(prompt)) {
      failures.push("groom prompt omits continuous iteration/progress contract");
    }
    if (!/if and only if/i.test(prompt) || !/measurable boolean end state/i.test(prompt)) {
      failures.push("groom prompt omits all-three goal classification contract");
    }
    if (!/exactly those three lines/i.test(enhancePrompt) || !/preserve its exact runnable command/i.test(enhancePrompt)) {
      failures.push("enhance prompt does not preserve goal structure and verification");
    }
  } else {
    let cursor = -1;
    for (const section of PROMPT_SECTIONS) {
      const next = body.indexOf(section, cursor + 1);
      if (next < 0 || next <= cursor) failures.push(`prompt body missing ordered section ${section}`);
      cursor = next;
    }
    if (!/seven sections in their existing order/i.test(enhancePrompt)) {
      failures.push("enhance prompt does not preserve prompt structure");
    }
  }

  return failures;
}

/** Deterministic driver + real worker/pipeline/Queue contract eval. */
export async function runGoalStructureEval(): Promise<GoalStructureScorecard> {
  const perCase: GoalStructureCaseResult[] = [];
  for (const fixture of goalStructureFixtures) {
    const failures: string[] = [];
    let actual: TaskStructure = "prompt";
    try {
      const bodies = await persistedDriverBodies(fixture);
      actual = classifyEmittedBody(bodies.enhanced);
      failures.push(...scoreGoalStructureBody(fixture, bodies.groomed).map((f) => `groom: ${f}`));
      failures.push(...scoreGoalStructureBody(fixture, bodies.enhanced).map((f) => `enhance: ${f}`));
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err));
    }
    perCase.push({ name: fixture.name, expected: fixture.expected, actual, ok: failures.length === 0, failures });
  }
  return {
    passed: perCase.filter((result) => result.ok).length,
    failed: perCase.filter((result) => !result.ok).length,
    perCase,
  };
}
