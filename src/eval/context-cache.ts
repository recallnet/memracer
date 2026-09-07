import type { CompletionUsage } from "../mediator/driver.js";

export interface ContextCacheReport {
  turns: number;
  promptTokens: number;
  cachedTokens: number;
  cacheReadByCompletion: number[];
  requestedModel: string | null;
  resolvedModel: string | null;
}

export function contextCacheReport(usage: CompletionUsage | undefined, minimumTurns: number): ContextCacheReport {
  if (!usage) throw new Error("context-cache eval received no provider usage");
  const reads = usage.cacheReadByCompletion ?? [];
  if (reads.length < minimumTurns) throw new Error(`context-cache eval expected at least ${minimumTurns} completions, received ${reads.length}`);
  return {
    turns: reads.length,
    promptTokens: usage.promptTokens,
    cachedTokens: usage.cachedTokens ?? 0,
    cacheReadByCompletion: reads,
    requestedModel: usage.requestedModel ?? null,
    resolvedModel: usage.resolvedModel ?? null,
  };
}

export function assertPinnedGlmCache(report: ContextCacheReport): void {
  if (report.requestedModel !== "z-ai/glm-5.2" || report.resolvedModel !== "z-ai/glm-5.2") {
    throw new Error(`context-cache canary must stay pinned to z-ai/glm-5.2; got ${report.requestedModel} -> ${report.resolvedModel}`);
  }
  const misses = report.cacheReadByCompletion.slice(1, 6).flatMap((tokens, index) => tokens > 0 ? [] : [index + 2]);
  if (misses.length > 0) throw new Error(`context-cache canary missed cached_tokens on turns ${misses.join(", ")}`);
}
