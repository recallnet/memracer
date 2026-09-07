#!/usr/bin/env tsx
/**
 * On-demand review-fidelity scorecard.
 * Default: FakeDriver treatment vs baseline that ignores wholeness (CI-safe).
 * With OPENROUTER_API_KEY + --real: real GLM baseline (no wholeness bar) vs
 * treatment (with bar), N stochastic samples per fixture.
 */
import { FakeDriver } from "../src/mediator/fake.js";
import type { MediatorDriver, ReviewInput, ReviewResult } from "../src/mediator/driver.js";
import { OpenRouterDriver } from "../src/mediator/openrouter.js";
import { buildReviewPrompt } from "../src/mediator/prompts.js";
import {
  runReviewFidelityBaselineTreatment,
  runReviewFidelityEval,
} from "../src/eval/review-fidelity.js";

class BaselineReviewDriver implements MediatorDriver {
  async groom() { throw new Error("unused"); }
  async review(_ctx: unknown, input: ReviewInput): Promise<ReviewResult> {
    if (/\bbad\b/.test(input.plan)) {
      return { verdict: "revise", feedback: "bad", rationale: "bad" };
    }
    return { verdict: "approved", feedback: "", rationale: "baseline ignores wholeness" };
  }
  async answer() { throw new Error("unused"); }
  async discuss() { throw new Error("unused"); }
  async conciliate() { throw new Error("unused"); }
  async enhance() { throw new Error("unused"); }
  async refreshProjectKnowledge() { throw new Error("unused"); }
}

export function parseSamples(argv: string[]): number {
  const flag = argv.find((a) => a.startsWith("--samples="));
  if (!flag) return 3;
  const n = Number(flag.slice("--samples=".length));
  if (!Number.isInteger(n) || n < 1) throw new Error("--samples must be a positive integer");
  return Math.min(10, n);
}

export function buildRealDrivers(apiKey: string, model = "z-ai/glm-5.2"): {
  baselineDriver: () => MediatorDriver;
  treatmentDriver: () => MediatorDriver;
} {
  return {
    baselineDriver: () =>
      new OpenRouterDriver(apiKey, model, undefined, {
        reviewPromptBuilder: (ctx, input) => buildReviewPrompt(ctx, input, { wholenessBar: false }),
        cacheSessionId: `memracer:review-fidelity:baseline:${Date.now()}`,
      }),
    treatmentDriver: () =>
      new OpenRouterDriver(apiKey, model, undefined, {
        reviewPromptBuilder: (ctx, input) => buildReviewPrompt(ctx, input, { wholenessBar: true }),
        cacheSessionId: `memracer:review-fidelity:treatment:${Date.now()}`,
      }),
  };
}

async function main() {
  const real = process.argv.includes("--real");
  const samples = parseSamples(process.argv);

  if (real) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      console.error("OPENROUTER_API_KEY required for --real");
      process.exit(2);
    }
    const { baselineDriver, treatmentDriver } = buildRealDrivers(apiKey);
    console.error(`[review-fidelity] real-model A/B model=z-ai/glm-5.2 samples/fixture=${samples}`);
    const ab = await runReviewFidelityBaselineTreatment({
      baselineDriver,
      treatmentDriver,
      samples,
    });
    console.log(ab.summary);
    console.log(JSON.stringify({
      hollowRecall: ab.hollowRecall.zTest,
      wholePrecision: ab.wholePrecision.zTest,
      clarifyRate: ab.clarifyRate.zTest,
      significantImprovement: ab.hollowRecall.significantImprovement,
      wholePrecisionRegression: ab.wholePrecision.significantRegression,
      clarifyRegression: ab.clarifyRate.significantImprovement, // higher clarify under treatment is bad
      treatment: {
        hollowRecall: ab.treatment.hollowRecall,
        wholePrecision: ab.treatment.wholePrecision,
        clarifyRate: ab.treatment.clarifyRate,
        passRate: ab.treatment.passRate,
      },
      baseline: {
        hollowRecall: ab.baseline.hollowRecall,
        wholePrecision: ab.baseline.wholePrecision,
        clarifyRate: ab.baseline.clarifyRate,
        passRate: ab.baseline.passRate,
      },
    }, null, 2));
    return;
  }

  const treatment = await runReviewFidelityEval(() => new FakeDriver());
  console.log(JSON.stringify({ treatment }, null, 2));

  const ab = await runReviewFidelityBaselineTreatment({
    baselineDriver: () => new BaselineReviewDriver() as unknown as MediatorDriver,
    treatmentDriver: () => new FakeDriver(),
  });
  console.log(ab.summary);
  console.log(JSON.stringify({
    hollowRecall: ab.hollowRecall.zTest,
    wholePrecision: ab.wholePrecision.zTest,
    clarifyRate: ab.clarifyRate.zTest,
    significantImprovement: ab.hollowRecall.significantImprovement,
  }, null, 2));
}

const isMain = process.argv[1]?.includes("eval-review-fidelity");
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
