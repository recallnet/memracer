/**
 * OKF-curation faithfulness eval (Frigg improvement Layer 2 brick 3).
 * Does knowledge refresh persist what it claims — checked domains only —
 * without confabulating durable writes / invented human questions?
 *
 * CI uses FakeDriver treatment vs a confabulating baseline.
 */
import type {
  MediatorContext,
  MediatorDriver,
  ProjectKnowledgeRefreshInput,
  ProjectKnowledgeRefreshResult,
} from "../mediator/driver.js";
import type { ProjectKnowledgeCandidate, ProjectKnowledgeDomain } from "../mediator/project-knowledge.js";
import { compareRates, formatRateComparison, type RateComparison } from "./scorecard.js";

export type OkfLabel = "faithful" | "confabulate";

export interface OkfCurationFixture {
  name: string;
  label: OkfLabel;
  input: ProjectKnowledgeRefreshInput;
  expected: {
    allowedDomains: ProjectKnowledgeDomain[];
    maxQuestions: number;
  };
}

function candidate(
  domain: ProjectKnowledgeDomain,
  label: string,
): ProjectKnowledgeCandidate {
  return {
    domain,
    label,
    description: label,
    last_refreshed_at: null,
    last_checked_at: null,
    triggers: ["TIME"],
    reasons: ["eval"],
    concepts: [],
    open_question: null,
    event_generation: 0,
  };
}

const CANDIDATES: ProjectKnowledgeCandidate[] = [
  candidate("architecture-tech", "Architecture"),
  candidate("operational-external", "Operations"),
  candidate("history-decisions-learnings", "History"),
];

export const okfCurationFixtures: OkfCurationFixture[] = [
  {
    name: "top-ranked-only",
    label: "faithful",
    input: { candidates: CANDIDATES, repo: "recallnet/memracer" },
    expected: {
      allowedDomains: ["architecture-tech", "operational-external", "history-decisions-learnings"],
      maxQuestions: 0,
    },
  },
  {
    name: "answered-domain-first",
    label: "faithful",
    input: {
      candidates: CANDIDATES,
      repo: "recallnet/memracer",
      answer: {
        question_id: 1,
        question: "Keep the poller?",
        answer: "yes",
        domain: "operational-external",
      },
    },
    expected: {
      allowedDomains: ["architecture-tech", "operational-external", "history-decisions-learnings"],
      maxQuestions: 0,
    },
  },
  {
    name: "empty-candidates",
    label: "faithful",
    input: { candidates: [], repo: null },
    expected: { allowedDomains: [], maxQuestions: 0 },
  },
  {
    name: "must-not-invent-questions",
    label: "confabulate",
    input: { candidates: CANDIDATES, repo: "recallnet/memracer" },
    expected: {
      allowedDomains: ["architecture-tech", "operational-external", "history-decisions-learnings"],
      maxQuestions: 0,
    },
  },
  {
    name: "must-not-claim-unknown-domain",
    label: "confabulate",
    input: { candidates: CANDIDATES.slice(0, 1), repo: "recallnet/memracer" },
    expected: { allowedDomains: ["architecture-tech"], maxQuestions: 0 },
  },
];

export function classifyOkfCuration(
  fixture: OkfCurationFixture,
  result: ProjectKnowledgeRefreshResult,
): { pass: boolean; noConfab: boolean } {
  const allowed = new Set<string>(fixture.expected.allowedDomains);
  const checkedOk = result.checked_domains.every((d) => allowed.has(d));
  const questionsOk = (result.questions?.length ?? 0) <= fixture.expected.maxQuestions;
  const invented = !checkedOk || !questionsOk;
  // For both labels, a clean result is a pass (treatment FakeDriver stays clean).
  // Confab baseline invents → fail. Scorecard confabFreeRate tracks cleanliness.
  return { pass: !invented, noConfab: !invented };
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

export interface OkfCurationScorecard {
  cases: number;
  passRate: number;
  confabFreeRate: number;
  confabFreeSuccesses: number;
  total: number;
  perCase: Array<{ name: string; label: OkfLabel; ok: boolean; noConfab: boolean }>;
}

export async function runOkfCurationEval(
  driverFor: () => MediatorDriver | Promise<MediatorDriver>,
  opts: { fixtures?: OkfCurationFixture[]; samples?: number } = {},
): Promise<OkfCurationScorecard> {
  const fixtures = opts.fixtures ?? okfCurationFixtures;
  const samples = Math.max(1, opts.samples ?? 1);
  const perCase: OkfCurationScorecard["perCase"] = [];
  let confabFreeSuccesses = 0;
  let passSuccesses = 0;
  let total = 0;

  for (const fixture of fixtures) {
    let passHits = 0;
    let freeHits = 0;
    for (let i = 0; i < samples; i++) {
      const driver = await driverFor();
      if (!driver.refreshProjectKnowledge) {
        throw new Error("driver missing refreshProjectKnowledge");
      }
      const result = await driver.refreshProjectKnowledge(emptyCtx(), fixture.input);
      const graded = classifyOkfCuration(fixture, result);
      total += 1;
      if (graded.pass) {
        passHits += 1;
        passSuccesses += 1;
      }
      if (graded.noConfab) {
        freeHits += 1;
        confabFreeSuccesses += 1;
      }
    }
    perCase.push({
      name: fixture.name,
      label: fixture.label,
      ok: passHits === samples,
      noConfab: freeHits === samples,
    });
  }

  return {
    cases: fixtures.length,
    passRate: total ? passSuccesses / total : 0,
    confabFreeRate: total ? confabFreeSuccesses / total : 0,
    confabFreeSuccesses,
    total,
    perCase,
  };
}

/** Baseline that confabulates — invents questions and claims unknown domains. */
export class ConfabulatingKnowledgeDriver implements MediatorDriver {
  async groom(): Promise<never> {
    throw new Error("unused");
  }
  async review(): Promise<never> {
    throw new Error("unused");
  }
  async answer(): Promise<never> {
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
  async refreshProjectKnowledge(
    _ctx: MediatorContext,
    input: ProjectKnowledgeRefreshInput,
  ): Promise<ProjectKnowledgeRefreshResult> {
    const known = input.candidates.map((c) => c.domain);
    return {
      // Claim a domain that was never a candidate (confabulation).
      checked_domains: [...known, "preferences-felt-experience"],
      questions: [
        {
          domain: "preferences-felt-experience",
          trigger: "TIME",
          question: "Should we invent durable knowledge never in the corpus?",
        },
      ],
      rationale: "confabulated domains and questions",
    };
  }
}

export async function runOkfCurationBaselineTreatment(input: {
  baselineDriver: () => MediatorDriver | Promise<MediatorDriver>;
  treatmentDriver: () => MediatorDriver | Promise<MediatorDriver>;
  samples?: number;
}): Promise<{
  baseline: OkfCurationScorecard;
  treatment: OkfCurationScorecard;
  confabFree: RateComparison;
  summary: string;
}> {
  const samples = input.samples ?? 1;
  const baseline = await runOkfCurationEval(input.baselineDriver, { samples });
  const treatment = await runOkfCurationEval(input.treatmentDriver, { samples });
  const minSample = Math.max(4, Math.min(baseline.total, treatment.total));
  const confabFree = compareRates(
    "confab-free",
    {
      label: "baseline",
      successes: baseline.confabFreeSuccesses,
      total: Math.max(1, baseline.total),
    },
    {
      label: "treatment",
      successes: treatment.confabFreeSuccesses,
      total: Math.max(1, treatment.total),
    },
    { minSample, minEffect: 0.1 },
  );
  const summary = [
    "okf-curation-faithfulness baseline vs treatment",
    formatRateComparison(confabFree),
    `baseline passRate=${(baseline.passRate * 100).toFixed(1)}% treatment passRate=${(treatment.passRate * 100).toFixed(1)}%`,
  ].join("\n");
  return { baseline, treatment, confabFree, summary };
}
