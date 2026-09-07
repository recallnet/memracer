/**
 * Layer 2 behavior-eval library entrypoint.
 * Runs groom-fidelity, OKF-curation faithfulness, and clarify/answer quality
 * scorecards (FakeDriver treatment vs blind baselines).
 */
import { FakeDriver } from "../mediator/fake.js";
import type { MediatorDriver } from "../mediator/driver.js";
import {
  runGroomFidelityBaselineTreatment,
  runGroomFidelityEval,
} from "./groom-fidelity.js";
import {
  ConfabulatingKnowledgeDriver,
  runOkfCurationBaselineTreatment,
  runOkfCurationEval,
} from "./okf-curation-faithfulness.js";
import {
  AnchorAwareAnswerDriver,
  NeverEscalateDriver,
  runClarifyAnswerBaselineTreatment,
  runClarifyAnswerEval,
} from "./clarify-answer-quality.js";

/** Baseline eligibility that always says the brief serves the request (misses drift). */
export class DriftBlindEligibilityDriver extends FakeDriver {
  override async eligibility(): Promise<{ serves_request: boolean; reason: string }> {
    return { serves_request: true, reason: "baseline always serves_request=true (blind)" };
  }
}

/**
 * CI default: FakeDriver / eval doubles only.
 * Proves pattern + classifier wiring — not production Frigg quality.
 * Use `pnpm eval:layer2 --real` for OpenRouter arms on eligibility/answer.
 */
export async function runLayer2Library(opts: {
  samples?: number;
} = {}): Promise<{
  summary: string;
  groomFidelity: Awaited<ReturnType<typeof runGroomFidelityBaselineTreatment>>;
  okfCuration: Awaited<ReturnType<typeof runOkfCurationBaselineTreatment>>;
  clarifyAnswer: Awaited<ReturnType<typeof runClarifyAnswerBaselineTreatment>>;
}> {
  const samples = opts.samples ?? 1;
  const treatmentGroom = () => new FakeDriver() as MediatorDriver;
  const treatmentOkf = () => new FakeDriver() as MediatorDriver;
  const treatmentAnswer = () => new AnchorAwareAnswerDriver() as MediatorDriver;

  const groomFidelity = await runGroomFidelityBaselineTreatment({
    baselineDriver: () => new DriftBlindEligibilityDriver(),
    treatmentDriver: treatmentGroom,
    samples,
  });
  const okfCuration = await runOkfCurationBaselineTreatment({
    baselineDriver: () => new ConfabulatingKnowledgeDriver(),
    treatmentDriver: treatmentOkf,
    samples,
  });
  const clarifyAnswer = await runClarifyAnswerBaselineTreatment({
    baselineDriver: () => new NeverEscalateDriver(),
    treatmentDriver: treatmentAnswer,
    samples,
  });

  const summary = [
    "=== Layer 2 eval library ===",
    "arm: FakeDriver / eval doubles (CI). Not a live-model quality certificate.",
    "OKF treatment remains FakeDriver even under --real unless extended.",
    groomFidelity.summary,
    "",
    okfCuration.summary,
    "",
    clarifyAnswer.summary,
  ].join("\n");

  return { summary, groomFidelity, okfCuration, clarifyAnswer };
}

/** CI smoke: treatment doubles alone must fully pass each dimension. */
export async function runLayer2TreatmentSmoke(): Promise<{
  groomPassRate: number;
  okfPassRate: number;
  answerPassRate: number;
  ok: boolean;
}> {
  const groom = await runGroomFidelityEval(() => new FakeDriver());
  const okf = await runOkfCurationEval(() => new FakeDriver());
  const answer = await runClarifyAnswerEval(() => new AnchorAwareAnswerDriver());
  return {
    groomPassRate: groom.passRate,
    okfPassRate: okf.passRate,
    answerPassRate: answer.passRate,
    ok: groom.passRate === 1 && okf.passRate === 1 && answer.passRate === 1,
  };
}
