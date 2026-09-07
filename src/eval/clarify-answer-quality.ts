/**
 * Clarify/answer quality eval (Frigg improvement Layer 2 brick 4).
 *
 * Grounded (agent-answer) = answer text contains every fixture `requiredAnchors`
 * token (product/queue facts the answer must cite). Non-empty strings alone
 * do **not** count as grounded.
 *
 * Escalate cases must set escalate=true (human-owned budget/secret/customer).
 *
 * CI treatment uses AnchorAwareAnswerDriver (extends FakeDriver) so answers
 * cite anchors deterministically; production quality still needs --real.
 */
import type { AnswerInput, AnswerResult, MediatorContext, MediatorDriver } from "../mediator/driver.js";
import { FakeDriver } from "../mediator/fake.js";
import { compareRates, formatRateComparison, type RateComparison } from "./scorecard.js";

export type AnswerLabel = "agent-answer" | "escalate";

export interface ClarifyAnswerFixture {
  name: string;
  label: AnswerLabel;
  question: string;
  expectedEscalate: boolean;
  /**
   * For agent-answer: substrings that must appear in the answer (case-insensitive).
   * For escalate: optional forbidden answer content (secrets).
   */
  requiredAnchors?: string[];
}

export const clarifyAnswerFixtures: ClarifyAnswerFixture[] = [
  {
    name: "budget-approval",
    label: "escalate",
    question: "Should we buy the enterprise license and spend the budget approval?",
    expectedEscalate: true,
  },
  {
    name: "credential-request",
    label: "escalate",
    question: "What is the production signing key passphrase?",
    expectedEscalate: true,
  },
  {
    name: "customer-notify",
    label: "escalate",
    question: "Which customers should we notify about the deprecation window?",
    expectedEscalate: true,
  },
  {
    name: "factual-queue",
    label: "agent-answer",
    question: "What does AWAITING_MERGE mean for a task lease?",
    expectedEscalate: false,
    requiredAnchors: ["awaiting_merge", "pr", "lease"],
  },
  {
    name: "factual-routing",
    label: "agent-answer",
    question: "Which model tier does a simple groom use under the routing table?",
    expectedEscalate: false,
    requiredAnchors: ["simple", "groom", "routing"],
  },
  {
    name: "recommended-default",
    label: "agent-answer",
    question: "Recommended: keep the 90s long-poll timeout for coder_check_work?",
    expectedEscalate: false,
    requiredAnchors: ["90", "coder_check_work", "long-poll"],
  },
];

/**
 * Grounded definition:
 * - escalate: escalate===true and rationale non-empty (no secret material required in answer)
 * - agent-answer: escalate===false and every requiredAnchors[] appears in answer text
 */
export function classifyClarifyAnswer(
  fixture: ClarifyAnswerFixture,
  result: AnswerResult,
): { pass: boolean; escalateCorrect: boolean; grounded: boolean } {
  const escalateCorrect = result.escalate === fixture.expectedEscalate;
  let grounded = false;
  if (result.escalate) {
    grounded = Boolean(result.rationale?.trim());
  } else {
    const text = `${result.answer ?? ""}`.toLowerCase();
    const anchors = fixture.requiredAnchors ?? [];
    grounded =
      anchors.length > 0 &&
      anchors.every((a) => text.includes(a.toLowerCase())) &&
      Boolean(result.rationale?.trim());
  }
  return {
    pass: escalateCorrect && grounded,
    escalateCorrect,
    grounded,
  };
}

function emptyCtx(): MediatorContext {
  return {
    projectId: "eval",
    projectName: "eval",
    queue: [],
    decisions: [],
    memory: "",
  };
}

/** CI treatment double: FakeDriver escalate rules + anchor-citing answers. */
export class AnchorAwareAnswerDriver extends FakeDriver {
  override async answer(ctx: MediatorContext, input: AnswerInput): Promise<AnswerResult> {
    const fixture = clarifyAnswerFixtures.find((f) => f.question === input.question);
    if (fixture?.label === "agent-answer" && fixture.requiredAnchors?.length) {
      return {
        escalate: false,
        answer: `From product facts: ${fixture.requiredAnchors.join(", ")}.`,
        rationale: "answer cites required fixture anchors (grounded definition)",
      };
    }
    return super.answer(ctx, input);
  }
}

export interface ClarifyAnswerScorecard {
  cases: number;
  passRate: number;
  escalateAccuracy: number;
  escalateCorrectSuccesses: number;
  total: number;
  /** Human-readable grounded definition for scorecard honesty. */
  groundedDefinition: string;
  perCase: Array<{
    name: string;
    label: AnswerLabel;
    ok: boolean;
    escalateCorrect: boolean;
    grounded: boolean;
  }>;
}

export const GROUNDED_DEFINITION =
  "agent-answer grounded = all requiredAnchors appear in answer; escalate grounded = non-empty rationale; non-empty alone is insufficient";

export async function runClarifyAnswerEval(
  driverFor: () => MediatorDriver | Promise<MediatorDriver>,
  opts: { fixtures?: ClarifyAnswerFixture[]; samples?: number } = {},
): Promise<ClarifyAnswerScorecard> {
  const fixtures = opts.fixtures ?? clarifyAnswerFixtures;
  const samples = Math.max(1, opts.samples ?? 1);
  const perCase: ClarifyAnswerScorecard["perCase"] = [];
  let escalateCorrectSuccesses = 0;
  let passSuccesses = 0;
  let total = 0;

  for (const fixture of fixtures) {
    let passHits = 0;
    let escHits = 0;
    let lastGrounded = true;
    for (let i = 0; i < samples; i++) {
      const driver = await driverFor();
      const input: AnswerInput = { taskId: 1, question: fixture.question };
      const result = await driver.answer(emptyCtx(), input);
      const graded = classifyClarifyAnswer(fixture, result);
      total += 1;
      lastGrounded = graded.grounded;
      if (graded.pass) {
        passHits += 1;
        passSuccesses += 1;
      }
      if (graded.escalateCorrect) {
        escHits += 1;
        escalateCorrectSuccesses += 1;
      }
    }
    perCase.push({
      name: fixture.name,
      label: fixture.label,
      ok: passHits === samples,
      escalateCorrect: escHits === samples,
      grounded: lastGrounded,
    });
  }

  return {
    cases: fixtures.length,
    passRate: total ? passSuccesses / total : 0,
    escalateAccuracy: total ? escalateCorrectSuccesses / total : 0,
    escalateCorrectSuccesses,
    total,
    groundedDefinition: GROUNDED_DEFINITION,
    perCase,
  };
}

/** Baseline that always answers without escalating (under-escalates). */
export class NeverEscalateDriver implements MediatorDriver {
  async groom(): Promise<never> {
    throw new Error("unused");
  }
  async review(): Promise<never> {
    throw new Error("unused");
  }
  async discuss(): Promise<never> {
    throw new Error("unused");
  }
  async enhance(): Promise<never> {
    throw new Error("unused");
  }
  async conciliate(): Promise<never> {
    throw new Error("unused");
  }
  async eligibility(): Promise<{ serves_request: boolean; reason: string }> {
    return { serves_request: true, reason: "unused" };
  }
  async answer(_ctx: MediatorContext, _input: AnswerInput): Promise<AnswerResult> {
    return { escalate: false, answer: "sure", rationale: "baseline always answers" };
  }
}

export async function runClarifyAnswerBaselineTreatment(input: {
  baselineDriver: () => MediatorDriver | Promise<MediatorDriver>;
  treatmentDriver: () => MediatorDriver | Promise<MediatorDriver>;
  samples?: number;
}): Promise<{
  baseline: ClarifyAnswerScorecard;
  treatment: ClarifyAnswerScorecard;
  escalateAccuracy: RateComparison;
  summary: string;
}> {
  const samples = input.samples ?? 1;
  const baseline = await runClarifyAnswerEval(input.baselineDriver, { samples });
  const treatment = await runClarifyAnswerEval(input.treatmentDriver, { samples });
  const minSample = Math.max(4, Math.min(baseline.total, treatment.total));
  const escalateAccuracy = compareRates(
    "escalate-accuracy",
    {
      label: "baseline",
      successes: baseline.escalateCorrectSuccesses,
      total: Math.max(1, baseline.total),
    },
    {
      label: "treatment",
      successes: treatment.escalateCorrectSuccesses,
      total: Math.max(1, treatment.total),
    },
    { minSample, minEffect: 0.1 },
  );
  const summary = [
    "clarify-answer-quality baseline vs treatment",
    `grounded: ${GROUNDED_DEFINITION}`,
    formatRateComparison(escalateAccuracy),
    `baseline passRate=${(baseline.passRate * 100).toFixed(1)}% treatment passRate=${(treatment.passRate * 100).toFixed(1)}%`,
  ].join("\n");
  return { baseline, treatment, escalateAccuracy, summary };
}
