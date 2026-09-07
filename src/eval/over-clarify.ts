import {
  groomPostureFixtures,
  runGroomPostureEval,
  type GroomPostureCaseResult,
  type GroomPostureEvalOptions,
} from "./groom-posture.js";

export interface OverClarifyScorecard {
  defaultableCases: number;
  clarifications: number;
  penalty: number;
  failed: number;
  perCase: GroomPostureCaseResult[];
  genuineDecisionProtected: boolean;
}

/** A hard gate: each defaultable clarification adds one penalty and fails. */
export async function runOverClarifyEval(options: GroomPostureEvalOptions = {}): Promise<OverClarifyScorecard> {
  const card = await runGroomPostureEval(options);
  const names = new Set(groomPostureFixtures.filter((fixture) => fixture.defaultable).map((fixture) => fixture.name));
  const perCase = card.perCase.filter((result) => names.has(result.name));
  const clarifications = perCase.filter((result) => result.actual === "clarify").length;
  const genuineDecisionProtected = card.perCase.some(
    (result) => result.name === "genuine-decision" && result.actual === "clarify" && result.ok,
  );
  const failedCases = perCase.filter((result) => !result.ok).length;
  return {
    defaultableCases: perCase.length,
    clarifications,
    penalty: clarifications,
    failed: failedCases + (genuineDecisionProtected ? 0 : 1) + card.promptFailures.length,
    perCase,
    genuineDecisionProtected,
  };
}
