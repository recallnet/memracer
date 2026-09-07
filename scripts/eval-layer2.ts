#!/usr/bin/env tsx
/**
 * Layer 2 eval library scorecard.
 *
 * Default (CI): FakeDriver + eval doubles vs blind baselines.
 *   Proves classifiers/fixtures/wiring — not production Frigg quality.
 *
 * --real + OPENROUTER_API_KEY: OpenRouter treatment for eligibility + answer.
 *   OKF-curation treatment stays FakeDriver (not live-model OKF quality).
 *   Fixtures have no DRIFT cheat tokens; eligibility uses subject-token overlap.
 */
import { FakeDriver } from "../src/mediator/fake.js";
import { OpenRouterDriver } from "../src/mediator/openrouter.js";
import { runLayer2Library, DriftBlindEligibilityDriver } from "../src/eval/layer2-library.js";
import { runGroomFidelityBaselineTreatment } from "../src/eval/groom-fidelity.js";
import { ConfabulatingKnowledgeDriver, runOkfCurationBaselineTreatment } from "../src/eval/okf-curation-faithfulness.js";
import { NeverEscalateDriver, runClarifyAnswerBaselineTreatment } from "../src/eval/clarify-answer-quality.js";

function parseSamples(argv: string[]): number {
  const flag = argv.find((a) => a.startsWith("--samples="));
  if (!flag) return 1;
  const n = Number(flag.slice("--samples=".length));
  if (!Number.isInteger(n) || n < 1) throw new Error("--samples must be a positive integer");
  return Math.min(10, n);
}

async function main() {
  const real = process.argv.includes("--real");
  const samples = parseSamples(process.argv);

  if (!real) {
    const lib = await runLayer2Library({ samples });
    console.log(lib.summary);
    process.exit(0);
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error("OPENROUTER_API_KEY required for --real");
    process.exit(2);
  }
  const model = "z-ai/glm-5.2";
  console.error(`[layer2] real-model treatment model=${model} samples=${samples}`);

  const treatment = () =>
    new OpenRouterDriver(apiKey, model, undefined, {
      cacheSessionId: `memracer:layer2:treatment:${Date.now()}`,
    });

  const groom = await runGroomFidelityBaselineTreatment({
    baselineDriver: () => new DriftBlindEligibilityDriver(),
    treatmentDriver: treatment,
    samples,
  });
  // Knowledge refresh on real models is expensive/unstable; keep confab A/B on fakes.
  const okf = await runOkfCurationBaselineTreatment({
    baselineDriver: () => new ConfabulatingKnowledgeDriver(),
    treatmentDriver: () => new FakeDriver(),
    samples,
  });
  const answer = await runClarifyAnswerBaselineTreatment({
    baselineDriver: () => new NeverEscalateDriver(),
    treatmentDriver: treatment,
    samples,
  });

  console.log(
    [
      "=== Layer 2 eval library (OpenRouter treatment on groom+answer; FakeDriver OKF) ===",
      groom.summary,
      "",
      okf.summary,
      "",
      answer.summary,
    ].join("\n"),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
