import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_AUTO_FALLBACK_MODELS,
  MediatorOutputError,
  OpenRouterDriver,
  OpenRouterMalformedOutput,
  OpenRouterPermanentError,
  OpenRouterRetriesExhaustedError,
  OpenRouterTimeoutError,
  classifyOpenRouterFailure,
  openRouterOptionsFromEnv,
  promptCacheEnabled,
} from "../src/mediator/openrouter.js";
import type {
  MediatorContext,
  MemoryToolExecutor,
  ProjectKnowledgeRefreshInput,
  ProjectKnowledgeRefreshResult,
  ToolDefinition,
} from "../src/mediator/driver.js";
import { buildReviewPrompt, buildTruncatedRetryPrompt } from "../src/mediator/prompts.js";
import { effectPromiseRunner, makeMediatorRuntime } from "../src/mediator/effect-runtime.js";
import type { Db } from "../src/db.js";

const ctx: MediatorContext = {
  projectId: "p",
  projectName: "P",
  queue: [{ id: 7, title: "existing", state: "QUEUED", priority: 1 }],
  decisions: [],
  memory: "",
};

function fetchReturning(payloads: unknown[]) {
  let call = 0;
  return vi.fn(async (_url: unknown, init?: { body?: string }) => {
    const content = JSON.stringify(payloads[Math.min(call, payloads.length - 1)]);
    call += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content } }] }),
      text: async () => "",
      _lastBody: init?.body,
    } as unknown as Response;
  });
}

/**
 * Fetch stub where call N follows plans[N]: resolve with payload (or reject
 * with error) after delayMs of fake time. Honors AbortSignal unless the plan
 * sets ignoreAbort (to simulate a loser that resolves anyway).
 */
function timedFetch(
  plans: { delayMs: number; payload?: unknown; error?: string; ignoreAbort?: boolean }[],
) {
  const aborted: boolean[] = [];
  let call = 0;
  const fn = vi.fn((_url: unknown, init?: { body?: string; signal?: AbortSignal }) => {
    const i = call++;
    const plan = plans[Math.min(i, plans.length - 1)];
    aborted[i] = false;
    return new Promise<Response>((resolve, reject) => {
      const t = setTimeout(() => {
        if (plan.error !== undefined) return reject(new Error(plan.error));
        resolve({
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: JSON.stringify(plan.payload) } }],
            usage: { prompt_tokens: 100 + i, completion_tokens: 50 + i },
          }),
          text: async () => "",
        } as unknown as Response);
      }, plan.delayMs);
      init?.signal?.addEventListener("abort", () => {
        aborted[i] = true;
        if (!plan.ignoreAbort) {
          clearTimeout(t);
          reject(new DOMException("aborted", "AbortError"));
        }
      });
    });
  });
  return { fn, aborted };
}

function neverSettlingFetch() {
  const signals: AbortSignal[] = [];
  const fn = vi.fn((_url: unknown, init?: { signal?: AbortSignal }) => {
    if (init?.signal) signals.push(init.signal);
    return new Promise<Response>(() => undefined);
  });
  return { fn, signals };
}

function trackHedgeAbortListenerBalance(): () => number {
  const added = vi.spyOn(AbortSignal.prototype, "addEventListener");
  const removed = vi.spyOn(AbortSignal.prototype, "removeEventListener");
  const isHedgeListener = (call: readonly unknown[]) =>
    call[0] === "abort" && typeof call[1] === "function" && call[1].name === "abortRequests";
  return () =>
    added.mock.calls.filter(isHedgeListener).length - removed.mock.calls.filter(isHedgeListener).length;
}

const answerPayload = { escalate: false, answer: "yes", rationale: "r" };
const projectKnowledgeInput: ProjectKnowledgeRefreshInput = {
  candidates: [{
    domain: "product-bounds",
    label: "Product and bounds",
    description: "Purpose, users, value, scope boundaries, and explicit non-goals.",
    last_refreshed_at: null,
    last_checked_at: null,
    triggers: ["TIME"],
    reasons: ["never checked"],
    concepts: [],
    open_question: null,
    event_generation: 0,
  }],
  repo: null,
};
const projectKnowledgePayload: ProjectKnowledgeRefreshResult = {
  checked_domains: ["product-bounds"],
  questions: [],
  rationale: "context is competent",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("OpenRouterDriver", () => {
  it("runs through an injected shared mediator runtime", async () => {
    const runtime = makeMediatorRuntime({ db: {} as Db });
    const runPromise = vi.spyOn(runtime, "runPromise");
    const fetch = fetchReturning([answerPayload]);

    try {
      await expect(new OpenRouterDriver("k", "m", undefined, { effectRunner: effectPromiseRunner(runtime), fetch }).answer(
        ctx,
        { taskId: 1, question: "q" },
      )).resolves.toEqual(answerPayload);
      expect(runPromise).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.dispose();
    }
  });

  it("keeps schema correction inside one shared-runtime execution", async () => {
    const runtime = makeMediatorRuntime({ db: {} as Db });
    const runPromise = vi.spyOn(runtime, "runPromise");
    const fetch = fetchReturning([{ invalid: true }, answerPayload]);

    try {
      await expect(new OpenRouterDriver("k", "m", undefined, {
        effectRunner: effectPromiseRunner(runtime),
        fetch,
      }).answer(ctx, { taskId: 1, question: "q" })).resolves.toEqual(answerPayload);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(runPromise).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.dispose();
    }
  });

  it("grooms via the configured model and validates the result", async () => {
    const fetchMock = fetchReturning([
      { action: "merge", into_task_id: 7, rationale: "same as existing" },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const d = new OpenRouterDriver("test-key", "deepseek/deepseek-r1");
    const result = await d.groom(ctx, {
      taskId: 9, title: "t", body: "b", priority: 2, submittedBy: "dana", evidence: [],
    });
    expect(result).toEqual({ action: "merge", into_task_id: 7, rationale: "same as existing" });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.model).toBe("deepseek/deepseek-r1");
    expect(body.max_tokens).toBe(32_768);
    expect(body.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "groom_result", strict: true, schema: { anyOf: expect.any(Array) } },
    });
    expect(body.provider).not.toHaveProperty("require_parameters");
    expect((fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers.Authorization).toBe(
      "Bearer test-key",
    );
  });

  it("model is per-instance config — swapping needs no code change", async () => {
    const fetchMock = fetchReturning([{ verdict: "approved", feedback: "", rationale: "ok" }]);
    vi.stubGlobal("fetch", fetchMock);
    const d = new OpenRouterDriver("k", "anthropic/claude-sonnet-5");
    await d.review(ctx, { taskId: 1, task: { title: "t", body: "b", groomingRationale: "g" }, plan: "p" });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.model).toBe("anthropic/claude-sonnet-5");
  });

  it("retries once on schema-invalid output, then throws", async () => {
    const fetchMock = fetchReturning([{ nonsense: true }, { nonsense: "still" }]);
    vi.stubGlobal("fetch", fetchMock);
    const d = new OpenRouterDriver("k", "m");
    const failure = await d.answer(ctx, { taskId: 1, question: "q" }).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(MediatorOutputError);
    expect(failure).toMatchObject({ model: "m", rawOutput: JSON.stringify({ nonsense: "still" }) });
    expect((failure as Error).message).toMatch(/invalid mediator output.*schema validation error/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reviews a #229-class plan after one bounded truncation retry", async () => {
    const plan = Array.from({ length: 90 }, (_, index) =>
      `${index + 1}. Preserve the OAuth callback, PKCE verifier, state cookie, provider metadata, role mapping, migration safety, audit trail, rollback path, browser coverage, and explicit acceptance evidence without weakening any existing authorization boundary.`,
    ).join("\n");
    expect(plan.length).toBeGreaterThanOrEqual(12_000);
    const input = {
      taskId: 229,
      task: { title: "OAuth migration", body: "Preserve every authorization boundary.", groomingRationale: "accepted migration scope" },
      plan,
      filesTouched: ["src/auth/oauth.ts"],
      risk: "Security-sensitive OAuth migration",
    };
    const truncated = `{"verdict":"approved","feedback":"","rationale":"${"cut ".repeat(600)}`;
    const approved = { verdict: "approved", feedback: "", rationale: "Every criterion is covered." };
    let call = 0;
    const fetchMock = vi.fn(async () => {
      const first = call++ === 0;
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ finish_reason: first ? "length" : "stop", message: { content: first ? truncated : JSON.stringify(approved) } }] }),
        text: async () => "",
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(new OpenRouterDriver("k", "m").review(ctx, input)).resolves.toEqual(approved);
    const bodies = fetchMock.mock.calls.map((args) => JSON.parse((args[1] as { body: string }).body));
    expect(bodies.map((body) => body.max_tokens)).toEqual([32_768, 65_536]);
    expect(bodies[1].messages[1].content).toBe(buildTruncatedRetryPrompt(buildReviewPrompt(ctx, input)));
    expect(bodies[1].messages[1].content).not.toContain(truncated);
  });

  it("detects unterminated JSON without provider finish metadata", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: 'Context [draft].\n{"escalate":false,"answer":"cut' } }] }),
        text: async () => "",
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(answerPayload) } }] }),
        text: async () => "",
      } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    await expect(new OpenRouterDriver("k", "m").answer(ctx, { taskId: 1, question: "q" })).resolves.toEqual(answerPayload);
    const second = JSON.parse((fetchMock.mock.calls[1][1] as { body: string }).body);
    expect(second.max_tokens).toBe(65_536);
    expect(second.messages[1].content).toContain("truncated before the JSON object finished");
  });

  it("fails cleanly with a typed error after two truncated completions", async () => {
    const truncated = '{"escalate":false,"answer":"cut';
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ choices: [{ finish_reason: "length", message: { content: truncated } }] }),
      text: async () => "",
    } as unknown as Response)));
    const failure = await new OpenRouterDriver("k", "m").answer(ctx, { taskId: 1, question: "q" }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MediatorOutputError);
    expect(failure).toBeInstanceOf(OpenRouterMalformedOutput);
    expect(failure).toMatchObject({ _tag: "OpenRouterMalformedOutput", kind: "truncated", model: "m", rawOutput: truncated });
    expect((failure as Error).message).toMatch(/truncated mediator output after retry/);
  });

  it.each([
    ["markdown fence", "```json\n{\"escalate\":false,\"answer\":\"yes\",\"rationale\":\"r\"}\n```"],
    ["surrounding prose", "Here is the result:\n{\"escalate\":false,\"answer\":\"yes\",\"rationale\":\"r\"}\nDone."],
  ])("recovers valid JSON from %s", async (_label, content) => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content } }] }),
      text: async () => "",
    } as unknown as Response)));
    const d = new OpenRouterDriver("k", "m");
    await expect(d.answer(ctx, { taskId: 1, question: "q" })).resolves.toEqual(answerPayload);
  });

  it.each([
    ["direct payload", `<tool_call>${JSON.stringify(answerPayload)}</tool_call>`],
    ["function arguments", `<tool_call>${JSON.stringify({ name: "answer", arguments: JSON.stringify(answerPayload) })}</tool_call>`],
  ])("recovers final JSON from an XML tool-call wrapper with %s", async (_label, content) => {
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content } }] }),
      text: async () => "",
    } as unknown as Response));
    const d = new OpenRouterDriver("k", "m", undefined, { fetch });

    await expect(d.answer(ctx, { taskId: 1, question: "q" })).resolves.toEqual(answerPayload);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([429, 529])("backs off and retries OpenRouter %s responses", async (status) => {
    vi.useFakeTimers();
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls < 3) return { ok: false, status, text: async () => "retry later" } as Response;
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(answerPayload) } }] }),
        text: async () => "",
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const d = new OpenRouterDriver("k", "m", undefined, { retryBaseDelayMs: 100 });
    const pending = d.answer(ctx, { taskId: 1, question: "q" });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(199);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual(answerPayload);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries infrastructure 404s but fails pinned-model 404s immediately", async () => {
    vi.useFakeTimers();
    let infraCalls = 0;
    const infraFetch = vi.fn(async () => {
      infraCalls += 1;
      if (infraCalls < 3) {
        return { ok: false, status: 404, text: async () => "upstream infrastructure temporarily unavailable" } as Response;
      }
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(answerPayload) } }] }) } as Response;
    });
    vi.stubGlobal("fetch", infraFetch);
    const recovered = new OpenRouterDriver("k", "z-ai/glm-5.2", undefined, { retryBaseDelayMs: 100 })
      .answer(ctx, { taskId: 1, question: "q" });
    await vi.advanceTimersByTimeAsync(301);
    await expect(recovered).resolves.toEqual(answerPayload);
    expect(infraFetch).toHaveBeenCalledTimes(3);

    const pinnedFetch = vi.fn(async () => ({
      ok: false,
      status: 404,
      text: async () => "No endpoints found that can handle the requested parameters",
    }) as Response);
    vi.stubGlobal("fetch", pinnedFetch);
    await expect(new OpenRouterDriver("k", "z-ai/glm-5.2").answer(ctx, { taskId: 1, question: "q" }))
      .rejects.toBeInstanceOf(OpenRouterPermanentError);
    expect(pinnedFetch).toHaveBeenCalledTimes(1);
  });

  it("classifies provider retryability into explicit tagged errors", () => {
    expect(classifyOpenRouterFailure(529, "overloaded", "m")._tag).toBe("OpenRouterTransientError");
    expect(classifyOpenRouterFailure(404, "upstream provider temporarily unavailable", "m")._tag).toBe("OpenRouterTransientError");
    expect(classifyOpenRouterFailure(404, "No endpoints found that can handle the requested parameters", "m")).toBeInstanceOf(OpenRouterPermanentError);
  });

  it("caps retryable HTTP responses at three attempts", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => ({ ok: false, status: 429, text: async () => "busy" }) as Response);
    vi.stubGlobal("fetch", fetchMock);
    const d = new OpenRouterDriver("k", "m", undefined, { retryBaseDelayMs: 100 });
    const pending = d.answer(ctx, { taskId: 1, question: "q" });
    const rejection = expect(pending).rejects.toMatchObject({
      _tag: "OpenRouterRetriesExhaustedError",
      model: "m",
      status: 429,
    });
    await vi.advanceTimersByTimeAsync(301);
    await rejection;
    await expect(pending.catch((error: unknown) => error)).resolves.toBeInstanceOf(OpenRouterRetriesExhaustedError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries a bundled groom clarification and accepts one recommended question", async () => {
    const valid = {
      action: "clarify",
      question: "Which region should host it? Recommended: eu-west-1 — it matches deployment.",
      rationale: "human-owned deployment decision",
    };
    const fetchMock = fetchReturning([
      { action: "clarify", question: "Which region? Which database?", rationale: "bundled" },
      valid,
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const d = new OpenRouterDriver("k", "m");
    expect(
      await d.groom(ctx, { taskId: 9, title: "t", body: "b", priority: 2, submittedBy: "dana", evidence: [] }),
    ).toEqual(valid);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("discuss enforces the 5-action cap through the shared retry contract", async () => {
    const sixCloses = Array.from({ length: 6 }, (_, i) => ({
      action: "close_task", task_id: i + 1, reason: "spam",
    }));
    const valid = { reply: "done", actions: [{ action: "close_task", task_id: 1, reason: "obsolete" }], rationale: "r" };
    const fetchMock = fetchReturning([
      { reply: "done", actions: sixCloses, rationale: "r" }, // over the cap → retry
      valid,
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const d = new OpenRouterDriver("k", "m");
    expect(await d.discuss(ctx, { message: "close everything", from: "dana" })).toEqual(valid);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("takeMeta surfaces the completion's reasoning/model/usage, then clears (#45)", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        model: "anthropic/claude-sonnet-4.6",
        choices: [{ message: { content: JSON.stringify(answerPayload), reasoning: "weighed the options" } }],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 34,
          cost: 0.0042,
          cache_discount: 0.0011,
          prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 12 },
        },
      }),
      text: async () => "",
    }) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    const d = new OpenRouterDriver("k", "anthropic/claude-sonnet-5");
    await d.answer(ctx, { taskId: 1, question: "q" });
    expect(d.takeMeta()).toEqual({
      model: "anthropic/claude-sonnet-4.6",
      reasoning: "weighed the options",
      usage: expect.objectContaining({
        promptTokens: 120,
        completionTokens: 34,
        cachedTokens: 80,
        cacheWriteTokens: 12,
        cacheDiscountUsd: 0.0011,
        costUsd: 0.0042,
        resolvedModel: "anthropic/claude-sonnet-4.6",
      }),
    });
    // consumed on read — a second take is empty
    expect(d.takeMeta()).toBeUndefined();
  });

  it("takeUsage totals every completion across a schema retry and then clears", async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      const content = call++ === 0 ? { invalid: true } : answerPayload;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(content) } }],
          model: call === 1 ? "provider/model-a" : "provider/model-b",
          usage: {
            prompt_tokens: 10 + call,
            completion_tokens: 5 + call,
            cost: 0.001 * call,
            cache_discount: 0.0001 * call,
            prompt_tokens_details: { cached_tokens: call, cache_write_tokens: call + 1 },
          },
        }),
        text: async () => "",
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const d = new OpenRouterDriver("k", "m");
    await d.answer(ctx, { taskId: 1, question: "q" });
    const usage = d.takeUsage();
    expect(usage).toMatchObject({
      promptTokens: 23,
      completionTokens: 13,
      cachedTokens: 3,
      cacheWriteTokens: 5,
      costUsd: 0.003,
      completionCount: 2,
      requestedModel: "m",
      resolvedModel: "provider/model-b",
    });
    expect(usage?.cacheDiscountUsd).toBeCloseTo(0.0003);
    expect(d.takeUsage()).toBeUndefined();
  });

  it("takeMeta omits reasoning when the provider returns none (#45)", async () => {
    const fetchMock = fetchReturning([answerPayload]);
    vi.stubGlobal("fetch", fetchMock);
    const d = new OpenRouterDriver("k", "m");
    await d.answer(ctx, { taskId: 1, question: "q" });
    const meta = d.takeMeta();
    expect(meta?.model).toBe("m");
    expect(meta?.reasoning).toBeUndefined();
  });

  it("recovers when the retry returns valid output", async () => {
    const fetchMock = fetchReturning([
      { nonsense: true },
      { escalate: false, answer: "yes", rationale: "r" },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const d = new OpenRouterDriver("k", "m");
    expect(await d.answer(ctx, { taskId: 1, question: "q" })).toEqual({
      escalate: false, answer: "yes", rationale: "r",
    });
  });
});

interface StubToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** call 0 returns tool_calls (no content); call 1+ returns the final JSON payload. */
function fetchToolThenFinal(toolCalls: StubToolCall[], finalPayload: unknown) {
  let call = 0;
  return vi.fn(async () => {
    const i = call++;
    const message =
      i === 0 ? { content: null, tool_calls: toolCalls } : { content: JSON.stringify(finalPayload) };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        model: "resolved/tool-model",
        choices: [{ message }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          cost: 0.001,
          prompt_tokens_details: { cached_tokens: i === 0 ? 0 : 8, cache_write_tokens: i === 0 ? 6 : 0 },
        },
      }),
      text: async () => "",
    } as unknown as Response;
  });
}

describe("OpenRouterDriver project-knowledge refresh", () => {
  it("uses the strict project-knowledge schema and provider controls through Auto Router", async () => {
    const fetchMock = fetchReturning([projectKnowledgePayload]);
    vi.stubGlobal("fetch", fetchMock);
    const d = new OpenRouterDriver("k", "openrouter/auto-beta", undefined, {
      promptCacheMode: "on",
      cacheSessionId: "must-not-stick-auto",
    });

    await expect(d.refreshProjectKnowledge(ctx, projectKnowledgeInput)).resolves.toEqual(projectKnowledgePayload);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.response_format).toMatchObject({
      type: "json_schema",
      json_schema: {
        name: "project_knowledge_refresh_result",
        strict: true,
        schema: { type: "object" },
      },
    });
    expect(body.provider.require_parameters).toBe(true);
    expect(body.models).toEqual(DEFAULT_AUTO_FALLBACK_MODELS);
    expect(body.plugins).toEqual([{ id: "auto-router", cost_quality_tradeoff: 7 }]);
    expect(body).not.toHaveProperty("session_id");
    expect(body).not.toHaveProperty("cache_control");
  });

  it("keeps Auto Router controls on tool turns and parses their final refresh result", async () => {
    const dispatched = vi.fn(async () => ({ matches: [] }));
    const toolDefs: ToolDefinition[] = [
      { type: "function", function: { name: "okf_grep", description: "search", parameters: { type: "object" } } },
    ];
    const tools: MemoryToolExecutor = {
      toolDefinitions: () => toolDefs,
      dispatch: dispatched,
    };
    const fetchMock = fetchToolThenFinal(
      [{
        id: "call_knowledge",
        type: "function",
        function: { name: "okf_grep", arguments: JSON.stringify({ query: "product boundary" }) },
      }],
      projectKnowledgePayload,
    );
    vi.stubGlobal("fetch", fetchMock);
    const d = new OpenRouterDriver("k", "openrouter/auto-beta");

    await expect(d.refreshProjectKnowledge({ ...ctx, tools }, projectKnowledgeInput)).resolves.toEqual(
      projectKnowledgePayload,
    );
    expect(dispatched).toHaveBeenCalledWith("okf_grep", { query: "product boundary" });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.tools).toEqual(toolDefs);
    expect(body).not.toHaveProperty("response_format");
    expect(body).toMatchObject({
      tool_choice: "auto",
      parallel_tool_calls: false,
      provider: { require_parameters: true },
      models: [...DEFAULT_AUTO_FALLBACK_MODELS],
      plugins: [{ id: "auto-router", cost_quality_tradeoff: 7 }],
    });
    expect(d.takeUsage()).toMatchObject({
      promptTokens: 20,
      completionTokens: 10,
      cachedTokens: 8,
      cacheWriteTokens: 6,
      costUsd: 0.002,
      completionCount: 2,
      requestedModel: "openrouter/auto-beta",
      resolvedModel: "resolved/tool-model",
    });
  });

  it("stable-dedupes checked domains before schema validation", async () => {
    const fetchMock = fetchReturning([{
      ...projectKnowledgePayload,
      checked_domains: ["product-bounds", "product-bounds"],
    }]);
    const d = new OpenRouterDriver("k", "m", undefined, { fetch: fetchMock });

    await expect(d.refreshProjectKnowledge(ctx, projectKnowledgeInput)).resolves.toEqual(projectKnowledgePayload);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("normalizes over-length knowledge-event reasons before schema validation", async () => {
    const reason = "r".repeat(350);
    const fetchMock = fetchReturning([{
      action: "accept",
      title: "accepted",
      body: "accepted body",
      priority: 1,
      rationale: "ready",
      knowledge_events: [{ domain: "product-bounds", reason }],
    }]);
    const d = new OpenRouterDriver("k", "m", undefined, { fetch: fetchMock });

    await expect(d.groom(ctx, {
      taskId: 9, title: "t", body: "b", priority: 2, submittedBy: "dana", evidence: [],
    })).resolves.toMatchObject({
      knowledge_events: [{ domain: "product-bounds", reason: "r".repeat(300) }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a stable cached prefix and observes cache reads before close-out", async () => {
    const dispatched = vi.fn(async () => ({ matches: [] }));
    const tools: MemoryToolExecutor = {
      toolDefinitions: () => [
        { type: "function", function: { name: "okf_grep", description: "search", parameters: { type: "object" } } },
      ],
      dispatch: dispatched,
    };
    let call = 0;
    const fetchMock = vi.fn(async () => {
      const message = call++ < 12
        ? {
            content: null,
            tool_calls: [{
              id: `knowledge_call_${call}`,
              type: "function",
              function: { name: "okf_grep", arguments: '{"query":"product boundary"}' },
            }],
          }
        : { content: JSON.stringify(projectKnowledgePayload) };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: "z-ai/glm-5.2",
          choices: [{ message }],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 10,
            prompt_tokens_details: { cached_tokens: call === 1 ? 0 : 80, cache_write_tokens: call === 1 ? 40 : 0 },
          },
        }),
        text: async () => "",
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const d = new OpenRouterDriver("k", "z-ai/glm-5.2", undefined, {
      promptCacheMode: "on",
      cacheSessionId: "memracer:p:job-1",
    });

    await expect(d.refreshProjectKnowledge({ ...ctx, tools }, projectKnowledgeInput)).resolves.toEqual(
      projectKnowledgePayload,
    );
    expect(dispatched).toHaveBeenCalledTimes(12);
    const bodies = fetchMock.mock.calls.map((entry) => JSON.parse((entry[1] as { body: string }).body));
    expect(bodies.every((body) => body.session_id === "memracer:p:job-1")).toBe(true);
    expect(bodies.every((body) => body.cache_control.type === "ephemeral")).toBe(true);
    expect(bodies.slice(0, 12).every((body) => JSON.stringify(body.tools) === JSON.stringify(bodies[0].tools))).toBe(true);
    expect(d.takeUsage()?.cacheReadByCompletion?.slice(1, 6)).toEqual([80, 80, 80, 80, 80]);
    const closeout = JSON.parse((fetchMock.mock.calls[12][1] as { body: string }).body);
    expect(closeout).not.toHaveProperty("tools");
    expect(closeout.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "project_knowledge_refresh_result", strict: true },
    });
  });
});

describe("OpenRouterDriver memory tool loop", () => {
  it("dispatches a mid-turn tool call, feeds the result back, then parses the final JSON", async () => {
    const dispatched: { name: string; args: Record<string, unknown> }[] = [];
    const toolDefs: ToolDefinition[] = [
      { type: "function", function: { name: "okf_grep", description: "search", parameters: { type: "object" } } },
    ];
    const tools: MemoryToolExecutor = {
      toolDefinitions: () => toolDefs,
      dispatch: async (name, args) => {
        dispatched.push({ name, args });
        return { matches: [{ path: "learnings/x.md" }] };
      },
    };
    const fetchMock = fetchToolThenFinal(
      [{ id: "call_1", type: "function", function: { name: "okf_grep", arguments: JSON.stringify({ query: "lease" }) } }],
      { escalate: false, answer: "yes", rationale: "r" },
    );
    vi.stubGlobal("fetch", fetchMock);
    const d = new OpenRouterDriver("k", "m");
    const result = await d.answer({ ...ctx, tools }, { taskId: 1, question: "q" });

    expect(result).toEqual({ escalate: false, answer: "yes", rationale: "r" });
    expect(dispatched).toEqual([{ name: "okf_grep", args: { query: "lease" } }]);
    // request 0 advertised tools and omitted response_format
    const body0 = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body0.tools).toEqual(toolDefs);
    expect(body0).not.toHaveProperty("response_format");
    expect(body0).toMatchObject({
      tool_choice: "auto",
      parallel_tool_calls: false,
      provider: { sort: "latency" },
    });
    // request 1 carried the assistant tool_call turn + the tool result message
    const body1 = JSON.parse((fetchMock.mock.calls[1][1] as { body: string }).body);
    const roles = body1.messages.map((m: { role: string }) => m.role);
    expect(roles).toContain("assistant");
    expect(roles).toContain("tool");
    const toolMsg = body1.messages.find((m: { role: string }) => m.role === "tool");
    expect(toolMsg.tool_call_id).toBe("call_1");
    expect(JSON.parse(toolMsg.content)).toEqual({ matches: [{ path: "learnings/x.md" }] });
  });

  it("without ctx.tools, sends the strict result schema", async () => {
    const fetchMock = fetchReturning([{ escalate: false, answer: "yes", rationale: "r" }]);
    vi.stubGlobal("fetch", fetchMock);
    const d = new OpenRouterDriver("k", "m");
    await d.answer(ctx, { taskId: 1, question: "q" });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body).not.toHaveProperty("tools");
    expect(body.tool_choice).toBe("none");
    expect(body.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "answer_result", strict: true, schema: { anyOf: expect.any(Array) } },
    });
  });

  it("dispatches a content-embedded tool_call when native tool calls are absent", async () => {
    const dispatched = vi.fn(async () => ({ matches: [] }));
    const tools: MemoryToolExecutor = {
      toolDefinitions: () => [
        { type: "function", function: { name: "okf_grep", description: "search", parameters: { type: "object" } } },
      ],
      dispatch: dispatched,
    };
    let call = 0;
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: call++ === 0
        ? { content: '<tool_call>{"name":"okf_grep","arguments":{"query":"lease"}}</tool_call>' }
        : { content: JSON.stringify(answerPayload) } }] }),
      text: async () => "",
    }) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const d = new OpenRouterDriver("k", "m");
    await expect(d.answer({ ...ctx, tools }, { taskId: 1, question: "q" })).resolves.toEqual(answerPayload);
    expect(dispatched).toHaveBeenCalledWith("okf_grep", { query: "lease" });
    const secondBody = JSON.parse((fetchMock.mock.calls[1][1] as { body: string }).body);
    expect(secondBody.messages).toContainEqual(expect.objectContaining({
      role: "assistant",
      content: null,
      tool_calls: [expect.objectContaining({ id: "embedded_tool_call" })],
    }));
  });

  it("does not dispatch malformed or unknown embedded tool calls", async () => {
    const dispatched = vi.fn();
    const tools: MemoryToolExecutor = {
      toolDefinitions: () => [
        { type: "function", function: { name: "okf_grep", description: "search", parameters: { type: "object" } } },
      ],
      dispatch: dispatched,
    };
    const fetchMock = fetchReturning([
      '<tool_call>{"name":"delete_everything","arguments":{}}</tool_call>',
      answerPayload,
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const d = new OpenRouterDriver("k", "m");
    await expect(d.answer({ ...ctx, tools }, { taskId: 1, question: "q" })).resolves.toEqual(answerPayload);
    expect(dispatched).not.toHaveBeenCalled();
  });

  it("forces a strict no-tool close-out after the bounded tool loop", async () => {
    const dispatched = vi.fn(async () => ({ matches: [] }));
    const tools: MemoryToolExecutor = {
      toolDefinitions: () => [
        { type: "function", function: { name: "okf_grep", description: "search", parameters: { type: "object" } } },
      ],
      dispatch: dispatched,
    };
    let call = 0;
    const fetchMock = vi.fn(async () => {
      const message = call++ < 12
        ? { content: null, tool_calls: [{
            id: `call_${call}`,
            type: "function",
            function: { name: "okf_grep", arguments: '{"query":"lease"}' },
          }] }
        : { content: JSON.stringify(answerPayload) };
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message }] }),
        text: async () => "",
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const d = new OpenRouterDriver("k", "m");
    await expect(d.answer({ ...ctx, tools }, { taskId: 1, question: "q" })).resolves.toEqual(answerPayload);
    expect(dispatched).toHaveBeenCalledTimes(12);
    const closeout = JSON.parse((fetchMock.mock.calls[12][1] as { body: string }).body);
    expect(closeout).not.toHaveProperty("tools");
    expect(closeout.tool_choice).toBe("none");
    expect(closeout.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "answer_result", strict: true },
    });
  });

  it("keeps an exhausted malformed close-out retry no-tools without replaying dispatch", async () => {
    const dispatched = vi.fn(async () => ({ matches: [] }));
    const tools: MemoryToolExecutor = {
      toolDefinitions: () => [{ type: "function", function: { name: "okf_grep", description: "search", parameters: { type: "object" } } }],
      dispatch: dispatched,
    };
    let call = 0;
    const fetchMock = vi.fn(async () => {
      const message = call < 12
        ? { content: null, tool_calls: [{ id: `call_${call + 1}`, type: "function", function: { name: "okf_grep", arguments: "{}" } }] }
        : { content: call === 12 ? '{"escalate":false' : JSON.stringify(answerPayload) };
      call += 1;
      return { ok: true, status: 200, json: async () => ({ choices: [{ message }] }), text: async () => "" } as unknown as Response;
    });

    await expect(new OpenRouterDriver("k", "m", undefined, { fetch: fetchMock }).answer(
      { ...ctx, tools }, { taskId: 1, question: "q" },
    )).resolves.toEqual(answerPayload);
    expect(dispatched).toHaveBeenCalledTimes(12);
    for (const index of [12, 13]) {
      const body = JSON.parse((fetchMock.mock.calls[index][1] as { body: string }).body);
      expect(body).not.toHaveProperty("tools");
      expect(body.tool_choice).toBe("none");
      expect(body.response_format.json_schema.name).toBe("answer_result");
    }
    const retryBody = JSON.parse((fetchMock.mock.calls[13][1] as { body: string }).body);
    const retryToolMessages = retryBody.messages.filter((message: { role: string }) => message.role === "tool");
    expect(JSON.parse(retryToolMessages.at(-1).content)).toEqual({ matches: [] });
    expect(retryBody.messages.at(-1)).toMatchObject({ role: "user", content: expect.stringContaining("truncated") });
  });

  it("makes an early malformed post-tool retry no-tools without replaying the write", async () => {
    const dispatched = vi.fn(async () => ({ write_id: 41, status: "stored" }));
    const tools: MemoryToolExecutor = {
      toolDefinitions: () => [{ type: "function", function: { name: "okf_remember", description: "write", parameters: { type: "object" } } }],
      dispatch: dispatched,
    };
    let call = 0;
    const fetchMock = vi.fn(async () => {
      const messages = [
        { content: null, tool_calls: [{ id: "write_1", type: "function", function: { name: "okf_remember", arguments: '{"fact":"durable"}' } }] },
        { content: '{"escalate":false' },
        { content: JSON.stringify(answerPayload) },
      ];
      const message = messages[Math.min(call, messages.length - 1)];
      call += 1;
      return { ok: true, status: 200, json: async () => ({ choices: [{ message }] }), text: async () => "" } as unknown as Response;
    });

    await expect(new OpenRouterDriver("k", "m", undefined, { fetch: fetchMock }).answer(
      { ...ctx, tools }, { taskId: 1, question: "q" },
    )).resolves.toEqual(answerPayload);
    expect(dispatched).toHaveBeenCalledTimes(1);
    const retryBody = JSON.parse((fetchMock.mock.calls[2][1] as { body: string }).body);
    expect(retryBody).not.toHaveProperty("tools");
    expect(retryBody.tool_choice).toBe("none");
    const latestTool = retryBody.messages.filter((message: { role: string }) => message.role === "tool").at(-1);
    expect(JSON.parse(latestTool.content)).toEqual({ write_id: 41, status: "stored" });
  });

  it("compacts old tool results while preserving the newest exactly", async () => {
    const payloads = ["small useful evidence", `meaningful lease evidence ${"b".repeat(2_000)}`, "c".repeat(2_000)];
    const tools: MemoryToolExecutor = {
      toolDefinitions: () => [{ type: "function", function: { name: "okf_grep", description: "search", parameters: { type: "object" } } }],
      dispatch: vi.fn(async () => ({ payload: payloads.shift() })),
    };
    let call = 0;
    const fetchMock = vi.fn(async () => {
      const message = call++ < 3
        ? { content: null, tool_calls: [{ id: `call_${call}`, type: "function", function: { name: "okf_grep", arguments: "{}" } }] }
        : { content: JSON.stringify(answerPayload) };
      return { ok: true, status: 200, json: async () => ({ choices: [{ message }] }), text: async () => "" } as unknown as Response;
    });

    await new OpenRouterDriver("k", "m", undefined, { fetch: fetchMock }).answer(
      { ...ctx, tools }, { taskId: 1, question: "q" },
    );
    const fourth = JSON.parse((fetchMock.mock.calls[3][1] as { body: string }).body);
    const toolMessages = fourth.messages.filter((message: { role: string }) => message.role === "tool");
    expect(toolMessages).toHaveLength(3);
    expect(JSON.parse(toolMessages[0].content)).toEqual({ payload: "small useful evidence" });
    expect(new TextEncoder().encode(toolMessages[1].content).byteLength).toBeLessThanOrEqual(512);
    expect(JSON.parse(toolMessages[1].content)).toMatchObject({
      compacted: true,
      tool_call_id: toolMessages[1].tool_call_id,
      content_hash: expect.stringMatching(/^fnv1a:/),
      excerpt: expect.stringContaining("meaningful lease evidence"),
    });
    expect(JSON.parse(toolMessages[2].content)).toEqual({ payload: "c".repeat(2_000) });
  });

  it("preserves provider reasoning_content aliases and details on tool-call continuations", async () => {
    const tools: MemoryToolExecutor = {
      toolDefinitions: () => [{ type: "function", function: { name: "okf_grep", description: "search", parameters: { type: "object" } } }],
      dispatch: vi.fn(async () => ({ matches: [] })),
    };
    let call = 0;
    const reasoningDetails = [{ type: "reasoning.text", text: "inspect memory" }];
    const fetchMock = vi.fn(async () => {
      const message = call++ === 0
        ? {
            content: null,
            reasoning_content: "inspect memory",
            reasoning_details: reasoningDetails,
            tool_calls: [{ id: "call_reason", type: "function", function: { name: "okf_grep", arguments: "{}" } }],
          }
        : { content: JSON.stringify(answerPayload) };
      return { ok: true, status: 200, json: async () => ({ choices: [{ message }] }), text: async () => "" } as unknown as Response;
    });

    await new OpenRouterDriver("k", "m", undefined, { fetch: fetchMock }).answer(
      { ...ctx, tools }, { taskId: 1, question: "q" },
    );
    const continuation = JSON.parse((fetchMock.mock.calls[1][1] as { body: string }).body);
    const assistant = continuation.messages.find((message: { role: string }) => message.role === "assistant");
    expect(assistant).toMatchObject({ reasoning: "inspect memory", reasoning_details: reasoningDetails });
  });
});

describe("OpenRouterDriver provider routing", () => {
  it("sends provider.sort latency by default", async () => {
    const fetchMock = fetchReturning([answerPayload]);
    vi.stubGlobal("fetch", fetchMock);
    const d = new OpenRouterDriver("k", "m");
    await d.answer(ctx, { taskId: 1, question: "q" });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.provider).toEqual({ sort: "latency", ignore: ["inceptron"] });
    expect(body.reasoning).toEqual({ enabled: false });
  });

  it("applies provider-ignore and reasoning overrides", async () => {
    const enabledFetch = fetchReturning([answerPayload]);
    await new OpenRouterDriver("k", "m", undefined, {
      fetch: enabledFetch,
      providerIgnore: ["slow-a", "slow-b"],
      reasoning: true,
    }).answer(ctx, { taskId: 1, question: "q" });
    const enabled = JSON.parse((enabledFetch.mock.calls[0][1] as { body: string }).body);
    expect(enabled.provider.ignore).toEqual(["slow-a", "slow-b"]);
    expect(enabled.reasoning).toEqual({ enabled: true });

    const budgetFetch = fetchReturning([answerPayload]);
    await new OpenRouterDriver("k", "m", undefined, {
      fetch: budgetFetch,
      reasoning: { max_tokens: 4_096 },
    }).answer(ctx, { taskId: 1, question: "q" });
    const budgeted = JSON.parse((budgetFetch.mock.calls[0][1] as { body: string }).body);
    expect(budgeted.reasoning).toEqual({ max_tokens: 4_096 });

    for (const effort of ["low", "high", "xhigh"] as const) {
      const effortFetch = fetchReturning([answerPayload]);
      await new OpenRouterDriver("k", "m", undefined, {
        fetch: effortFetch,
        reasoning: { effort },
      }).answer(ctx, { taskId: 1, question: "q" });
      const effortBody = JSON.parse((effortFetch.mock.calls[0][1] as { body: string }).body);
      expect(effortBody.reasoning).toEqual({ effort });
    }
    expect(() => new OpenRouterDriver("k", "m", undefined, { reasoning: { max_tokens: 1_023 } })).toThrow(/1024/);
    expect(() => new OpenRouterDriver("k", "m", undefined, {
      maxTokens: 4_096,
      reasoning: { max_tokens: 4_096 },
    })).toThrow(/strictly less/);
  });

  it("omits only provider.sort when providerSort is false", async () => {
    const fetchMock = fetchReturning([answerPayload]);
    vi.stubGlobal("fetch", fetchMock);
    const d = new OpenRouterDriver("k", "m", undefined, { providerSort: false });
    await d.answer(ctx, { taskId: 1, question: "q" });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.provider).toEqual({ ignore: ["inceptron"] });
  });

  it("merges provider sort and max-price controls", async () => {
    const fetchMock = fetchReturning([answerPayload]);
    vi.stubGlobal("fetch", fetchMock);
    const d = new OpenRouterDriver("k", "m", undefined, {
      providerSort: "price",
      providerMaxPrice: { prompt: 1.25, completion: 2.5 },
    });
    await d.answer(ctx, { taskId: 1, question: "q" });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.provider).toEqual({
      sort: "price",
      max_price: { prompt: 1.25, completion: 2.5 },
      ignore: ["inceptron"],
    });
  });

  it.each(["openrouter/auto", "openrouter/auto-beta"])("configures Auto Router defaults for %s", async (model) => {
    const fetchMock = fetchReturning([answerPayload]);
    vi.stubGlobal("fetch", fetchMock);
    const d = new OpenRouterDriver("k", model);
    await d.answer(ctx, { taskId: 1, question: "q" });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.models).toEqual(DEFAULT_AUTO_FALLBACK_MODELS);
    expect(body.plugins).toEqual([{ id: "auto-router", cost_quality_tradeoff: 7 }]);
  });

  it("grooms and reviews through the auto-beta routed payload", async () => {
    const fetchMock = fetchReturning([
      { action: "merge", into_task_id: 7, rationale: "same work" },
      { verdict: "approved", feedback: "", rationale: "complete plan" },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const d = new OpenRouterDriver("k", "openrouter/auto-beta");

    await expect(d.groom(ctx, {
      taskId: 9, title: "t", body: "b", priority: 2, submittedBy: "dana", evidence: [],
    })).resolves.toMatchObject({ action: "merge", into_task_id: 7 });
    await expect(d.review(ctx, { taskId: 9, task: { title: "t", body: "b", groomingRationale: "g" }, plan: "implement and verify" })).resolves.toMatchObject({
      verdict: "approved",
    });
    const bodies = fetchMock.mock.calls.map((call) => JSON.parse((call[1] as { body: string }).body));
    expect(bodies.map((body) => body.response_format.json_schema.name)).toEqual(["groom_result", "review_result"]);
    expect(bodies.every((body) => body.provider.require_parameters === true)).toBe(true);
    expect(bodies.every((body) => body.models.length === 2)).toBe(true);
  });

  it("keeps strict review schema bytes stable ahead of messages on cached turns", async () => {
    const payload = { verdict: "approved", feedback: "", rationale: "complete plan" };
    const fetchMock = fetchReturning(Array.from({ length: 6 }, () => payload));
    vi.stubGlobal("fetch", fetchMock);
    const d = new OpenRouterDriver("k", "z-ai/glm-5.2", undefined, {
      promptCacheMode: "on",
      cacheSessionId: "memracer:p:review-job",
    });

    for (let turn = 0; turn < 6; turn += 1) {
      await d.review(ctx, { taskId: 9, task: { title: "t", body: "b", groomingRationale: "g" }, plan: `implement and verify turn ${turn}` });
    }

    const rawBodies = fetchMock.mock.calls.map((call) => (call[1] as { body: string }).body);
    const schemas = rawBodies.map((raw) => JSON.stringify(JSON.parse(raw).response_format));
    expect(new Set(schemas).size).toBe(1);
    expect(rawBodies.every((raw) => raw.indexOf('"response_format"') < raw.indexOf('"messages"'))).toBe(true);
  });

  it("supports Auto Router overrides and validated environment configuration", async () => {
    const options = openRouterOptionsFromEnv({
      OPENROUTER_COST_QUALITY_TRADEOFF: "2.5",
      OPENROUTER_FALLBACK_MODELS: "anthropic/claude-sonnet-4.6, z-ai/glm-5.2",
      OPENROUTER_PROVIDER_SORT: "throughput",
      OPENROUTER_MAX_PROMPT_PRICE: "3",
      OPENROUTER_REQUEST_TIMEOUT_MS: "20000",
      OPENROUTER_MAX_TOKENS: "24000",
    });
    expect(options).toEqual({
      costQualityTradeoff: 2.5,
      fallbackModels: ["anthropic/claude-sonnet-4.6", "z-ai/glm-5.2"],
      providerSort: "throughput",
      providerMaxPrice: { prompt: 3 },
      requestTimeoutMs: 20_000,
      maxTokens: 24_000,
      providerIgnore: ["inceptron"],
      reasoning: false,
      maxToolIters: 12,
      promptCacheMode: "canary",
      promptCacheCanaryPercent: 1,
    });
    expect(promptCacheEnabled("off", 1, "job-1")).toBe(false);
    expect(promptCacheEnabled("on", 1, "job-1")).toBe(true);
    expect(Array.from({ length: 100 }, (_, i) => promptCacheEnabled("canary", 5, `job-${i}`)).filter(Boolean).length).toBeGreaterThan(0);
    expect(() => openRouterOptionsFromEnv({ OPENROUTER_COST_QUALITY_TRADEOFF: "11" })).toThrow(/0 to 10/);
    expect(() => openRouterOptionsFromEnv({ OPENROUTER_PROVIDER_SORT: "random" })).toThrow(/PROVIDER_SORT/);
    expect(() => openRouterOptionsFromEnv({ OPENROUTER_REQUEST_TIMEOUT_MS: "0" })).toThrow(/REQUEST_TIMEOUT/);
    expect(() => openRouterOptionsFromEnv({ OPENROUTER_MAX_TOKENS: "1024.5" })).toThrow(/MAX_TOKENS/);
    expect(() => openRouterOptionsFromEnv({ OPENROUTER_MAX_TOKENS: "70000" })).toThrow(/MAX_TOKENS/);
    expect(() => openRouterOptionsFromEnv({ OPENROUTER_PROMPT_CACHE_MODE: "always" })).toThrow(/PROMPT_CACHE_MODE/);
    expect(() => openRouterOptionsFromEnv({ OPENROUTER_PROMPT_CACHE_CANARY_PERCENT: "6" })).toThrow(/CANARY_PERCENT/);
    expect(() => openRouterOptionsFromEnv({ OPENROUTER_REASONING: "sometimes" })).toThrow(/REASONING/);
    expect(() => openRouterOptionsFromEnv({ OPENROUTER_REASONING: "1.5" })).toThrow(/REASONING/);
    expect(() => openRouterOptionsFromEnv({ OPENROUTER_REASONING: "1023" })).toThrow(/REASONING/);
    expect(() => openRouterOptionsFromEnv({ OPENROUTER_REASONING: "4096", OPENROUTER_MAX_TOKENS: "4096" })).toThrow(/strictly less/);
    expect(() => openRouterOptionsFromEnv({ OPENROUTER_MAX_TOOL_ITERS: "0" })).toThrow(/MAX_TOOL_ITERS/);
    expect(() => openRouterOptionsFromEnv({ OPENROUTER_MAX_TOOL_ITERS: "41" })).toThrow(/MAX_TOOL_ITERS/);
  });

  it("returns explicit environment defaults and parses reliability overrides", () => {
    expect(openRouterOptionsFromEnv({})).toMatchObject({
      providerIgnore: ["inceptron"],
      reasoning: false,
      maxToolIters: 12,
      requestTimeoutMs: 180_000,
    });
    expect(openRouterOptionsFromEnv({
      OPENROUTER_IGNORE_PROVIDERS: "slow-a, slow-b",
      OPENROUTER_REASONING: "4096",
      OPENROUTER_MAX_TOOL_ITERS: "20",
      OPENROUTER_REQUEST_TIMEOUT_MS: "240000",
    })).toMatchObject({
      providerIgnore: ["inceptron", "slow-a", "slow-b"],
      reasoning: { max_tokens: 4_096 },
      maxToolIters: 20,
      requestTimeoutMs: 240_000,
    });
    expect(openRouterOptionsFromEnv({ OPENROUTER_REASONING: "on" }).reasoning).toBe(true);
    expect(openRouterOptionsFromEnv({ OPENROUTER_REASONING: "none" }).reasoning).toBe(false);
    expect(openRouterOptionsFromEnv({ OPENROUTER_REASONING: "low" }).reasoning).toEqual({ effort: "low" });
    expect(openRouterOptionsFromEnv({ OPENROUTER_REASONING: "high" }).reasoning).toEqual({ effort: "high" });
    expect(openRouterOptionsFromEnv({ OPENROUTER_REASONING: "xhigh" }).reasoning).toEqual({ effort: "xhigh" });
    expect(openRouterOptionsFromEnv({ OPENROUTER_IGNORE_PROVIDERS: "" }).providerIgnore).toEqual(["inceptron"]);
  });
});

describe("OpenRouterDriver hedging", () => {
  it("shares one request deadline across retries and backoff", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => ({ ok: false, status: 429, text: async () => "retry later" }) as Response);
    const pending = new OpenRouterDriver("k", "m", undefined, {
      fetch: fetchMock,
      retryBaseDelayMs: 100,
      requestTimeoutMs: 250,
      hedgeDelayMs: 1_000,
    }).answer(ctx, { taskId: 1, question: "q" });
    const failure = pending.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(249);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(failure).resolves.toMatchObject({
      _tag: "OpenRouterTimeoutError",
      message: "openrouter request timed out after 250ms",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("allows a completion to finish after the former 45-second deadline", async () => {
    vi.useFakeTimers();
    const { fn } = timedFetch([
      { delayMs: 60_000, payload: answerPayload },
      { delayMs: 60_000, payload: answerPayload },
    ]);
    vi.stubGlobal("fetch", fn);
    const pending = new OpenRouterDriver("k", "m").answer(ctx, { taskId: 1, question: "q" });
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(pending).resolves.toEqual(answerPayload);
  });

  it("aborts every in-flight request at the hard model-call deadline", async () => {
    vi.useFakeTimers();
    const { fn, aborted } = timedFetch([
      { delayMs: 60_000, payload: answerPayload },
      { delayMs: 60_000, payload: answerPayload },
    ]);
    vi.stubGlobal("fetch", fn);
    const d = new OpenRouterDriver("k", "m", undefined, {
      hedgeDelayMs: 500,
      requestTimeoutMs: 2_000,
    });
    const p = d.answer(ctx, { taskId: 1, question: "q" });
    const failurePromise = p.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2_000);
    const failure = await failurePromise;
    expect(failure).toBeInstanceOf(OpenRouterTimeoutError);
    expect(failure).toMatchObject({
      _tag: "OpenRouterTimeoutError",
      message: "openrouter request timed out after 2000ms",
      model: "m",
    });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(aborted).toEqual([true, true]);
  });

  it("settles a non-cooperative request before hedge creation without launching the hedge", async () => {
    vi.useFakeTimers();
    const listenerBalance = trackHedgeAbortListenerBalance();
    const { fn, signals } = neverSettlingFetch();
    vi.stubGlobal("fetch", fn);
    const pending = new OpenRouterDriver("k", "m", undefined, {
      hedgeDelayMs: 50,
      requestTimeoutMs: 10,
    }).answer(ctx, { taskId: 1, question: "q" });
    const failurePromise = pending.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(10);
    await expect(failurePromise).resolves.toMatchObject({ _tag: "OpenRouterTimeoutError" });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(listenerBalance()).toBe(0);

    await vi.advanceTimersByTimeAsync(100);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(listenerBalance()).toBe(0);
  });

  it("settles a non-cooperative request after hedge creation without lingering resources", async () => {
    vi.useFakeTimers();
    const listenerBalance = trackHedgeAbortListenerBalance();
    const { fn, signals } = neverSettlingFetch();
    vi.stubGlobal("fetch", fn);
    const pending = new OpenRouterDriver("k", "m", undefined, {
      hedgeDelayMs: 10,
      requestTimeoutMs: 50,
    }).answer(ctx, { taskId: 1, question: "q" });
    const failurePromise = pending.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(50);
    await expect(failurePromise).resolves.toMatchObject({ _tag: "OpenRouterTimeoutError" });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(listenerBalance()).toBe(0);
  });

  it("fast path: no hedge fired when the primary resolves before the delay", async () => {
    vi.useFakeTimers();
    const meter = vi.fn();
    const { fn } = timedFetch([{ delayMs: 1_000, payload: answerPayload }]);
    vi.stubGlobal("fetch", fn);
    const d = new OpenRouterDriver("k", "m", undefined, { meter });
    const p = d.answer(ctx, { taskId: 1, question: "q" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await p).toEqual(answerPayload);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(meter).toHaveBeenCalledTimes(1);
    // fully drain: no hedge ever fires
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("slow primary: hedge fires at the delay, wins, and the primary is aborted", async () => {
    vi.useFakeTimers();
    const meter = vi.fn();
    const { fn, aborted } = timedFetch([
      { delayMs: 60_000, payload: answerPayload }, // primary: too slow
      { delayMs: 1_000, payload: answerPayload }, // hedge: fast
    ]);
    vi.stubGlobal("fetch", fn);
    const d = new OpenRouterDriver("k", "m", undefined, { meter });
    const p = d.answer(ctx, { taskId: 1, question: "q" });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_002); // hedge fires at 10s, resolves at 11s
    expect(await p).toEqual(answerPayload);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(aborted[0]).toBe(true);
    expect(aborted[1]).toBe(false);
    expect(meter).toHaveBeenCalledTimes(1);
    // hedge (call index 1) is the winner — only its usage is metered
    expect(meter).toHaveBeenCalledWith(expect.objectContaining({ promptTokens: 101, completionTokens: 51 }));
    // identical request body on both attempts
    const bodies = fn.mock.calls.map((c) => (c[1] as { body: string }).body);
    expect(bodies[0]).toBe(bodies[1]);
  });

  it("both slow: whichever resolves first wins, the other is aborted", async () => {
    vi.useFakeTimers();
    const meter = vi.fn();
    const { fn, aborted } = timedFetch([
      { delayMs: 25_000, payload: answerPayload }, // primary resolves at 25s
      { delayMs: 30_000, payload: answerPayload }, // hedge would resolve at 40s
    ]);
    vi.stubGlobal("fetch", fn);
    const d = new OpenRouterDriver("k", "m", undefined, { meter });
    const p = d.answer(ctx, { taskId: 1, question: "q" });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await p).toEqual(answerPayload);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(aborted[0]).toBe(false);
    expect(aborted[1]).toBe(true);
    expect(meter).toHaveBeenCalledTimes(1);
    expect(meter).toHaveBeenCalledWith(expect.objectContaining({ promptTokens: 100, completionTokens: 50 }));
  });

  it("does not double-meter when the aborted loser resolves anyway", async () => {
    vi.useFakeTimers();
    const meter = vi.fn();
    const { fn } = timedFetch([
      { delayMs: 12_000, payload: answerPayload, ignoreAbort: true }, // primary resolves at 12s despite abort
      { delayMs: 100, payload: answerPayload }, // hedge wins at 10.1s
    ]);
    vi.stubGlobal("fetch", fn);
    const d = new OpenRouterDriver("k", "m", undefined, { meter });
    const p = d.answer(ctx, { taskId: 1, question: "q" });
    await vi.advanceTimersByTimeAsync(12_000);
    expect(await p).toEqual(answerPayload);
    expect(meter).toHaveBeenCalledTimes(1);
    expect(meter).toHaveBeenCalledWith(expect.objectContaining({ promptTokens: 101, completionTokens: 51 }));
  });

  it("primary fails after the hedge started and the hedge also fails: error propagates", async () => {
    vi.useFakeTimers();
    const { fn } = timedFetch([
      { delayMs: 12_000, error: "primary boom" },
      { delayMs: 3_000, error: "hedge boom" }, // hedge fails at 13s absolute
    ]);
    vi.stubGlobal("fetch", fn);
    const d = new OpenRouterDriver("k", "m");
    const p = d.answer(ctx, { taskId: 1, question: "q" });
    const rejection = expect(p).rejects.toThrow(/boom/);
    await vi.advanceTimersByTimeAsync(13_000);
    await rejection;
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("primary fails before the hedge delay: error propagates without a hedge", async () => {
    vi.useFakeTimers();
    const { fn } = timedFetch([{ delayMs: 2_000, error: "early boom" }]);
    vi.stubGlobal("fetch", fn);
    const d = new OpenRouterDriver("k", "m");
    const p = d.answer(ctx, { taskId: 1, question: "q" });
    const rejection = expect(p).rejects.toThrow(/early boom/);
    await vi.advanceTimersByTimeAsync(2_000);
    await rejection;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("hedgeDelayMs is constructor-configurable", async () => {
    vi.useFakeTimers();
    const { fn, aborted } = timedFetch([
      { delayMs: 60_000, payload: answerPayload },
      { delayMs: 100, payload: answerPayload },
    ]);
    vi.stubGlobal("fetch", fn);
    const d = new OpenRouterDriver("k", "m", undefined, { hedgeDelayMs: 500 });
    const p = d.answer(ctx, { taskId: 1, question: "q" });
    await vi.advanceTimersByTimeAsync(600);
    expect(await p).toEqual(answerPayload);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(aborted[0]).toBe(true);
  });

  it("hedges per attempt: a schema-invalid first attempt still hedges on the retry", async () => {
    vi.useFakeTimers();
    const { fn } = timedFetch([
      { delayMs: 1_000, payload: { nonsense: true } }, // attempt 1 primary: fast but invalid
      { delayMs: 60_000, payload: answerPayload }, // attempt 2 primary: slow
      { delayMs: 1_000, payload: answerPayload }, // attempt 2 hedge: wins
    ]);
    vi.stubGlobal("fetch", fn);
    const d = new OpenRouterDriver("k", "m");
    const p = d.answer(ctx, { taskId: 1, question: "q" });
    await vi.advanceTimersByTimeAsync(1_000); // attempt 1 resolves, schema-invalid
    await vi.advanceTimersByTimeAsync(11_000); // attempt 2: hedge at 10s, resolves 1s later
    expect(await p).toEqual(answerPayload);
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
