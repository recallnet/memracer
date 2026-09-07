import { describe, expect, it, vi } from "vitest";
import {
  createOpenRouterGroomClassifier,
  GroomDifficultyClassifier,
  groomRoutingHash,
  mediatorRoutingPolicyFromEnv,
  routeMediatorJob,
  selectRoutingArm,
} from "../src/mediator/routing-policy.js";

const GLM = "z-ai/glm-5.2";
const CHEAP = "google/gemini-3.1-flash-lite";

describe("mediator routing policy", () => {
  it("defaults to the flat rollback arm with unqualified cheap routing disabled", () => {
    const policy = mediatorRoutingPolicyFromEnv({}, GLM);

    expect(policy).toMatchObject({
      mode: "flat",
      abPercent: 0,
      cheapQualified: false,
      classifierEnabled: false,
      glmModel: GLM,
    });
    expect(selectRoutingArm(policy, "job:1")).toBe("flat");
    expect(routeMediatorJob(policy, "groom", "flat", "simple")).toMatchObject({
      model: GLM,
      effort: "none",
      useFlatOptions: true,
    });
  });

  it("parses the six typed routes, qualification, rollout, and per-route budgets", () => {
    const policy = mediatorRoutingPolicyFromEnv({
      MEMRACER_MEDIATOR_POLICY_MODE: "routed",
      MEMRACER_MEDIATOR_POLICY_AB_PERCENT: "35",
      MEMRACER_MEDIATOR_CHEAP_MODEL: CHEAP,
      MEMRACER_MEDIATOR_CLASSIFIER_MODEL: CHEAP,
      MEMRACER_MEDIATOR_CHEAP_QUALIFIED: "1",
      MEMRACER_MEDIATOR_GROOM_CLASSIFIER_ENABLED: "true",
      MEMRACER_MEDIATOR_REFRESH_MAX_TOKENS: "2048",
      MEMRACER_MEDIATOR_CONSOLIDATE_MAX_TOKENS: "3072",
      MEMRACER_MEDIATOR_ANSWER_MAX_TOKENS: "4096",
      MEMRACER_MEDIATOR_REVIEW_MAX_TOKENS: "8192",
      MEMRACER_MEDIATOR_DISCUSS_MAX_TOKENS: "12288",
      MEMRACER_MEDIATOR_GROOM_SIMPLE_MAX_TOKENS: "5120",
      MEMRACER_MEDIATOR_GROOM_MEDIUM_MAX_TOKENS: "16384",
      MEMRACER_MEDIATOR_GROOM_HARD_MAX_TOKENS: "32768",
      MEMRACER_MEDIATOR_FALLBACK_MAX_TOKENS: "24576",
    }, GLM);

    expect(policy).toMatchObject({
      mode: "routed",
      abPercent: 35,
      cheapQualified: true,
      classifierEnabled: true,
      cheapModel: CHEAP,
      classifierModel: CHEAP,
    });
    expect(routeMediatorJob(policy, "refresh", "routed")).toEqual({ model: CHEAP, effort: "none", maxTokens: 2048 });
    // consolidate stays on GLM (sparse telemetry)
    expect(routeMediatorJob(policy, "consolidate", "routed")).toEqual({ model: GLM, effort: "none", maxTokens: 3072 });
    expect(routeMediatorJob(policy, "answer", "routed")).toEqual({ model: CHEAP, effort: "low", maxTokens: 4096 });
    expect(routeMediatorJob(policy, "review", "routed")).toEqual({ model: GLM, effort: "high", maxTokens: 8192 });
    expect(routeMediatorJob(policy, "discuss", "routed")).toEqual({ model: GLM, effort: "high", maxTokens: 12288 });
    expect(routeMediatorJob(policy, "groom", "routed", "simple")).toEqual({ model: CHEAP, effort: "none", maxTokens: 5120, difficulty: "simple" });
    expect(routeMediatorJob(policy, "groom", "routed", "medium")).toEqual({ model: GLM, effort: "high", maxTokens: 16384, difficulty: "medium" });
    expect(routeMediatorJob(policy, "groom", "routed", "hard")).toEqual({ model: GLM, effort: "xhigh", maxTokens: 32768, difficulty: "hard" });
    expect(routeMediatorJob(policy, "seal", "routed")).toEqual({ model: GLM, effort: "high", maxTokens: 24576 });
  });

  it("never sends low effort to GLM when the cheap route is not qualified", () => {
    const policy = mediatorRoutingPolicyFromEnv({
      MEMRACER_MEDIATOR_POLICY_MODE: "routed",
      MEMRACER_MEDIATOR_CHEAP_MODEL: CHEAP,
    }, GLM);

    expect(routeMediatorJob(policy, "refresh", "routed")).toEqual({ model: GLM, effort: "none", maxTokens: 8192 });
    expect(routeMediatorJob(policy, "answer", "routed")).toEqual({ model: GLM, effort: "none", maxTokens: 8192 });
    expect(routeMediatorJob(policy, "groom", "routed", "simple")).toEqual({ model: GLM, effort: "none", maxTokens: 8192, difficulty: "simple" });
  });

  it("selects a stable A/B arm and honors the zero and one-hundred percent edges", () => {
    const zero = mediatorRoutingPolicyFromEnv({ MEMRACER_MEDIATOR_POLICY_MODE: "ab" }, GLM);
    const all = mediatorRoutingPolicyFromEnv({
      MEMRACER_MEDIATOR_POLICY_MODE: "ab",
      MEMRACER_MEDIATOR_POLICY_AB_PERCENT: "100",
    }, GLM);
    const split = mediatorRoutingPolicyFromEnv({
      MEMRACER_MEDIATOR_POLICY_MODE: "ab",
      MEMRACER_MEDIATOR_POLICY_AB_PERCENT: "50",
    }, GLM);

    expect(selectRoutingArm(zero, "job:1")).toBe("flat");
    expect(selectRoutingArm(all, "job:1")).toBe("routed");
    expect(selectRoutingArm(split, "stable-key")).toBe(selectRoutingArm(split, "stable-key"));
    expect(new Set(Array.from({ length: 100 }, (_, i) => selectRoutingArm(split, `job:${i}`)))).toEqual(new Set(["flat", "routed"]));
  });

  it("rejects invalid booleans, ranges, modes, budgets, and dynamic router models", () => {
    expect(() => mediatorRoutingPolicyFromEnv({ MEMRACER_MEDIATOR_POLICY_MODE: "maybe" }, GLM)).toThrow(/POLICY_MODE/);
    expect(() => mediatorRoutingPolicyFromEnv({ MEMRACER_MEDIATOR_POLICY_AB_PERCENT: "101" }, GLM)).toThrow(/AB_PERCENT/);
    expect(() => mediatorRoutingPolicyFromEnv({ MEMRACER_MEDIATOR_CHEAP_QUALIFIED: "yes" }, GLM)).toThrow(/CHEAP_QUALIFIED/);
    expect(() => mediatorRoutingPolicyFromEnv({ MEMRACER_MEDIATOR_REVIEW_MAX_TOKENS: "1023" }, GLM)).toThrow(/REVIEW_MAX_TOKENS/);
    expect(() => mediatorRoutingPolicyFromEnv({ MEMRACER_MEDIATOR_CHEAP_MODEL: "openrouter/auto" }, GLM)).toThrow(/Auto Router/);
    expect(() => mediatorRoutingPolicyFromEnv({ MEMRACER_MEDIATOR_CLASSIFIER_MODEL: "openrouter\/auto-beta" }, GLM)).toThrow(/Auto Router/);
    expect(() => mediatorRoutingPolicyFromEnv({}, "openrouter/auto")).toThrow(/Auto Router/);
  });
});

describe("groom difficulty classification", () => {
  const input = {
    title: "Add a bounded cache",
    body: "Cache routing decisions by stable content hash.",
    evidence: [{ kind: "research", note: "Measured duplicate classifier traffic." }],
    queue: [{ id: 7, title: "Existing routing work", state: "QUEUED", priority: 1 }],
  };

  it("hashes routing content stably and separates changed content", () => {
    expect(groomRoutingHash(input)).toBe(groomRoutingHash({ ...input }));
    expect(groomRoutingHash(input)).not.toBe(groomRoutingHash({ ...input, body: `${input.body} Changed.` }));
  });

  it("strictly validates and caches one classification per content hash", async () => {
    const classify = vi.fn(async () => ({ difficulty: "simple", reason: "bounded mechanical change" }));
    const classifier = new GroomDifficultyClassifier(classify);

    await expect(classifier.classify(input)).resolves.toEqual({ difficulty: "simple", reason: "bounded mechanical change" });
    await expect(classifier.classify({ ...input })).resolves.toEqual({ difficulty: "simple", reason: "bounded mechanical change" });
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it("bounds the classifier cache and evicts the least-recently-used content", async () => {
    const classify = vi.fn(async () => ({ difficulty: "simple", reason: "bounded" }));
    const classifier = new GroomDifficultyClassifier(classify, 2);
    const first = { ...input, body: "first" };
    const second = { ...input, body: "second" };
    const third = { ...input, body: "third" };

    await classifier.classify(first);
    await classifier.classify(second);
    await classifier.classify(first); // refresh first; second is now least recent
    await classifier.classify(third); // evicts second
    await classifier.classify(second);

    expect(classify).toHaveBeenCalledTimes(4);
  });

  it("fails closed to hard and caches transport, malformed, and schema failures", async () => {
    for (const response of [
      () => Promise.reject(new Error("timeout")),
      async () => "not-json",
      async () => ({ difficulty: "medium", reason: "" }),
      async () => ({ difficulty: "easy", reason: "unsupported" }),
    ]) {
      const classify = vi.fn(response);
      const classifier = new GroomDifficultyClassifier(classify);
      await expect(classifier.classify(input)).resolves.toMatchObject({ difficulty: "hard" });
      await classifier.classify(input);
      expect(classify).toHaveBeenCalledTimes(1);
    }
  });

  it("sends a strict no-tool OpenRouter classifier request and retains Inceptron exclusion", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ difficulty: "medium", reason: "cross-cutting state" }) } }] }),
      text: async () => "",
    }) as Response);
    const classifier = createOpenRouterGroomClassifier({
      apiKey: "test-key",
      model: CHEAP,
      fetch: fetchMock as typeof fetch,
      timeoutMs: 2_000,
    });

    await expect(classifier.classify(input)).resolves.toEqual({ difficulty: "medium", reason: "cross-cutting state" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      model: CHEAP,
      tool_choice: "none",
      reasoning: { enabled: false },
      provider: { sort: "latency", ignore: ["inceptron"] },
      response_format: { type: "json_schema", json_schema: { name: "groom_difficulty", strict: true } },
    });
    expect(body.tools).toBeUndefined();
  });
});
