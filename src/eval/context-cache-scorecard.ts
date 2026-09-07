export const CONTEXT_CACHE_SCORECARD = {
  measuredAt: "2026-07-18T06:30:00.000Z",
  model: "z-ai/glm-5.2",
  baseline: {
    promptTokens: 3_699,
    liveQualityPassed: 99,
    liveQualityTotal: 100,
    statisticalRegression: false,
  },
  stages: {
    pullHistory: { promptTokens: 3_319, deterministicQualityPassed: 100, deterministicQualityTotal: 100 },
    relevantDecisions: { promptTokens: 2_901, deterministicQualityPassed: 100, deterministicQualityTotal: 100 },
    volatileTail: { promptTokens: 2_901, deterministicQualityPassed: 100, deterministicQualityTotal: 100 },
  },
  cacheCanaryGroom: {
    turns: 6,
    promptTokens: 17_040,
    cachedTokens: 13_760,
    cacheReadByCompletion: [0, 2_752, 2_752, 2_752, 2_752, 2_752],
  },
  cacheOnRehearsal: {
    turns: 6,
    promptTokens: 17_040,
    cachedTokens: 13_888,
    cacheReadByCompletion: [128, 2_752, 2_752, 2_752, 2_752, 2_752],
  },
  cacheCanaryReview: {
    turns: 6,
    promptTokens: 4_566,
    cachedTokens: 3_072,
    cacheReadByCompletion: [128, 128, 704, 704, 704, 704],
  },
} as const;

export function promptSavings(): { tokens: number; rate: number } {
  const baseline = CONTEXT_CACHE_SCORECARD.baseline.promptTokens;
  const current = CONTEXT_CACHE_SCORECARD.stages.volatileTail.promptTokens;
  return { tokens: baseline - current, rate: (baseline - current) / baseline };
}
