export const MAX_RETRY_MS = 30_000;

export function jitteredRetryDelay(
  delayMs: number,
  random: () => number = Math.random,
): number {
  const factor = 0.8 + Math.min(1, Math.max(0, random())) * 0.4;
  return Math.min(MAX_RETRY_MS, Math.max(0, Math.round(delayMs * factor)));
}
