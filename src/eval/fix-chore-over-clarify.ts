/**
 * Fix/chore over-clarify eval (task #488).
 *
 * Measures whether backend-only corrective/hardening submissions are accepted
 * without invisible-slice reshape clarifies, while true invisible-slice FEATURE
 * work still reshapes. Baseline = real model full groom path (no pre-route).
 * Treatment = production pre-classifier route (isFixOrChore before model).
 */
import type { MediatorContext, MediatorDriver, GroomResult, Submission } from "../mediator/driver.js";
import { groomHold, isFixOrChore } from "../mediator/pipelines.js";
import { compareRates, formatRateComparison, type RateComparison } from "./scorecard.js";

export type FixChoreLabel = "fix_chore" | "invisible_feature";

export interface FixChoreFixture {
  name: string;
  label: FixChoreLabel;
  title: string;
  body: string;
  /** Expected: fix_chore must not reshape; invisible_feature must reshape. */
  expectReshapeClarify: boolean;
}

/** Match model/guard reshape language for invisible-slice FEATURE bounces. */
export function isInvisibleSliceReshapeClarify(result: GroomResult): boolean {
  if (result.action !== "clarify") return false;
  const text = `${result.question}\n${result.rationale}`;
  return /working\s+vertical|backend-only|invisible|visible,?\s+usable\s+delivery|reshape|nothing\s+(the\s+)?human\s+can\s+(see|use)|observable,?\s+usable/i.test(
    text,
  );
}

export const fixChoreOverClarifyFixtures: FixChoreFixture[] = [
  {
    name: "gap-markevent-promote",
    label: "fix_chore",
    title: "markEvent missing on promoteAwaitingMerge path",
    body: "Gap fix: promoteAwaitingMerge must call markEvent like tools.ts complete. Backend-only; preserves existing DONE flow; nothing visible changes.",
    expectReshapeClarify: false,
  },
  {
    name: "harden-verification-required",
    label: "fix_chore",
    title: "Make coder_complete verification arg required",
    body: "Hardening: make the verification argument required. Backend-only schema change; no user-facing UI.",
    expectReshapeClarify: false,
  },
  {
    name: "race-token-refresh",
    label: "fix_chore",
    title: "fix: race in the token refresh path",
    body: "Expected: refresh succeeds under load. Actual: intermittent 401. Repro: hammer refresh. Fix preserves the existing token flow; nothing visible changes.",
    expectReshapeClarify: false,
  },
  {
    name: "sanitize-needs-you",
    label: "fix_chore",
    title: "Sanitize Needs-You reason text",
    body: "Sanitization/scrub of human-facing attention reasons so attempt notes do not leak env names. Corrective info-disclosure fix.",
    expectReshapeClarify: false,
  },
  {
    name: "transient-stamp-304-clear",
    label: "fix_chore",
    title: "Bounded-retry stamp clears only on state change, not on a successful probe",
    body: "Fix: clear merge_probe_transient_since on a successful 304/unchanged tick. Stale stamp + one new blip causes premature BLOCK. Backend-only merge poller correctness; preserves existing AWAITING_MERGE flow.",
    expectReshapeClarify: false,
  },
  {
    name: "invisible-auth-seam",
    label: "invisible_feature",
    title: "Extract auth token refresh into a shared seam",
    body: "Outcome: a preserved-flow migration of token refresh behind an internal backend seam. Backend-only; nothing user-facing changes; preserves existing login behavior.",
    expectReshapeClarify: true,
  },
];

export interface FixChoreCaseOutcome {
  name: string;
  label: FixChoreLabel;
  action: string;
  reshaped: boolean;
  ok: boolean;
}

export interface FixChoreArmScorecard {
  arm: "baseline" | "treatment";
  fixChoreTotal: number;
  fixChoreReshape: number;
  fixChoreReshapeRate: number;
  featureTotal: number;
  featureReshape: number;
  featureReshapeRate: number;
  /** Gate: zero reshape on fix/chore AND at least one reshape on invisible feature when present. */
  gatePass: boolean;
  perCase: FixChoreCaseOutcome[];
}

export interface FixChoreBaselineTreatment {
  baseline: FixChoreArmScorecard;
  treatment: FixChoreArmScorecard;
  fixChoreReshape: RateComparison;
  summary: string;
  /** Treatment meets the production gate. */
  treatmentGatePass: boolean;
}

function emptyCtx(): MediatorContext {
  return {
    projectId: "eval",
    projectName: "Eval",
    queue: [],
    decisions: [],
    memory: "",
  };
}

function submissionFrom(fixture: FixChoreFixture): Submission {
  return {
    taskId: 1,
    title: fixture.title,
    body: fixture.body,
    priority: 2,
    submittedBy: "eval",
    evidence: [],
  };
}

/** Apply the same admit-side hold as production after a model result. */
function applyAdmitHold(title: string, body: string, result: GroomResult): GroomResult {
  const admitting = result.action === "accept" || result.action === "merge";
  if (!admitting) return result;
  const hold = groomHold(title, body);
  if (!hold) return result;
  return {
    action: "clarify",
    question: hold.question,
    rationale: hold.rationale,
  };
}

/** Production treatment path: pre-classify fix/chore before the model. */
export async function groomWithFixChorePreclass(
  driver: MediatorDriver,
  fixture: FixChoreFixture,
): Promise<GroomResult> {
  const sub = submissionFrom(fixture);
  if (isFixOrChore(sub.title, sub.body)) {
    return {
      action: "accept",
      title: sub.title,
      body: sub.body,
      priority: sub.priority,
      rationale: "pre-classified fix/chore; skipped feature reshape path",
    };
  }
  const result = await driver.groom(emptyCtx(), sub);
  return applyAdmitHold(sub.title, sub.body, result);
}

/** Baseline path: always call the model (no pre-route), then admit-side hold. */
export async function groomBaseline(
  driver: MediatorDriver,
  fixture: FixChoreFixture,
): Promise<GroomResult> {
  const sub = submissionFrom(fixture);
  const result = await driver.groom(emptyCtx(), sub);
  return applyAdmitHold(sub.title, sub.body, result);
}

function grade(fixture: FixChoreFixture, result: GroomResult): FixChoreCaseOutcome {
  const reshaped = isInvisibleSliceReshapeClarify(result);
  const ok = fixture.expectReshapeClarify ? reshaped : !reshaped && result.action === "accept";
  return {
    name: fixture.name,
    label: fixture.label,
    action: result.action,
    reshaped,
    ok,
  };
}

export async function runFixChoreArm(
  arm: "baseline" | "treatment",
  driverFor: () => MediatorDriver | Promise<MediatorDriver>,
  opts: { fixtures?: FixChoreFixture[]; samples?: number } = {},
): Promise<FixChoreArmScorecard> {
  const fixtures = opts.fixtures ?? fixChoreOverClarifyFixtures;
  const samples = Math.max(1, opts.samples ?? 1);
  const perCase: FixChoreCaseOutcome[] = [];
  let fixChoreTotal = 0;
  let fixChoreReshape = 0;
  let featureTotal = 0;
  let featureReshape = 0;

  for (const fixture of fixtures) {
    let last: FixChoreCaseOutcome | null = null;
    for (let i = 0; i < samples; i++) {
      const driver = await driverFor();
      const result =
        arm === "treatment"
          ? await groomWithFixChorePreclass(driver, fixture)
          : await groomBaseline(driver, fixture);
      const outcome = grade(fixture, result);
      last = outcome;
      if (fixture.label === "fix_chore") {
        fixChoreTotal += 1;
        if (outcome.reshaped) fixChoreReshape += 1;
      } else {
        featureTotal += 1;
        if (outcome.reshaped) featureReshape += 1;
      }
    }
    if (last) perCase.push(last);
  }

  const fixChoreReshapeRate = fixChoreTotal === 0 ? 0 : fixChoreReshape / fixChoreTotal;
  const featureReshapeRate = featureTotal === 0 ? 0 : featureReshape / featureTotal;
  const gatePass =
    fixChoreReshape === 0 &&
    fixChoreTotal > 0 &&
    (featureTotal === 0 || featureReshape > 0);

  return {
    arm,
    fixChoreTotal,
    fixChoreReshape,
    fixChoreReshapeRate,
    featureTotal,
    featureReshape,
    featureReshapeRate,
    gatePass,
    perCase,
  };
}

export async function runFixChoreBaselineTreatment(opts: {
  baselineDriver: () => MediatorDriver | Promise<MediatorDriver>;
  treatmentDriver: () => MediatorDriver | Promise<MediatorDriver>;
  fixtures?: FixChoreFixture[];
  samples?: number;
}): Promise<FixChoreBaselineTreatment> {
  const baseline = await runFixChoreArm("baseline", opts.baselineDriver, opts);
  const treatment = await runFixChoreArm("treatment", opts.treatmentDriver, opts);
  const fixChoreReshape = compareRates(
    "fixChoreReshapeRate",
    {
      successes: baseline.fixChoreReshape,
      total: baseline.fixChoreTotal,
      label: "baseline",
    },
    {
      successes: treatment.fixChoreReshape,
      total: treatment.fixChoreTotal,
      label: "treatment",
    },
    // Small fixture packs: report z-test without requiring n≥20 for the gate.
    { minSample: 1, minEffect: 0.01 },
  );
  const summary = [
    `fix-chore reshape rate: baseline=${baseline.fixChoreReshape}/${baseline.fixChoreTotal} (${(baseline.fixChoreReshapeRate * 100).toFixed(0)}%)`,
    `treatment=${treatment.fixChoreReshape}/${treatment.fixChoreTotal} (${(treatment.fixChoreReshapeRate * 100).toFixed(0)}%)`,
    formatRateComparison(fixChoreReshape),
    `feature reshape: baseline=${baseline.featureReshape}/${baseline.featureTotal} treatment=${treatment.featureReshape}/${treatment.featureTotal}`,
    `treatment gate: ${treatment.gatePass ? "PASS" : "FAIL"} (need 0 fix/chore reshape; feature still reshapes)`,
  ].join("\n");
  return {
    baseline,
    treatment,
    fixChoreReshape,
    summary,
    treatmentGatePass: treatment.gatePass,
  };
}
