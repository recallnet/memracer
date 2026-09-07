/**
 * Review-fidelity eval (Frigg improvement Layer 2 brick 1).
 * Measures whether plan-review revises hollow feature plans without
 * nitpicking whole ones. CI uses FakeDriver; real-model A/B is on-demand
 * via scripts/eval-review-fidelity.ts --real.
 */
import type { MediatorContext, MediatorDriver, ReviewResult } from "../mediator/driver.js";
import { compareRates, formatRateComparison, type RateComparison } from "./scorecard.js";

export type HollowKind =
  | "unwired-path"
  | "isolation-only-tests"
  | "partial-criteria"
  | "easier-task-substitution";

export type WholenessLabel = "whole" | "hollow";

export interface ReviewFidelityFixture {
  name: string;
  label: WholenessLabel;
  hollowKind?: HollowKind;
  task: { title: string; body: string; groomingRationale: string };
  plan: string;
  filesTouched?: string[];
  risk?: string;
  expectedVerdict: "approved" | "revise";
}

/** Standing wholeness criteria text injected into feature specs by groom. */
export const WHOLENESS_CRITERIA = [
  "Wired path: the user-facing / production path must be connected end-to-end (not only a dormant store or offline API).",
  "Demonstrated working: an integration or browser test must exercise that real path, not only unit tests of a sub-component in isolation.",
  "Complete criteria: acceptance criteria must cover the full vertical slice (delivery the human can observe or use).",
].join(" ");

export const reviewFidelityFixtures: ReviewFidelityFixture[] = [
  {
    // Historical miss: ungroomed feature body — review-side bar must catch
    // without WHOLENESS_CRITERIA restated in the leased spec.
    name: "historical-interrogation-unwired",
    label: "hollow",
    hollowKind: "unwired-path",
    task: {
      title: "Interactive interrogation before accept",
      body: "Outcome: multi-round negotiation before accept.\nAcceptance criteria: negotiation store persists rounds; unit tests cover open/answer.",
      groomingRationale: "feature vertical",
    },
    plan: "Add NegotiationStore + unit tests for open/ask/answer/finalize. Ship the store tables and pipeline hooks. Unit tests only for the store. No browser path and no end-to-end wiring.",
    filesTouched: ["src/negotiation.ts", "tests/negotiation.test.ts"],
    risk: "low",
    expectedVerdict: "revise",
  },
  {
    name: "ungroomed-unwired-store",
    label: "hollow",
    hollowKind: "unwired-path",
    task: {
      title: "Live attention push fanout",
      body: "Outcome: push notifications fire when attention episodes open.\nAcceptance criteria: delivery helper has unit coverage.",
      groomingRationale: "feature",
    },
    plan: "Add a PushStore table and unit-test enqueue/dequeue in isolation. Store only; no live path wiring.",
    filesTouched: ["src/push-store.ts", "tests/push-store.test.ts"],
    expectedVerdict: "revise",
  },
  {
    name: "ungroomed-isolation-ui",
    label: "hollow",
    hollowKind: "isolation-only-tests",
    task: {
      title: "Team contribution chart",
      body: "Outcome: Team tab shows contributor bars.\nAcceptance criteria: bar width helper is pure and unit-tested.",
      groomingRationale: "feature",
    },
    plan: "Implement barWidth() helper; unit tests only for the helper. No browser test and no component mount of the Team tab.",
    filesTouched: ["src/dashboard/web/lib/bars.ts", "tests/bars.test.ts"],
    expectedVerdict: "revise",
  },
  {
    name: "isolation-only-tests",
    label: "hollow",
    hollowKind: "isolation-only-tests",
    task: {
      title: "Desktop notifications for attention",
      body: `Outcome: humans get OS notifications when attention appears.\nAcceptance criteria: ${WHOLENESS_CRITERIA}`,
      groomingRationale: "feature",
    },
    plan: "Implement web-push module and unit-test claimDelivery and notifyUserAttention in isolation. No browser or end-to-end path.",
    filesTouched: ["src/web-push.ts", "tests/web-push.test.ts"],
    expectedVerdict: "revise",
  },
  {
    name: "partial-criteria",
    label: "hollow",
    hollowKind: "partial-criteria",
    task: {
      title: "Org workspace switcher",
      body: `Outcome: switch Orgs and Projects in the shell.\nAcceptance criteria: ${WHOLENESS_CRITERIA}`,
      groomingRationale: "feature",
    },
    plan: "Add org select UI component. Tests cover the option label helper only.",
    filesTouched: ["src/dashboard/web/lib/org-workspace.ts"],
    expectedVerdict: "revise",
  },
  {
    name: "easier-task-substitution",
    label: "hollow",
    hollowKind: "easier-task-substitution",
    task: {
      title: "Wire push notifications to live attention",
      body: `Outcome: push fires when attention episodes open.\nAcceptance criteria: ${WHOLENESS_CRITERIA}`,
      groomingRationale: "feature",
    },
    plan: "Instead of wiring dispatch, document the push API in a markdown design note and add a types-only package.",
    filesTouched: ["docs/push-design.md"],
    expectedVerdict: "revise",
  },
  {
    name: "whole-wired-with-browser",
    label: "whole",
    task: {
      title: "Needs-you attention panel",
      body: `Outcome: dashboard lists open questions and blocked tasks.\nAcceptance criteria: ${WHOLENESS_CRITERIA}`,
      groomingRationale: "feature",
    },
    plan: "Wire GET /api/p/:project/attention to listHumanAttention; NeedsYouPanel consumes it; browser test asserts blocked-before-lease order and live rows.",
    filesTouched: [
      "src/human-attention.ts",
      "src/dashboard.ts",
      "tests/browser/dashboard-react-home.browser.test.ts",
    ],
    expectedVerdict: "approved",
  },
  {
    name: "whole-feature-vertical",
    label: "whole",
    task: {
      title: "Magic-link sign-in",
      body: `Outcome: humans sign in via email magic link.\nAcceptance criteria: ${WHOLENESS_CRITERIA}`,
      groomingRationale: "feature",
    },
    plan: "Implement better-auth magic link routes, sign-in page, session cookie; integration test drives /api/auth/magic-link → session.",
    filesTouched: ["src/auth.ts", "src/server.ts", "tests/server-auth.test.ts"],
    expectedVerdict: "approved",
  },
  {
    name: "chore-no-wholeness-required",
    label: "whole",
    task: {
      title: "Fix typo in README",
      body: "Outcome: correct the install command typo.\nAcceptance criteria: README installs cleanly.",
      groomingRationale: "chore",
    },
    plan: "Edit README install line; no product path change.",
    filesTouched: ["README.md"],
    expectedVerdict: "approved",
  },
  {
    name: "fix-with-regression-test",
    label: "whole",
    task: {
      title: "Fix Postgres transaction abort on push",
      body: "Outcome: await push after commit so PGlite does not abort.\nAcceptance criteria: postgres suite green; no fire-and-forget DB work.",
      groomingRationale: "fix",
    },
    plan: "Defer scheduleProjectAttentionPush mid-transaction; flush after commit; regression test on nested addQuestions.",
    filesTouched: ["src/push-dispatch.ts", "tests/push-dispatch.test.ts"],
    expectedVerdict: "approved",
  },
];

function taskContext(task: ReviewFidelityFixture["task"]): MediatorContext {
  return {
    projectId: "eval",
    projectName: "eval-project",
    queue: [{ id: 1, title: task.title, state: "PLANNING", priority: 1 }],
    decisions: [
      {
        kind: "create",
        task_id: 1,
        summary: `created "${task.title}"`,
        rationale: `Task spec: ${task.body}`,
      },
    ],
    memory: "",
  };
}

/**
 * Hollow feedback must name the wholeness gap. Bare "path" or "unit test"
 * alone does not count (wrong-direction advice must not pass). Accepts common
 * real-model phrasings like "wire the delivery path to the live queue".
 */
export function hollowFeedbackNamesGap(feedback: string): boolean {
  const text = feedback.toLowerCase();
  return (
    /wholeness/.test(text) ||
    /wir(?:e|ed)\b[\s\S]{0,40}\bpath|delivery path|live queue|user-facing|end-to-end|\be2e\b/.test(
      text,
    ) ||
    /isolation|sub-component/.test(text) ||
    /integration(?:\s+or\s+browser)?\s+test|browser test/.test(text)
  );
}

/**
 * Regression/improvement sample gate for baseline-vs-treatment cards.
 * Floors at 4; rises with hollow sample size so --samples=N tightens the bar.
 * (Previously `Math.min(..., 4)` made this always 4.)
 */
export function fidelityMinSample(
  baselineHollowTotal: number,
  treatmentHollowTotal: number,
): number {
  return Math.max(4, Math.min(baselineHollowTotal, treatmentHollowTotal));
}

/** Deterministic layer-1 classifier for review-fidelity outcomes. */
export function classifyReviewFidelity(
  fixture: ReviewFidelityFixture,
  result: ReviewResult,
): { pass: boolean; hollowCaught: boolean; wholePreserved: boolean; clarified: boolean } {
  const verdictOk = result.verdict === fixture.expectedVerdict;
  const feedback = `${result.feedback} ${result.rationale}`;
  let hollowCaught = true;
  if (fixture.label === "hollow") {
    hollowCaught = result.verdict === "revise" && hollowFeedbackNamesGap(feedback);
  }
  const wholePreserved = fixture.label === "whole" ? result.verdict === "approved" : true;
  const clarified = result.verdict === "clarify";
  return {
    pass: verdictOk && (fixture.label === "hollow" ? hollowCaught : wholePreserved),
    hollowCaught,
    wholePreserved,
    clarified,
  };
}

export interface ReviewFidelityCaseResult {
  name: string;
  label: WholenessLabel;
  expected: string;
  got: string;
  ok: boolean;
  hollowCaught: boolean;
  wholePreserved: boolean;
  clarified: boolean;
  samples: number;
}

export interface ReviewFidelityScorecard {
  cases: number;
  hollow: number;
  whole: number;
  hollowRecall: number;
  wholePrecision: number;
  /** Share of whole-fixture samples that returned clarify (over-clarify pressure). */
  clarifyRate: number;
  passRate: number;
  perCase: ReviewFidelityCaseResult[];
  /** Aggregate successes/totals across samples for z-tests. */
  hollowCaughtSuccesses: number;
  hollowTotal: number;
  wholePreservedSuccesses: number;
  wholeTotal: number;
  wholeClarifySuccesses: number;
}

export interface RunReviewFidelityOpts {
  /** Stochastic samples per fixture (real-model). Default 1. */
  samples?: number;
  fixtures?: ReviewFidelityFixture[];
}

export async function runReviewFidelityEval(
  driverFor: () => MediatorDriver | Promise<MediatorDriver>,
  fixturesOrOpts: ReviewFidelityFixture[] | RunReviewFidelityOpts = reviewFidelityFixtures,
): Promise<ReviewFidelityScorecard> {
  const opts: RunReviewFidelityOpts = Array.isArray(fixturesOrOpts)
    ? { fixtures: fixturesOrOpts, samples: 1 }
    : fixturesOrOpts;
  const fixtures = opts.fixtures ?? reviewFidelityFixtures;
  const samples = Math.max(1, opts.samples ?? 1);
  const perCase: ReviewFidelityCaseResult[] = [];
  let hollowCaughtSuccesses = 0;
  let hollowTotal = 0;
  let wholePreservedSuccesses = 0;
  let wholeTotal = 0;
  let wholeClarifySuccesses = 0;
  let passSuccesses = 0;
  let passTotal = 0;

  for (const fixture of fixtures) {
    let hollowHits = 0;
    let wholeHits = 0;
    let clarifyHits = 0;
    let passHits = 0;
    let lastVerdict = "";
    for (let i = 0; i < samples; i++) {
      const driver = await driverFor();
      const result = await driver.review(taskContext(fixture.task), {
        taskId: 1,
        task: fixture.task,
        plan: fixture.plan,
        filesTouched: fixture.filesTouched,
        risk: fixture.risk,
      });
      lastVerdict = result.verdict;
      const graded = classifyReviewFidelity(fixture, result);
      if (fixture.label === "hollow") {
        hollowTotal += 1;
        if (graded.hollowCaught) {
          hollowHits += 1;
          hollowCaughtSuccesses += 1;
        }
      } else {
        wholeTotal += 1;
        if (graded.wholePreserved) {
          wholeHits += 1;
          wholePreservedSuccesses += 1;
        }
        if (graded.clarified) {
          clarifyHits += 1;
          wholeClarifySuccesses += 1;
        }
      }
      passTotal += 1;
      if (graded.pass) passHits += 1;
    }
    passSuccesses += passHits;
    const hollowCaught = fixture.label === "hollow" ? hollowHits === samples : true;
    const wholePreserved = fixture.label === "whole" ? wholeHits === samples : true;
    perCase.push({
      name: fixture.name,
      label: fixture.label,
      expected: fixture.expectedVerdict,
      got: lastVerdict,
      ok: fixture.label === "hollow" ? hollowCaught : wholePreserved,
      hollowCaught: fixture.label === "hollow" ? hollowHits / samples === 1 : true,
      wholePreserved: fixture.label === "whole" ? wholeHits / samples === 1 : true,
      clarified: clarifyHits > 0,
      samples,
    });
  }

  const hollow = perCase.filter((c) => c.label === "hollow");
  const whole = perCase.filter((c) => c.label === "whole");
  return {
    cases: perCase.length,
    hollow: hollow.length,
    whole: whole.length,
    hollowRecall: hollowTotal ? hollowCaughtSuccesses / hollowTotal : 1,
    wholePrecision: wholeTotal ? wholePreservedSuccesses / wholeTotal : 1,
    clarifyRate: wholeTotal ? wholeClarifySuccesses / wholeTotal : 0,
    passRate: passTotal ? passSuccesses / passTotal : 0,
    perCase,
    hollowCaughtSuccesses,
    hollowTotal,
    wholePreservedSuccesses,
    wholeTotal,
    wholeClarifySuccesses,
  };
}

export interface BaselineTreatmentCard {
  baseline: ReviewFidelityScorecard;
  treatment: ReviewFidelityScorecard;
  hollowRecall: RateComparison;
  wholePrecision: RateComparison;
  clarifyRate: RateComparison;
  summary: string;
}

/**
 * Compare two drivers (baseline vs treatment prompts/behavior) on the same fixtures.
 * Real-model A/B injects OpenRouter drivers with/without the wholeness bar.
 */
export async function runReviewFidelityBaselineTreatment(input: {
  baselineDriver: () => MediatorDriver | Promise<MediatorDriver>;
  treatmentDriver: () => MediatorDriver | Promise<MediatorDriver>;
  fixtures?: ReviewFidelityFixture[];
  samples?: number;
}): Promise<BaselineTreatmentCard> {
  const fixtures = input.fixtures ?? reviewFidelityFixtures;
  const samples = input.samples ?? 1;
  const baseline = await runReviewFidelityEval(input.baselineDriver, { fixtures, samples });
  const treatment = await runReviewFidelityEval(input.treatmentDriver, { fixtures, samples });
  const minSample = fidelityMinSample(baseline.hollowTotal, treatment.hollowTotal);
  const hollowRecall = compareRates(
    "hollow-recall",
    {
      label: "baseline",
      successes: baseline.hollowCaughtSuccesses,
      total: Math.max(1, baseline.hollowTotal),
    },
    {
      label: "treatment",
      successes: treatment.hollowCaughtSuccesses,
      total: Math.max(1, treatment.hollowTotal),
    },
    { minSample, minEffect: 0.1 },
  );
  const wholePrecision = compareRates(
    "whole-precision",
    {
      label: "baseline",
      successes: baseline.wholePreservedSuccesses,
      total: Math.max(1, baseline.wholeTotal),
    },
    {
      label: "treatment",
      successes: treatment.wholePreservedSuccesses,
      total: Math.max(1, treatment.wholeTotal),
    },
    { minSample, minEffect: 0.1 },
  );
  // Higher clarify rate on whole plans is worse. compareRates treats higher
  // treatment rate as improvement; swap the significance flags so over-clarify
  // reports as significantRegression (under-clarify as significantImprovement).
  // Note: scripts/eval-review-fidelity.ts still maps clarifyRegression via
  // significantImprovement (pre-fix workaround) — follow-up to flip that reader.
  const clarifyCompared = compareRates(
    "whole-clarify-rate",
    {
      label: "baseline",
      successes: baseline.wholeClarifySuccesses,
      total: Math.max(1, baseline.wholeTotal),
    },
    {
      label: "treatment",
      successes: treatment.wholeClarifySuccesses,
      total: Math.max(1, treatment.wholeTotal),
    },
    { minSample, minEffect: 0.1 },
  );
  const clarifyRate = {
    ...clarifyCompared,
    significantImprovement: clarifyCompared.significantRegression,
    significantRegression: clarifyCompared.significantImprovement,
  };
  const summary = [
    "review-fidelity baseline vs treatment",
    formatRateComparison(hollowRecall),
    formatRateComparison(wholePrecision),
    formatRateComparison(clarifyRate),
    `baseline passRate=${(baseline.passRate * 100).toFixed(1)}% treatment passRate=${(treatment.passRate * 100).toFixed(1)}%`,
    `samples/fixture=${samples}`,
  ].join("\n");
  return { baseline, treatment, hollowRecall, wholePrecision, clarifyRate, summary };
}

