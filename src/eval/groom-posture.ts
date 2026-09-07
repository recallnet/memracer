import { openDb } from "../db.js";
import type { GroomResult, MediatorContext, MediatorDriver, Submission } from "../mediator/driver.js";
import { registerPipelines } from "../mediator/pipelines.js";
import { buildGroomPrompt } from "../mediator/prompts.js";
import { MediatorWorker } from "../mediator/worker.js";
import { Queue } from "../queue.js";
import { readFileSync } from "node:fs";

export type GroomPosture = "accept" | "clarify";

export interface GroomPostureFixture {
  name: string;
  expected: GroomPosture;
  defaultable?: boolean;
  expectedBodyText?: string;
  submission: Omit<Submission, "taskId">;
}

const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { dependencies?: Record<string, string> };
const validationDependency = Object.entries(packageJson.dependencies ?? {}).find(([name]) => name === "zod");
if (!validationDependency) throw new Error("groom-posture eval requires the repo's existing zod dependency");
const [validationDependencyName, validationDependencyVersion] = validationDependency;

export const groomPostureFixtures: GroomPostureFixture[] = [
  {
    name: "genuine-decision",
    expected: "clarify",
    submission: {
      title: "Add project digest emails",
      body: "Product decision: should each project digest be daily or weekly? A second later decision is whether owners can disable it.",
      priority: 2,
      submittedBy: "eval",
      evidence: [],
    },
  },
  {
    name: "clear-unambiguous",
    expected: "accept",
    submission: {
      title: "Show queue count in the dashboard header",
      body: "Add the existing queued-task count beside the Queue heading in src/dashboard/web/src/app.tsx and cover it in the dashboard test.",
      priority: 2,
      submittedBy: "eval",
      evidence: [],
    },
  },
  {
    name: "settled-decision",
    expected: "accept",
    defaultable: true,
    submission: {
      title: "Apply the settled dependency order",
      body: "SETTLED DECISION: implement the already-recorded Phase 2 before Phase 3 dependency without asking for sequencing again.",
      priority: 2,
      submittedBy: "eval",
      evidence: [],
    },
  },
  {
    name: "discoverable-fact-gap",
    expected: "accept",
    defaultable: true,
    expectedBodyText: `Use the existing ${validationDependencyName} dependency`,
    submission: {
      title: "Validate imported task metadata",
      body: "FACT GAP: choose the validation library already used by this repo and validate imported task metadata.",
      priority: 2,
      submittedBy: "eval",
      evidence: [
        {
          kind: "code",
          path: "package.json",
          snippet: JSON.stringify({ [validationDependencyName]: validationDependencyVersion }),
          note: "the current package manifest is the source of truth for the existing validation library",
        },
      ],
    },
  },
  ...[
    ["icon-set", "Add an icon to the retry button", "DEFAULTABLE: choose the existing icon set and add a retry icon to the dashboard button."],
    ["size-cap", "Cap mediator log context", "DEFAULTABLE: choose a conservative byte cap for mediator log context and test truncation."],
    ["ui-placement", "Show task freshness", "DEFAULTABLE: place a task freshness indicator in the existing queue row and cover responsive behavior."],
    ["eval-structure", "Add a regression eval", "DEFAULTABLE: choose the fixture and scorecard structure that matches the existing eval harness."],
  ].map(([name, title, body]) => ({
    name,
    expected: "accept" as const,
    defaultable: true,
    expectedBodyText: "Assumption:",
    submission: { title, body, priority: 2, submittedBy: "eval", evidence: [] },
  })),
  // Corrective/hardening submissions must accept with zero reshape-to-vertical
  // clarifies (over-clarify lock). Bodies intentionally use backend-only /
  // preserves-behavior language that would bounce a genuine FEATURE.
  {
    name: "fix-gap-markevent",
    expected: "accept",
    defaultable: true,
    submission: {
      title: "markEvent missing on promoteAwaitingMerge path",
      body: "Gap fix: promoteAwaitingMerge must call markEvent for knowledge domains the same way tools.ts complete does. Backend-only correctness; preserves existing DONE flow; nothing visible changes.",
      priority: 1,
      submittedBy: "eval",
      evidence: [],
    },
  },
  {
    name: "fix-required-verification-arg",
    expected: "accept",
    defaultable: true,
    submission: {
      title: "Make coder_complete verification arg required",
      body: "Hardening: make the verification argument on coder_complete required so completions without proof are refused. Backend-only schema change; no user-facing UI.",
      priority: 1,
      submittedBy: "eval",
      evidence: [],
    },
  },
  {
    name: "fix-metric-bug",
    expected: "accept",
    defaultable: true,
    submission: {
      title: "Scorecard metric double-counts failed checks",
      body: "Bug fix in the scorecard aggregator: failed checks are counted twice under concurrent completion. Backend-only; preserves existing dashboard layout.",
      priority: 1,
      submittedBy: "eval",
      evidence: [],
    },
  },
  {
    name: "fix-sanitize-attention-reason",
    expected: "accept",
    defaultable: true,
    submission: {
      title: "Sanitize Needs-You reason text",
      body: "Sanitization/scrub: human-facing attention reasons must not pass through raw attempt notes (env names, host paths). Map by block_kind; exclude system-domain blocks. Corrective info-disclosure fix on an existing surface.",
      priority: 1,
      submittedBy: "eval",
      evidence: [],
    },
  },
];

const REQUIRED_PROMPT_POLICIES: Array<[string, RegExp]> = [
  ["missing self-serve-facts instruction", /SELF-SERVE FACTS/],
  ["missing clear-task fast-accept instruction", /actionable core: accept it and proceed on your assumptions/],
  ["missing repo and OKF fact sources", /project memory\/OKF[\s\S]*relevant repo code/],
  ["missing independent research instruction", /authoritative documentation[\s\S]*libraries, APIs, and standards/],
  ["missing genuine human-owned decision boundary", /genuine decision the human owns/],
  ["missing one-question-per-round limit", /exactly ONE question per round/],
  ["missing recommended-answer format", /Recommended: <answer>/],
  ["missing prohibition on human library selection", /never ask the human to pick a library or implementation technique/i],
  ["missing agentic-default precedence over grilling", /rule outranks the grilling posture/i],
  ["missing explicit defaultable implementation categories", /Library choice, icon set, size cap, UI placement, eval structure[\s\S]*accept immediately with zero clarifications/i],
  ["missing settled-question discipline", /Never re-ask an answered question or a decision already present[\s\S]*never create a question to narrate/i],
  ["missing fix/chore vs feature classifier for corrective work", /Corrective or hardening work on an existing surface is ALWAYS fix\/chore/i],
  ["missing fix exemption from invisible-slice reshape", /never to fixes or chores|Never reclassify a fix\/chore as an invisible-slice FEATURE/i],
];

/** Score the actual shared prompt policy, independent of any fixture output. */
export function scoreGroomPosturePrompt(prompt: string): string[] {
  const failures = REQUIRED_PROMPT_POLICIES.filter(([, pattern]) => !pattern.test(prompt)).map(([failure]) => failure);
  if (/Did you research current best approaches\?|Which off-the-shelf library should we use/.test(prompt)) {
    failures.push("obsolete bundled research/library gate is present");
  }
  if (/ask at most (?:2|two) questions/i.test(prompt)) failures.push("prompt permits bundled clarification questions");
  if (/end it with "Default:/.test(prompt)) failures.push("prompt uses a default instead of a recommended answer");
  if (/settle every ambiguity up front/i.test(prompt)) failures.push("prompt rewards clarifying every ambiguity");
  return failures;
}

function policyDriver(transform: (prompt: string) => string): MediatorDriver {
  const unused = (method: string) => async (): Promise<never> => {
    throw new Error(`${method} was not expected in the groom-posture eval`);
  };
  return {
    async groom(ctx: MediatorContext, submission: Submission): Promise<GroomResult> {
      const prompt = transform(buildGroomPrompt(ctx, submission));
      const selfServesFacts = /SELF-SERVE FACTS/.test(prompt) && /authoritative documentation/.test(prompt);
      const fastAcceptsClear =
        /Default to action/.test(prompt) && /actionable core: accept it and proceed on your assumptions/.test(prompt);
      const protectsDecisions =
        /genuine decision the human owns/.test(prompt) &&
        /exactly ONE question per round/.test(prompt) &&
        /Recommended: <answer>/.test(prompt);
      const defaultsImplementationDetails =
        /rule outranks the grilling posture/i.test(prompt) &&
        /Library choice, icon set, size cap, UI placement, eval structure[\s\S]*accept immediately with zero clarifications/i.test(prompt) &&
        !/settle every ambiguity up front/i.test(prompt);
      const preservesSettledDecisions =
        /Never re-ask an answered question or a decision already present[\s\S]*never create a question to narrate/i.test(prompt);

      if (/Product decision:/i.test(submission.body) && protectsDecisions) {
        return {
          action: "clarify",
          question: "Should project digests be daily or weekly? Recommended: weekly — it limits notification load while the feature is new.",
          rationale: "cadence is a genuine product-intent decision; the later decision waits for another round",
        };
      }
      if (/SETTLED DECISION:/i.test(submission.body) && !preservesSettledDecisions) {
        return {
          action: "clarify",
          question: "Should Phase 2 run before Phase 3? Recommended: yes — that ordering was previously selected.",
          rationale: "prompt allowed a settled decision to be asked again",
        };
      }
      if (/FACT GAP:/i.test(submission.body) && !selfServesFacts) {
        return {
          action: "clarify",
          question: "Which library should we use? Did you research it?",
          rationale: "prompt failed to make the groomer self-serve factual implementation choices",
        };
      }
      if (/FACT GAP:/i.test(submission.body)) {
        const dependencyEvidence = submission.evidence.find(
          (item) => item.kind === "code" && item.path === "package.json" && item.snippet,
        );
        const dependency = /"([^"]+)"\s*:\s*"([^"]+)"/.exec(dependencyEvidence?.snippet ?? "");
        if (!dependency) {
          return {
            action: "clarify",
            question: "Which validation library is already selected? Recommended: inspect package.json — it is the dependency source of truth.",
            rationale: "the fixture did not supply the discoverable fact it claimed",
          };
        }
        const [, dependencyName, dependencyVersion] = dependency;
        return {
          action: "accept",
          title: submission.title,
          body: submission.body.replace(
            "FACT GAP: choose the validation library already used by this repo",
            `Use the existing ${dependencyName} dependency`,
          ),
          priority: submission.priority,
          rationale: `resolved ${dependencyName}@${dependencyVersion} from the supplied package.json evidence`,
        };
      }
      if (/DEFAULTABLE:/i.test(submission.body)) {
        if (!defaultsImplementationDetails) {
          return {
            action: "clarify",
            question: "Which implementation detail should we use? Recommended: let the coding agent choose — this is reversible and technically interchangeable.",
            rationale: "prompt failed to subordinate ambiguity-grilling to agentic defaults",
          };
        }
        return {
          action: "accept",
          title: submission.title,
          body: `${submission.body}\nAssumption: use the established repository pattern and verify the bounded behavior.`,
          priority: submission.priority,
          rationale: "defaultable implementation detail accepted with a stated assumption",
        };
      }
      if (!fastAcceptsClear) {
        return {
          action: "clarify",
          question: "Should this clear task be implemented as submitted? Recommended: yes — it already names a concrete target and verification.",
          rationale: "prompt lost its fast-accept posture for an actionable core",
        };
      }
      return {
        action: "accept",
        title: submission.title,
        body: submission.body,
        priority: submission.priority,
        rationale: "submission is clear and actionable",
      };
    },
    review: unused("review"),
    answer: unused("answer"),
    discuss: unused("discuss"),
    enhance: unused("enhance"),
    conciliate: unused("conciliate"),
    eligibility: unused("eligibility"),
  };
}

export interface GroomPostureCaseResult {
  name: string;
  expected: GroomPosture;
  actual: GroomPosture;
  ok: boolean;
  failures: string[];
}

export interface GroomPostureScorecard {
  passed: number;
  failed: number;
  promptFailures: string[];
  perCase: GroomPostureCaseResult[];
}

export interface GroomPostureEvalOptions {
  transformPrompt?: (prompt: string) => string;
  transformSubmission?: (fixture: GroomPostureFixture, submission: Submission) => Submission;
}

/** Deterministic prompt-sensitive driver through the real worker/pipeline/Queue. */
export async function runGroomPostureEval(
  options: GroomPostureEvalOptions = {},
): Promise<GroomPostureScorecard> {
  const transformPrompt = options.transformPrompt ?? ((prompt: string) => prompt);
  const prompt = transformPrompt(
    buildGroomPrompt(
      { projectId: "groom-posture-eval", projectName: "Groom posture eval", queue: [], decisions: [], memory: "" },
      { taskId: 0, ...groomPostureFixtures[0].submission },
    ),
  );
  const promptFailures = scoreGroomPosturePrompt(prompt);
  const perCase: GroomPostureCaseResult[] = [];

  for (const fixture of groomPostureFixtures) {
    const db = openDb(":memory:");
    await db.prepare("INSERT INTO projects (id, name) VALUES ('groom-posture-eval','Groom posture eval')").run();
    if (fixture.name === "settled-decision") {
      await db.prepare(
        "INSERT INTO decision_log (project_id, task_id, kind, summary, rationale, created_at) VALUES ('groom-posture-eval', NULL, 'update', 'Phase 2 precedes Phase 3', 'The shared primitives land before surface work.', 1)",
      ).run();
    }
    const queue = new Queue(db);
    const worker = new MediatorWorker(db, { tickMs: 5, jobTimeoutMs: 2_000 });
    registerPipelines({ db, queue, worker, driverFor: () => policyDriver(transformPrompt) });
    worker.start();
    try {
      const baseSubmission = { taskId: 0, ...fixture.submission };
      const submission = options.transformSubmission?.(fixture, baseSubmission) ?? baseSubmission;
      const { taskId: _ignoredTaskId, ...submitted } = submission;
      const id = await queue.submit("groom-posture-eval", "eval", submitted);
      const job = await worker.waitForJob(
        await worker.enqueue("groom-posture-eval", "groom", { taskId: id, submittedBy: "eval" }),
        3_000,
      );
      const result = JSON.parse(job.result ?? "{}") as GroomResult;
      const actual: GroomPosture = result.action === "clarify" ? "clarify" : "accept";
      const questions = await db
        .prepare("SELECT question FROM questions WHERE task_id=? ORDER BY id")
        .all<{ question: string }>(id);
      const failures: string[] = [];
      if (job.status !== "done") failures.push(`groom job status was ${job.status}`);
      if (actual !== fixture.expected) failures.push(`expected ${fixture.expected}, got ${actual}`);
      if (actual === "clarify") {
        if (questions.length !== 1) failures.push(`expected exactly one stored question, got ${questions.length}`);
        const question = questions[0]?.question ?? "";
        if ((question.match(/\?/g) ?? []).length !== 1) failures.push("clarify round did not contain exactly one question");
        if (!/Recommended:\s*\S/.test(question)) failures.push("clarify question omitted a recommended answer");
      } else if (questions.length !== 0) {
        failures.push(`accepted task stored ${questions.length} blocking question(s)`);
      }
      const storedBody = (await queue.brief(id)).body;
      if (fixture.expectedBodyText && !storedBody.includes(fixture.expectedBodyText)) {
        failures.push(`stored body did not ground the discoverable fact: ${fixture.expectedBodyText}`);
      }
      perCase.push({ name: fixture.name, expected: fixture.expected, actual, ok: failures.length === 0, failures });
    } finally {
      worker.stop();
    }
  }

  const failed = perCase.filter((result) => !result.ok).length + (promptFailures.length > 0 ? 1 : 0);
  return { passed: perCase.length - perCase.filter((result) => !result.ok).length, failed, promptFailures, perCase };
}
