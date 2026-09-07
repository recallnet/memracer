import { describe, expect, it, vi } from "vitest";
import { FakeDriver } from "../src/mediator/fake.js";
import { PolicyAwareMediatorDriver } from "../src/mediator/policy-driver.js";
import { mediatorRoutingPolicyFromEnv, GroomDifficultyClassifier } from "../src/mediator/routing-policy.js";
import type { CompletionUsage, MediatorContext } from "../src/mediator/driver.js";

const ctx: MediatorContext = { projectId: "p", projectName: "P", queue: [], decisions: [], memory: "" };

function made(kind: string, options: { classify?: () => Promise<unknown>; attempts?: number } = {}) {
  const policy = mediatorRoutingPolicyFromEnv({
    MEMRACER_MEDIATOR_POLICY_MODE: "routed",
    MEMRACER_MEDIATOR_CHEAP_QUALIFIED: "true",
    MEMRACER_MEDIATOR_GROOM_CLASSIFIER_ENABLED: "true",
  }, "z-ai/glm-5.2");
  const routes: unknown[] = [];
  const starts: unknown[] = [];
  const finishes: unknown[] = [];
  let meter: ((usage: CompletionUsage) => void) | undefined;
  const driver = new PolicyAwareMediatorDriver({
    projectId: "p",
    job: { id: 7, kind, attempts: options.attempts ?? 1 },
    policy,
    classifier: options.classify ? new GroomDifficultyClassifier(options.classify) : undefined,
    createDriver: (route, observe) => {
      routes.push(route);
      meter = observe;
      return new FakeDriver();
    },
    recorder: {
      async start(input) { starts.push(input); return true; },
      async finish(key, result) { finishes.push({ ...key, ...result }); return true; },
    },
    now: (() => { let now = 100; return () => ++now; })(),
  });
  return { driver, routes, starts, finishes, emitUsage: (usage: CompletionUsage) => meter?.(usage) };
}

describe("policy-aware mediator driver", () => {
  it("classifies groom once, routes simple work cheaply, and records the invocation", async () => {
    const classify = vi.fn(async () => ({ difficulty: "simple", reason: "bounded" }));
    const madeDriver = made("groom", { classify });
    await madeDriver.driver.groom(ctx, {
      taskId: 12, title: "Small fix", body: "Change one label", priority: 2, submittedBy: "dana", evidence: [],
    });
    expect(classify).toHaveBeenCalledOnce();
    expect(madeDriver.routes).toEqual([expect.objectContaining({
      model: "google/gemini-3.1-flash-lite", effort: "none", difficulty: "simple",
    })]);
    expect(madeDriver.starts).toEqual([expect.objectContaining({ taskId: 12, kind: "groom", classifiedDifficulty: "simple" })]);
    expect(madeDriver.finishes).toEqual([expect.objectContaining({ outcome: "ok" })]);
  });

  it("floors a priority-0 submission to hard/xhigh even when the classifier under-rates it", async () => {
    const classify = vi.fn(async () => ({ difficulty: "medium", reason: "looks routine" }));
    const madeDriver = made("groom", { classify });
    await madeDriver.driver.groom(ctx, {
      taskId: 14, title: "P0 normalize orders", body: "…nearest valid lot…", priority: 0, submittedBy: "dana", evidence: [],
    });
    expect(classify).toHaveBeenCalledOnce();
    expect(madeDriver.routes).toEqual([expect.objectContaining({
      model: "z-ai/glm-5.2", effort: "xhigh", difficulty: "hard",
    })]);
  });

  it("never classifies consolidate even though it invokes groom", async () => {
    const classify = vi.fn(async () => ({ difficulty: "simple", reason: "bounded" }));
    const madeDriver = made("consolidate", { classify });
    await madeDriver.driver.groom(ctx, {
      taskId: 13, title: "Candidate", body: "Compare", priority: 2, submittedBy: "dana", evidence: [],
    });
    expect(classify).not.toHaveBeenCalled();
    expect(madeDriver.routes).toEqual([expect.objectContaining({ effort: "none" })]);
    expect(madeDriver.routes[0]).not.toHaveProperty("difficulty");
  });

  it("keeps one route across two discuss calls while logging two invocations", async () => {
    const madeDriver = made("discuss");
    await madeDriver.driver.discuss(ctx, { message: "first", from: "dana" });
    await madeDriver.driver.discuss(ctx, { message: "second", from: "dana" });
    expect(madeDriver.routes).toHaveLength(1);
    expect(madeDriver.starts).toHaveLength(2);
    expect(madeDriver.finishes).toHaveLength(2);
  });

  it("records a failed invocation without swallowing the provider error", async () => {
    const policy = mediatorRoutingPolicyFromEnv({ MEMRACER_MEDIATOR_POLICY_MODE: "routed" }, "z-ai/glm-5.2");
    const finish = vi.fn(async () => true);
    const driver = new PolicyAwareMediatorDriver({
      projectId: "p", job: { id: 8, kind: "answer", attempts: 1 }, policy,
      createDriver: () => ({
        ...new FakeDriver(),
        async answer() { throw new Error("provider down"); },
      } as never),
      recorder: { async start() { return true; }, finish },
    });
    await expect(driver.answer(ctx, { taskId: 1, question: "why" })).rejects.toThrow("provider down");
    expect(finish).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ outcome: "fail" }));
  });

  it("does not fail completed model work when terminal telemetry fails", async () => {
    const policy = mediatorRoutingPolicyFromEnv({}, "z-ai/glm-5.2");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const driver = new PolicyAwareMediatorDriver({
      projectId: "p", job: { id: 9, kind: "answer", attempts: 1 }, policy,
      createDriver: () => new FakeDriver(),
      recorder: {
        async start() { return true; },
        async finish() { throw new Error("telemetry unavailable"); },
      },
    });
    await expect(driver.answer(ctx, { taskId: 1, question: "status" })).resolves.toBeDefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("job-policy-log-failure"));
    error.mockRestore();
  });

  it("records the exact prepared flat options instead of policy defaults", async () => {
    const policy = mediatorRoutingPolicyFromEnv({}, "z-ai/glm-5.2");
    const start = vi.fn(async () => true);
    const driver = new PolicyAwareMediatorDriver({
      projectId: "p", job: { id: 10, kind: "answer", attempts: 1 }, policy,
      prepareRoute: (route) => ({ ...route, telemetryEffort: "budgeted", telemetryMaxTokens: 16_384 }),
      createDriver: () => new FakeDriver(),
      recorder: { start, async finish() { return true; } },
    });
    await driver.answer(ctx, { taskId: 1, question: "status" });
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ effort: "budgeted", maxTokens: 16_384 }));
  });
});
