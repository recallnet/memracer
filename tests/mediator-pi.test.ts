import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediatorContext } from "../src/mediator/driver.js";
import { SYSTEM, buildAnswerPrompt, buildGroomPrompt, buildRetryPrompt } from "../src/mediator/prompts.js";

const promptCalls: string[] = [];
let responses: string[] = [];
let disposeCount = 0;
let systemPromptSeen: string | undefined;
let createOptionsSeen: Record<string, unknown>[] = [];

/** Timed session specs for the hedging tests. When non-empty they take precedence over `responses`. */
interface TimedSpec {
  delayMs: number;
  text?: string;
  error?: string;
  /** Simulate a session whose in-flight prompt keeps running to completion despite abort(). */
  ignoreAbort?: boolean;
}
let timedSpecs: TimedSpec[] = [];
/** Per created session (creation order): whether abort() was called on it. */
let sessionAborts: boolean[] = [];
let sessionsCreated = 0;

// The real sandbox mkdtemp is libuv-backed fs I/O, which never completes while
// vitest fake timers control the clock — stub it with a microtask.
vi.mock("node:fs/promises", () => ({
  mkdtemp: async (prefix: string) => `${prefix}stub`,
}));

vi.mock("@earendil-works/pi-coding-agent", () => {
  class FakeAuthStorage {
    static create() {
      return new FakeAuthStorage();
    }
    setRuntimeApiKey() {}
  }
  class FakeModelRegistry {
    static inMemory() {
      return new FakeModelRegistry();
    }
    find(provider: string, id: string) {
      if (provider === "openrouter" && id !== "missing/model") return { provider, id };
      return undefined;
    }
  }
  class FakeSessionManager {
    static inMemory() {
      return new FakeSessionManager();
    }
  }
  class FakeSettingsManager {
    static inMemory() {
      return new FakeSettingsManager();
    }
  }
  class FakeDefaultResourceLoader {
    constructor(opts: { systemPromptOverride?: () => string | undefined }) {
      systemPromptSeen = opts.systemPromptOverride?.();
    }
    async reload() {}
  }
  return {
    AuthStorage: FakeAuthStorage,
    ModelRegistry: FakeModelRegistry,
    SessionManager: FakeSessionManager,
    SettingsManager: FakeSettingsManager,
    DefaultResourceLoader: FakeDefaultResourceLoader,
    createAgentSession: vi.fn(async (opts: Record<string, unknown>) => {
      createOptionsSeen.push(opts);
      const idx = sessionsCreated++;
      sessionAborts.push(false);
      const spec = timedSpecs.length > 0 ? timedSpecs[Math.min(idx, timedSpecs.length - 1)] : null;
      const text = responses[Math.min(promptCalls.length, responses.length - 1)] ?? "";
      let aborted = false;
      let finish: (() => void) | undefined;
      const session = {
        messages: [] as unknown[],
        async prompt(p: string) {
          promptCalls.push(p);
          if (!spec) {
            this.messages.push({
              role: "assistant",
              content: [{ type: "text", text }],
              usage: { input: 11, output: 7 },
            });
            return;
          }
          await new Promise<void>((resolve) => {
            finish = resolve;
            setTimeout(resolve, spec.delayMs);
          });
          if (aborted && !spec.ignoreAbort) return;
          if (spec.error) throw new Error(spec.error);
          this.messages.push({
            role: "assistant",
            content: [{ type: "text", text: spec.text ?? "" }],
            usage: { input: 100 + idx, output: 50 + idx },
          });
        },
        async abort() {
          sessionAborts[idx] = true;
          if (spec?.ignoreAbort) return;
          aborted = true;
          finish?.();
        },
        dispose() {
          disposeCount++;
        },
        agent: { state: { errorMessage: undefined } },
      };
      return { session, extensionsResult: { extensions: [], errors: [] } };
    }),
  };
});

const { PiDriver } = await import("../src/mediator/pi.js");

const ctx: MediatorContext = {
  projectId: "p",
  projectName: "P",
  queue: [{ id: 7, title: "existing", state: "QUEUED", priority: 1 }],
  decisions: [],
  memory: "",
};

beforeEach(() => {
  promptCalls.length = 0;
  responses = [];
  disposeCount = 0;
  systemPromptSeen = undefined;
  createOptionsSeen = [];
  timedSpecs = [];
  sessionAborts = [];
  sessionsCreated = 0;
  vi.useRealTimers();
});

describe("PiDriver", () => {
  it("grooms via a fresh no-tool session and validates the result", async () => {
    responses = [JSON.stringify({ action: "merge", into_task_id: 7, rationale: "dup" })];
    const d = new PiDriver("key", "z-ai/glm-5.2");
    const submission = { taskId: 9, title: "t", body: "b", priority: 2, submittedBy: "dana", evidence: [] };
    const result = await d.groom(ctx, submission);
    expect(result).toEqual({ action: "merge", into_task_id: 7, rationale: "dup" });
    expect(promptCalls).toEqual([buildGroomPrompt(ctx, submission)]);
    expect(systemPromptSeen).toBe(SYSTEM);
    expect(createOptionsSeen[0].noTools).toBe("all");
    expect(disposeCount).toBe(1);
  });

  it("points the session cwd at a sandbox temp dir, never the repo", async () => {
    responses = [JSON.stringify({ escalate: true, rationale: "r" })];
    const d = new PiDriver("key", "z-ai/glm-5.2");
    await d.answer(ctx, { taskId: 1, question: "q" });
    const cwd = createOptionsSeen[0].cwd as string;
    const { tmpdir } = await import("node:os");
    const { realpathSync } = await import("node:fs");
    expect(cwd.startsWith(realpathSync(tmpdir())) || cwd.startsWith(tmpdir())).toBe(true);
    expect(cwd).not.toBe(process.cwd());
    expect(cwd.startsWith(process.cwd())).toBe(false);
  });

  it("retries once with the shared corrective prompt, then succeeds", async () => {
    responses = [
      JSON.stringify({ nonsense: true }),
      JSON.stringify({ escalate: false, answer: "yes", rationale: "r" }),
    ];
    const d = new PiDriver("key", "z-ai/glm-5.2");
    const result = await d.answer(ctx, { taskId: 1, question: "q" });
    expect(result).toEqual({ escalate: false, answer: "yes", rationale: "r" });
    const base = buildAnswerPrompt(ctx, { taskId: 1, question: "q" });
    expect(promptCalls).toEqual([base, buildRetryPrompt(base, JSON.stringify({ nonsense: true }))]);
    expect(disposeCount).toBe(2);
  });

  it("retries a recommendation-free groom clarification", async () => {
    const invalid = JSON.stringify({ action: "clarify", question: "Which region?", rationale: "missing recommendation" });
    const valid = {
      action: "clarify",
      question: "Which region should host it? Recommended: eu-west-1 — it matches deployment.",
      rationale: "human-owned deployment decision",
    };
    responses = [invalid, JSON.stringify(valid)];
    const d = new PiDriver("key", "z-ai/glm-5.2");
    const submission = { taskId: 9, title: "t", body: "b", priority: 2 as const, submittedBy: "dana", evidence: [] };
    expect(await d.groom(ctx, submission)).toEqual(valid);
    const base = buildGroomPrompt(ctx, submission);
    expect(promptCalls).toEqual([base, buildRetryPrompt(base, invalid)]);
  });

  it("throws after the second invalid output", async () => {
    responses = ["not json", "still not json"];
    const d = new PiDriver("key", "z-ai/glm-5.2");
    await expect(d.answer(ctx, { taskId: 1, question: "q" })).rejects.toThrow(
      /invalid mediator output after retry/,
    );
    expect(promptCalls).toHaveLength(2);
  });

  it("unwraps a markdown-fenced JSON payload", async () => {
    responses = ['```json\n{"escalate":true,"rationale":"r"}\n```'];
    const d = new PiDriver("key", "z-ai/glm-5.2");
    expect(await d.answer(ctx, { taskId: 1, question: "q" })).toEqual({ escalate: true, rationale: "r" });
  });

  it("discuss sends the shared discuss prompt and validates the result", async () => {
    const { buildDiscussPrompt } = await import("../src/mediator/prompts.js");
    const payload = {
      reply: "closed it",
      actions: [{ action: "close_task", task_id: 7, reason: "shipped" }],
      rationale: "member asked",
    };
    responses = [JSON.stringify(payload)];
    const d = new PiDriver("key", "z-ai/glm-5.2");
    const input = { message: "close task 7, it shipped", from: "dana" };
    expect(await d.discuss(ctx, input)).toEqual(payload);
    expect(promptCalls).toEqual([buildDiscussPrompt(ctx, input)]);
  });

  it("reports token usage through the meter", async () => {
    responses = [JSON.stringify({ escalate: true, rationale: "r" })];
    const meter = vi.fn();
    const d = new PiDriver("key", "z-ai/glm-5.2", { meter });
    await d.answer(ctx, { taskId: 1, question: "q" });
    expect(meter).toHaveBeenCalledWith({ promptTokens: 11, completionTokens: 7 });
  });

  it("rejects a model the registry does not know", async () => {
    const d = new PiDriver("key", "missing/model");
    await expect(d.answer(ctx, { taskId: 1, question: "q" })).rejects.toThrow(/missing\/model/);
  });
});

describe("PiDriver hedging", () => {
  const answerText = JSON.stringify({ escalate: false, answer: "yes", rationale: "r" });
  const answerPayload = { escalate: false, answer: "yes", rationale: "r" };

  it("fast path: no hedge session when the primary resolves before the delay", async () => {
    vi.useFakeTimers();
    const meter = vi.fn();
    timedSpecs = [{ delayMs: 1_000, text: answerText }];
    const d = new PiDriver("key", "z-ai/glm-5.2", { meter });
    const p = d.answer(ctx, { taskId: 1, question: "q" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await p).toEqual(answerPayload);
    expect(sessionsCreated).toBe(1);
    expect(meter).toHaveBeenCalledTimes(1);
    // fully drain: no hedge session ever spawns
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sessionsCreated).toBe(1);
  });

  it("slow primary: hedge session fires at the delay, wins, and the primary is aborted", async () => {
    vi.useFakeTimers();
    const meter = vi.fn();
    timedSpecs = [
      { delayMs: 60_000, text: answerText }, // primary: too slow
      { delayMs: 1_000, text: answerText }, // hedge: fast
    ];
    const d = new PiDriver("key", "z-ai/glm-5.2", { meter });
    const p = d.answer(ctx, { taskId: 1, question: "q" });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(sessionsCreated).toBe(1);
    await vi.advanceTimersByTimeAsync(1_002); // hedge fires at 10s, resolves at 11s
    expect(await p).toEqual(answerPayload);
    expect(sessionsCreated).toBe(2);
    expect(sessionAborts[0]).toBe(true);
    expect(sessionAborts[1]).toBe(false);
    // hedge (session index 1) is the winner — only its usage is metered
    expect(meter).toHaveBeenCalledTimes(1);
    expect(meter).toHaveBeenCalledWith({ promptTokens: 101, completionTokens: 51 });
    // identical prompt on both attempts
    expect(promptCalls).toHaveLength(2);
    expect(promptCalls[0]).toBe(promptCalls[1]);
    // both sessions are disposed
    expect(disposeCount).toBe(2);
  });

  it("both slow: whichever resolves first wins, the other is aborted", async () => {
    vi.useFakeTimers();
    const meter = vi.fn();
    timedSpecs = [
      { delayMs: 25_000, text: answerText }, // primary resolves at 25s
      { delayMs: 30_000, text: answerText }, // hedge would resolve at 40s
    ];
    const d = new PiDriver("key", "z-ai/glm-5.2", { meter });
    const p = d.answer(ctx, { taskId: 1, question: "q" });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await p).toEqual(answerPayload);
    expect(sessionsCreated).toBe(2);
    expect(sessionAborts[0]).toBe(false);
    expect(sessionAborts[1]).toBe(true);
    expect(meter).toHaveBeenCalledTimes(1);
    expect(meter).toHaveBeenCalledWith({ promptTokens: 100, completionTokens: 50 });
  });

  it("does not double-meter when the aborted loser resolves anyway", async () => {
    vi.useFakeTimers();
    const meter = vi.fn();
    timedSpecs = [
      { delayMs: 12_000, text: answerText, ignoreAbort: true }, // primary resolves at 12s despite abort
      { delayMs: 100, text: answerText }, // hedge wins at 10.1s
    ];
    const d = new PiDriver("key", "z-ai/glm-5.2", { meter });
    const p = d.answer(ctx, { taskId: 1, question: "q" });
    await vi.advanceTimersByTimeAsync(12_000);
    expect(await p).toEqual(answerPayload);
    expect(meter).toHaveBeenCalledTimes(1);
    expect(meter).toHaveBeenCalledWith({ promptTokens: 101, completionTokens: 51 });
  });

  it("primary fails before the hedge delay: error propagates without a hedge", async () => {
    vi.useFakeTimers();
    timedSpecs = [{ delayMs: 2_000, error: "early boom" }];
    const d = new PiDriver("key", "z-ai/glm-5.2");
    const p = d.answer(ctx, { taskId: 1, question: "q" });
    const rejection = expect(p).rejects.toThrow(/early boom/);
    await vi.advanceTimersByTimeAsync(2_000);
    await rejection;
    expect(sessionsCreated).toBe(1);
    // fully drain: the hedge timer was cancelled
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sessionsCreated).toBe(1);
  });

  it("primary fails after the hedge started and the hedge also fails: error propagates", async () => {
    vi.useFakeTimers();
    timedSpecs = [
      { delayMs: 12_000, error: "primary boom" },
      { delayMs: 3_000, error: "hedge boom" }, // hedge fails at 13s absolute
    ];
    const d = new PiDriver("key", "z-ai/glm-5.2");
    const p = d.answer(ctx, { taskId: 1, question: "q" });
    const rejection = expect(p).rejects.toThrow(/boom/);
    await vi.advanceTimersByTimeAsync(13_000);
    await rejection;
    expect(sessionsCreated).toBe(2);
  });

  it("honors a custom hedgeDelayMs", async () => {
    vi.useFakeTimers();
    timedSpecs = [
      { delayMs: 60_000, text: answerText },
      { delayMs: 500, text: answerText },
    ];
    const d = new PiDriver("key", "z-ai/glm-5.2", { hedgeDelayMs: 2_000 });
    const p = d.answer(ctx, { taskId: 1, question: "q" });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(sessionsCreated).toBe(1);
    await vi.advanceTimersByTimeAsync(501);
    expect(await p).toEqual(answerPayload);
    expect(sessionsCreated).toBe(2);
    expect(sessionAborts[0]).toBe(true);
  });
});
