#!/usr/bin/env tsx
/**
 * Fix/chore over-clarify scorecard (task #488).
 * Default: FakeDriver treatment (pre-class) vs baseline FakeDriver that always
 * reshape-clarifies — CI-safe proof of the pre-classifier delta.
 * With OPENROUTER_API_KEY + --real: real GLM baseline (no pre-route) vs
 * treatment (pre-classifier), N samples per fixture.
 */
import { FakeDriver } from "../src/mediator/fake.js";
import type { MediatorContext, Submission } from "../src/mediator/driver.js";
import { OpenRouterDriver } from "../src/mediator/openrouter.js";
import {
  fixChoreOverClarifyFixtures,
  runFixChoreBaselineTreatment,
} from "../src/eval/fix-chore-over-clarify.js";

/** Baseline FakeDriver: always issues an invisible-slice reshape clarify. */
class AlwaysReshapeDriver extends FakeDriver {
  override async groom(_ctx: MediatorContext, _s: Submission) {
    return {
      action: "clarify" as const,
      question:
        "What visible, usable delivery should complete this backend-only feature slice? Recommended: reshape it as a working vertical whose acceptance names how a human observes or uses the result.",
      rationale:
        "invisible/backend-only feature slice; DONE requires observable, usable value — reshape into a working vertical",
    };
  }
}

export function parseSamples(argv: string[]): number {
  const flag = argv.find((a) => a.startsWith("--samples="));
  if (!flag) return 2;
  const n = Number(flag.slice("--samples=".length));
  if (!Number.isInteger(n) || n < 1) throw new Error("--samples must be a positive integer");
  return Math.min(10, n);
}

async function main() {
  const real = process.argv.includes("--real");
  const samples = parseSamples(process.argv);
  const fixtures = fixChoreOverClarifyFixtures;

  if (real) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      console.error("OPENROUTER_API_KEY required for --real");
      process.exit(2);
    }
    const model = "z-ai/glm-5.2";
    console.error(`[fix-chore-over-clarify] real-model A/B model=${model} samples/fixture=${samples}`);
    const ab = await runFixChoreBaselineTreatment({
      baselineDriver: () =>
        new OpenRouterDriver(apiKey, model, undefined, {
          cacheSessionId: `memracer:fix-chore:baseline:${Date.now()}`,
        }),
      // Treatment uses the real model for non-fix/chore fixtures; pre-class
      // short-circuits fix/chore inside runFixChoreArm("treatment").
      treatmentDriver: () =>
        new OpenRouterDriver(apiKey, model, undefined, {
          cacheSessionId: `memracer:fix-chore:treatment:${Date.now()}`,
        }),
      fixtures,
      samples,
    });
    console.log(ab.summary);
    console.log(
      JSON.stringify(
        {
          baseline: {
            fixChoreReshapeRate: ab.baseline.fixChoreReshapeRate,
            featureReshapeRate: ab.baseline.featureReshapeRate,
            perCase: ab.baseline.perCase,
          },
          treatment: {
            fixChoreReshapeRate: ab.treatment.fixChoreReshapeRate,
            featureReshapeRate: ab.treatment.featureReshapeRate,
            gatePass: ab.treatment.gatePass,
            perCase: ab.treatment.perCase,
          },
          fixChoreReshape: ab.fixChoreReshape,
          treatmentGatePass: ab.treatmentGatePass,
        },
        null,
        2,
      ),
    );
    process.exit(ab.treatmentGatePass ? 0 : 1);
  }

  const ab = await runFixChoreBaselineTreatment({
    baselineDriver: () => new AlwaysReshapeDriver(),
    // Same reshape driver: treatment pre-class skips it for fix/chore only.
    treatmentDriver: () => new AlwaysReshapeDriver(),
    fixtures,
    samples: 1,
  });
  console.log(ab.summary);
  console.log(
    JSON.stringify(
      {
        baseline: ab.baseline,
        treatment: ab.treatment,
        treatmentGatePass: ab.treatmentGatePass,
      },
      null,
      2,
    ),
  );
  process.exit(ab.treatmentGatePass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
