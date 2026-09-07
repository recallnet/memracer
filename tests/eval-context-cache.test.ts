import { describe, expect, it } from "vitest";
import { assertPinnedGlmCache, contextCacheReport } from "../src/eval/context-cache.js";
import { promptSavings } from "../src/eval/context-cache-scorecard.js";

describe("context-cache eval gate", () => {
  it("requires six provider observations and cache reads on turns 2-6", () => {
    const report = contextCacheReport({
      promptTokens: 600,
      completionTokens: 60,
      cachedTokens: 400,
      cacheReadByCompletion: [0, 80, 80, 80, 80, 80],
      requestedModel: "z-ai/glm-5.2",
      resolvedModel: "z-ai/glm-5.2",
    }, 6);
    expect(() => assertPinnedGlmCache(report)).not.toThrow();
    expect(() => assertPinnedGlmCache({ ...report, cacheReadByCompletion: [0, 80, 0, 80, 80, 80] })).toThrow(/turns 3/);
    expect(() => assertPinnedGlmCache({ ...report, resolvedModel: "openrouter/auto" })).toThrow(/pinned/);
    expect(() => contextCacheReport({ promptTokens: 1, completionTokens: 1, cacheReadByCompletion: [0] }, 6)).toThrow(/at least 6/);
  });

  it("reports the measured pre-cache token reduction", () => {
    expect(promptSavings()).toEqual({ tokens: 798, rate: 798 / 3_699 });
  });
});
