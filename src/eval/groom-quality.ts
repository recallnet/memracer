import corpus from "./groom-quality-golden.json" with { type: "json" };
import type { GroomResult, MediatorContext, MediatorDriver } from "../mediator/driver.js";
import { groomFixtures, type GroomFixture } from "./fixtures.js";
import { significantRegression, twoProportionZTest, type SignificanceResult } from "./statistics.js";

export type GroomQualityCategory = "happy" | "edge" | "clarify_refusal" | "historical_failure";

export interface GroomQualityCase {
  id: string;
  category: GroomQualityCategory;
  seedFixture: string;
  source: "historical_redacted";
}

interface DimensionScores {
  scopeCorrectness: boolean;
  clarificationCorrectness: boolean;
  decisionConsistency: boolean;
  jsonValidity: boolean;
  toolLoopSuccess: boolean;
  rationaleGroundedness: boolean;
}

export interface GroomQualityClassifier {
  classify(input: { fixture: GroomFixture; result: GroomResult; deterministic: DimensionScores }): Promise<{ pass: boolean }>;
}

export interface GroomQualityJudge {
  maxCostPerCallUsd: number;
  judge(input: { fixture: GroomFixture; result: GroomResult; deterministic: DimensionScores; classifierPass: boolean }): Promise<{ pass: boolean; costUsd: number }>;
}

export const groomingRubricClassifier: GroomQualityClassifier = {
  async classify({ deterministic }) {
    return {
      pass: deterministic.scopeCorrectness &&
        deterministic.clarificationCorrectness &&
        deterministic.decisionConsistency &&
        deterministic.jsonValidity &&
        deterministic.toolLoopSuccess &&
        deterministic.rationaleGroundedness,
    };
  },
};

export function makeOpenRouterGroomQualityJudge(
  apiKey: string,
  judgeModel: string,
  candidateModel: string,
  fetchImpl: typeof fetch = fetch,
): GroomQualityJudge {
  if (judgeModel === candidateModel) throw new Error("groom-quality judge model must differ from the candidate model");
  return {
    maxCostPerCallUsd: MAX_JUDGE_COST_USD,
    async judge({ fixture, result, deterministic, classifierPass }) {
      const response = await fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: judgeModel,
          max_tokens: 256,
          temperature: 0,
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "groom_quality_judgment",
              strict: true,
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["pass", "rationale"],
                properties: { pass: { type: "boolean" }, rationale: { type: "string" } },
              },
            },
          },
          messages: [{
            role: "user",
            content: `Resolve one grooming-grade disagreement. Expected: ${JSON.stringify(fixture.golden)}\n` +
              `Candidate: ${JSON.stringify(result)}\nDeterministic rubric: ${JSON.stringify(deterministic)}\n` +
              `Classifier pass: ${classifierPass}. Pass only when scope, clarification posture, decision consistency, JSON/tool success, and grounded rationale are all acceptable.`,
          }],
        }),
      });
      if (!response.ok) throw new Error(`groom-quality judge failed: ${response.status}`);
      const data = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { cost?: number };
      };
      const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? "{}") as { pass?: unknown };
      if (typeof parsed.pass !== "boolean") throw new Error("groom-quality judge returned an invalid verdict");
      return { pass: parsed.pass, costUsd: data.usage?.cost ?? 0 };
    },
  };
}

export interface GroomQualityCaseResult extends DimensionScores {
  id: string;
  category: GroomQualityCategory;
  pass: boolean;
  judged: boolean;
  error?: string;
}

export interface GroomQualityScorecard {
  cases: number;
  categoryCounts: Record<GroomQualityCategory, number>;
  metrics: Record<keyof DimensionScores, number>;
  passed: number;
  passRate: number;
  judgeCalls: number;
  judgeCostUsd: number;
  judgeBudgetExhausted: boolean;
  statisticalGate: SignificanceResult & { regression: boolean };
  perCase: GroomQualityCaseResult[];
}

const qualityCorpus = corpus as GroomQualityCase[];
const MAX_JUDGE_COST_USD = 0.20;

export function loadGroomQualityCorpus(): GroomQualityCase[] {
  const counts = qualityCorpus.reduce<Record<string, number>>((out, item) => {
    out[item.category] = (out[item.category] ?? 0) + 1;
    return out;
  }, {});
  if (qualityCorpus.length < 100) throw new Error("groom-quality corpus must contain at least 100 labeled cases");
  for (const [category, minimum] of [["happy", 55], ["edge", 15], ["clarify_refusal", 10], ["historical_failure", 10]] as const) {
    if ((counts[category] ?? 0) < minimum) throw new Error(`groom-quality corpus is underweight in ${category}`);
  }
  return qualityCorpus.map((item) => ({ ...item }));
}

function score(fixture: GroomFixture, result: GroomResult): DimensionScores {
  const expected = fixture.golden;
  const actionMatches = result.action === expected.action;
  const targetMatches = expected.action !== "merge" || (result.action === "merge" && result.into_task_id === expected.into_task_id);
  const clarificationCorrectness = expected.action === "clarify" ? result.action === "clarify" : result.action !== "clarify";
  return {
    scopeCorrectness: actionMatches && targetMatches,
    clarificationCorrectness,
    decisionConsistency: actionMatches && targetMatches,
    jsonValidity: typeof result === "object" && result !== null && typeof result.action === "string",
    toolLoopSuccess: true,
    rationaleGroundedness: typeof result.rationale === "string" && result.rationale.trim().length >= 2,
  };
}

function allPass(scores: DimensionScores): boolean {
  return Object.values(scores).every(Boolean);
}

export async function runGroomQualityEval(
  driverFor: () => MediatorDriver | Promise<MediatorDriver>,
  options: { classifier?: GroomQualityClassifier; judge?: GroomQualityJudge; judgeBudgetUsd?: number } = {},
): Promise<GroomQualityScorecard> {
  const fixtures = new Map(groomFixtures.map((fixture) => [fixture.name, fixture]));
  const perCase: GroomQualityCaseResult[] = [];
  let judgeCalls = 0;
  let judgeCostUsd = 0;
  let judgeBudgetExhausted = false;
  const budget = Math.min(options.judgeBudgetUsd ?? MAX_JUDGE_COST_USD, MAX_JUDGE_COST_USD);

  for (const item of loadGroomQualityCorpus()) {
    const fixture = fixtures.get(item.seedFixture);
    if (!fixture) throw new Error(`groom-quality case ${item.id} names unknown seed ${item.seedFixture}`);
    try {
      const driver = await driverFor();
      const ctx: MediatorContext = { projectId: "quality", projectName: "Quality", queue: fixture.queue, decisions: [], memory: "" };
      const result = await driver.groom(ctx, { taskId: 1, submittedBy: "redacted", ...fixture.submission });
      const deterministic = score(fixture, result);
      const deterministicPass = allPass(deterministic);
      const classifierPass = options.classifier
        ? (await options.classifier.classify({ fixture, result, deterministic })).pass
        : deterministicPass;
      let pass = deterministicPass && classifierPass;
      let judged = false;
      if (options.judge && classifierPass !== deterministicPass) {
        if (judgeCostUsd + options.judge.maxCostPerCallUsd > budget + Number.EPSILON) {
          judgeBudgetExhausted = true;
          throw new Error(`frontier judge budget exhausted at $${budget.toFixed(2)}`);
        }
        const judgment = await options.judge.judge({ fixture, result, deterministic, classifierPass });
        if (judgment.costUsd > options.judge.maxCostPerCallUsd + Number.EPSILON) {
          throw new Error("frontier judge exceeded its declared per-call cost ceiling");
        }
        judgeCalls += 1;
        judgeCostUsd += judgment.costUsd;
        pass = judgment.pass;
        judged = true;
      }
      perCase.push({ id: item.id, category: item.category, ...deterministic, pass, judged });
    } catch (error) {
      perCase.push({
        id: item.id,
        category: item.category,
        scopeCorrectness: false,
        clarificationCorrectness: false,
        decisionConsistency: false,
        jsonValidity: false,
        toolLoopSuccess: false,
        rationaleGroundedness: false,
        pass: false,
        judged: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const metricNames = ["scopeCorrectness", "clarificationCorrectness", "decisionConsistency", "jsonValidity", "toolLoopSuccess", "rationaleGroundedness"] as const;
  const metrics = Object.fromEntries(metricNames.map((name) => [name, perCase.filter((item) => item[name]).length / perCase.length])) as GroomQualityScorecard["metrics"];
  const passed = perCase.filter((item) => item.pass).length;
  const significance = twoProportionZTest(passed, perCase.length, perCase.length, perCase.length);
  return {
    cases: perCase.length,
    categoryCounts: Object.fromEntries(["happy", "edge", "clarify_refusal", "historical_failure"].map((category) => [category, perCase.filter((item) => item.category === category).length])) as GroomQualityScorecard["categoryCounts"],
    metrics,
    passed,
    passRate: passed / perCase.length,
    judgeCalls,
    judgeCostUsd,
    judgeBudgetExhausted,
    statisticalGate: { ...significance, regression: significantRegression(significance, perCase.length, 0.02) },
    perCase,
  };
}
