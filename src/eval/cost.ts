export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface ModelPricing {
  promptPerToken: number;
  completionPerToken: number;
}

export async function fetchModelPricing(
  model: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelPricing | null> {
  const res = await fetchImpl("https://openrouter.ai/api/v1/models");
  if (!res.ok) throw new Error(`openrouter models listing failed: ${res.status}`);
  const data = (await res.json()) as { data: { id: string; pricing?: { prompt?: string; completion?: string } }[] };
  const entry = data.data.find((m) => m.id === model);
  if (!entry?.pricing?.prompt || !entry.pricing.completion) return null;
  return {
    promptPerToken: Number(entry.pricing.prompt),
    completionPerToken: Number(entry.pricing.completion),
  };
}

export interface CostTracker {
  meter: (u: TokenUsage) => void;
  /** Mean cost per job * 100; null when pricing is unknown or nothing was metered. */
  costPer100Jobs: (jobCount: number) => number | null;
}

export function createCostTracker(pricing: ModelPricing | null): CostTracker {
  let promptTokens = 0;
  let completionTokens = 0;
  let metered = false;
  return {
    meter(u) {
      metered = true;
      promptTokens += u.promptTokens;
      completionTokens += u.completionTokens;
    },
    costPer100Jobs(jobCount) {
      if (!pricing || !metered || jobCount === 0) return null;
      const total = promptTokens * pricing.promptPerToken + completionTokens * pricing.completionPerToken;
      return (total / jobCount) * 100;
    },
  };
}
