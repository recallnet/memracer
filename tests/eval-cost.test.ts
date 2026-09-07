import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenRouterDriver } from "../src/mediator/openrouter.js";
import type { MediatorContext } from "../src/mediator/driver.js";
import { createCostTracker, fetchModelPricing } from "../src/eval/cost.js";

const ctx: MediatorContext = { projectId: "p", projectName: "P", queue: [], decisions: [], memory: "" };

afterEach(() => vi.unstubAllGlobals());

describe("OpenRouterDriver meter", () => {
  it("reports usage to the meter when the response carries it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ verdict: "approved", feedback: "", rationale: "r" }) } }],
        usage: { prompt_tokens: 120, completion_tokens: 45 },
      }),
      text: async () => "",
    })));
    const meter = vi.fn();
    const d = new OpenRouterDriver("k", "m", undefined, { meter });
    await d.review(ctx, { taskId: 1, task: { title: "t", body: "b", groomingRationale: "g" }, plan: "p" });
    expect(meter).toHaveBeenCalledWith({
      promptTokens: 120,
      completionTokens: 45,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      completionCount: 1,
      requestedModel: "m",
      resolvedModel: "m",
    });
  });

  it("does not call the meter when usage is absent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ verdict: "approved", feedback: "", rationale: "r" }) } }],
      }),
      text: async () => "",
    })));
    const meter = vi.fn();
    const d = new OpenRouterDriver("k", "m", undefined, { meter });
    await d.review(ctx, { taskId: 1, task: { title: "t", body: "b", groomingRationale: "g" }, plan: "p" });
    expect(meter).not.toHaveBeenCalled();
  });

  it("stays backward compatible without the options arg", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ verdict: "approved", feedback: "", rationale: "r" }) } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      text: async () => "",
    })));
    const d = new OpenRouterDriver("k", "m");
    await expect(d.review(ctx, { taskId: 1, task: { title: "t", body: "b", groomingRationale: "g" }, plan: "p" })).resolves.toBeTruthy();
  });
});

describe("fetchModelPricing", () => {
  it("finds the model's per-token pricing in the models listing", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: "other/model", pricing: { prompt: "0.000001", completion: "0.000002" } },
          { id: "z-ai/glm-5.2", pricing: { prompt: "0.0000006", completion: "0.0000022" } },
        ],
      }),
      text: async () => "",
    }));
    const pricing = await fetchModelPricing("z-ai/glm-5.2", fetchMock as unknown as typeof fetch);
    expect(pricing).toEqual({ promptPerToken: 0.0000006, completionPerToken: 0.0000022 });
    expect(fetchMock).toHaveBeenCalledWith("https://openrouter.ai/api/v1/models");
  });

  it("returns null for an unknown model", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
      text: async () => "",
    }));
    expect(await fetchModelPricing("nope/none", fetchMock as unknown as typeof fetch)).toBeNull();
  });
});

describe("createCostTracker", () => {
  it("computes costPer100Jobs as mean cost per job times 100", () => {
    const tracker = createCostTracker({ promptPerToken: 0.000001, completionPerToken: 0.000002 });
    // two calls: (1000p + 500c) and (2000p + 1000c)
    tracker.meter({ promptTokens: 1000, completionTokens: 500 });
    tracker.meter({ promptTokens: 2000, completionTokens: 1000 });
    // total cost = (1000+2000)*1e-6 + (500+1000)*2e-6 = 0.003 + 0.003 = 0.006
    // over 4 jobs: mean 0.0015/job -> 0.15 per 100 jobs
    expect(tracker.costPer100Jobs(4)).toBeCloseTo(0.15, 10);
  });

  it("returns null when no usage was metered", () => {
    const tracker = createCostTracker({ promptPerToken: 0.000001, completionPerToken: 0.000002 });
    expect(tracker.costPer100Jobs(10)).toBeNull();
  });

  it("returns null when pricing is unavailable", () => {
    const tracker = createCostTracker(null);
    tracker.meter({ promptTokens: 1000, completionTokens: 500 });
    expect(tracker.costPer100Jobs(10)).toBeNull();
  });
});
