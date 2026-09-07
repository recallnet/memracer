/**
 * Shared model-family classification for Frigg scorecards.
 * Used by server sort order (analytics) and client color slots (dashboard web).
 * Keep this module free of DB / React deps so both sides can import it.
 */

/** Visual family for scorecard/routing color slots. Unattributed ("unknown") is not "other". */
export type ModelFamily = "gemini" | "glm" | "other" | "unknown";

export const MODEL_FAMILY_ORDER: Record<ModelFamily, number> = {
  gemini: 0,
  glm: 1,
  other: 2,
  unknown: 3,
};

/** Classify a resolved model label into a stable family for sort + color. */
export function modelFamily(model: string): ModelFamily {
  const normalized = model.trim().toLowerCase();
  if (!normalized || normalized === "unknown") return "unknown";
  if (normalized.includes("gemini")) return "gemini";
  if (normalized.includes("glm")) return "glm";
  return "other";
}

/** Stable segment order across bars: family rank, then model name. Never completions. */
export function compareScorecardModels(left: string, right: string): number {
  const familyDelta = MODEL_FAMILY_ORDER[modelFamily(left)] - MODEL_FAMILY_ORDER[modelFamily(right)];
  if (familyDelta !== 0) return familyDelta;
  return left.localeCompare(right);
}
