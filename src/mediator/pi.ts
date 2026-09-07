import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { z } from "zod";
import type {
  AnswerInput,
  AnswerResult,
  ConciliateInput,
  ConciliateResult,
  DiscussInput,
  DiscussResult,
  EnhanceInput,
  EnhanceResult,
  GroomResult,
  MediatorContext,
  MediatorDriver,
  ReviewInput,
  ReviewResult,
  Submission,
} from "./driver.js";
import { SYSTEM, buildAnswerPrompt, buildConciliatePrompt, buildDiscussPrompt, buildEligibilityPrompt, buildEnhancePrompt, buildGroomPrompt, buildRetryPrompt, buildReviewPrompt } from "./prompts.js";
import { answerSchema, conciliateSchema, discussSchema, eligibilitySchema, enhanceSchema, groomSchema, reviewSchema } from "./schemas.js";

export interface PiDriverOptions {
  /** Called with token usage after every completion that reports it. Only the winning response of a hedged pair is metered. */
  meter?: (u: { promptTokens: number; completionTokens: number }) => void;
  /**
   * If a completion hasn't resolved within this many ms, fire one duplicate
   * session and race them (tail-latency hedge). Default 10_000.
   */
  hedgeDelayMs?: number;
}

interface CompletionResult {
  text: string;
  /** Model chain-of-thought (reasoning content parts), when the model emits it. */
  reasoning?: string;
  usage?: { promptTokens: number; completionTokens: number };
}

/** Strip a surrounding markdown code fence — reasoning models sometimes wrap JSON despite the system prompt. */
function unfence(raw: string): string {
  const trimmed = raw.trim();
  const match = /^```[a-zA-Z]*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return match ? match[1] : trimmed;
}

/**
 * Mediator driver candidate B: runs each job as a fresh headless pi session
 * (in-memory, no tools, empty sandbox cwd) against an OpenRouter model.
 * Sends the exact prompts from ./prompts.js so evals compare models, not prompts.
 */
export class PiDriver implements MediatorDriver {
  private sandbox: Promise<string> | undefined;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly options: PiDriverOptions = {},
  ) {}

  /** Empty temp dir shared by this driver's sessions — pi never sees the repo. */
  private sandboxDir(): Promise<string> {
    this.sandbox ??= mkdtemp(join(tmpdir(), "memracer-pi-"));
    return this.sandbox;
  }

  /** One prompt through one fresh in-memory session; returns the assistant's final text and usage. */
  private async completeOnce(prompt: string, signal: AbortSignal): Promise<CompletionResult> {
    const cwd = await this.sandboxDir();
    if (signal.aborted) throw new Error("pi: aborted");
    const authStorage = AuthStorage.create(join(cwd, "auth.json"));
    authStorage.setRuntimeApiKey("openrouter", this.apiKey);
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    const model = modelRegistry.find("openrouter", this.model);
    if (!model) throw new Error(`pi: model "${this.model}" not found for provider "openrouter"`);

    const settingsManager = SettingsManager.inMemory({});
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: cwd,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: () => SYSTEM,
      appendSystemPromptOverride: () => [],
    });
    await loader.reload();

    const { session } = await createAgentSession({
      cwd,
      agentDir: cwd,
      model,
      authStorage,
      modelRegistry,
      settingsManager,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(),
      noTools: "all",
    });
    const onAbort = () => {
      void session.abort();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await session.prompt(prompt);
      if (signal.aborted) throw new Error("pi: aborted");
      const assistant = [...session.messages]
        .reverse()
        .find((m): m is Extract<typeof m, { role: "assistant" }> => m.role === "assistant");
      if (!assistant) {
        throw new Error(`pi: no assistant response${session.agent.state.errorMessage ? `: ${session.agent.state.errorMessage}` : ""}`);
      }
      if (assistant.errorMessage) throw new Error(`pi: assistant error: ${assistant.errorMessage}`);
      // Reasoning models expose chain-of-thought as separate content parts;
      // capture them (best-effort — part shape varies by model) rather than
      // discarding, so a session can record a reasoning event.
      const reasoning = assistant.content
        .filter((c) => c.type === "thinking")
        .map((c) => (c as { text?: string; thinking?: string }).text ?? (c as { thinking?: string }).thinking ?? "")
        .join("")
        .trim();
      return {
        text: assistant.content
          .filter((c): c is Extract<(typeof assistant.content)[number], { type: "text" }> => c.type === "text")
          .map((c) => c.text)
          .join(""),
        reasoning: reasoning || undefined,
        usage: assistant.usage
          ? { promptTokens: assistant.usage.input, completionTokens: assistant.usage.output }
          : undefined,
      };
    } finally {
      signal.removeEventListener("abort", onAbort);
      session.dispose();
    }
  }

  /**
   * One attempt with tail-latency hedging: start the primary session; if it
   * hasn't settled after hedgeDelayMs, fire one identical duplicate and race.
   * First response wins; the loser is aborted. Errors reject only once no
   * request can still win. Structural port of OpenRouterDriver.hedgedRequest.
   */
  private hedgedCompleteOnce(prompt: string): Promise<CompletionResult> {
    const hedgeDelayMs = this.options.hedgeDelayMs ?? 10_000;
    return new Promise<CompletionResult>((resolve, reject) => {
      const primaryCtl = new AbortController();
      let hedgeCtl: AbortController | null = null;
      let settled = false;
      let primaryFailed = false;
      let hedgeFailed = false;

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      const primary = this.completeOnce(prompt, primaryCtl.signal);
      const timer = setTimeout(() => {
        if (settled) return;
        hedgeCtl = new AbortController();
        this.completeOnce(prompt, hedgeCtl.signal).then(
          (result) => settle(() => {
            primaryCtl.abort();
            resolve(result);
          }),
          (err: unknown) => {
            hedgeFailed = true;
            if (primaryFailed) settle(() => reject(err));
          },
        );
      }, hedgeDelayMs);

      primary.then(
        (result) => settle(() => {
          hedgeCtl?.abort();
          resolve(result);
        }),
        (err: unknown) => {
          primaryFailed = true;
          if (hedgeCtl === null || hedgeFailed) settle(() => reject(err));
        },
      );
    });
  }

  private async complete<T>(schema: z.ZodType<T>, prompt: string): Promise<T> {
    let current = prompt;
    for (let attempt = 0; attempt < 2; attempt++) {
      const { text: raw, reasoning, usage } = await this.hedgedCompleteOnce(current);
      if (usage && this.options.meter) this.options.meter(usage);
      let parsed: unknown;
      try {
        parsed = JSON.parse(unfence(raw));
      } catch {
        parsed = undefined;
      }
      const checked = schema.safeParse(parsed);
      if (checked.success) {
        return reasoning && checked.data && typeof checked.data === "object"
          ? { ...checked.data, reasoning }
          : checked.data;
      }
      current = buildRetryPrompt(prompt, raw);
    }
    throw new Error("invalid mediator output after retry");
  }

  async groom(ctx: MediatorContext, s: Submission): Promise<GroomResult> {
    return this.complete(groomSchema, buildGroomPrompt(ctx, s));
  }

  async review(ctx: MediatorContext, input: ReviewInput): Promise<ReviewResult> {
    return this.complete(reviewSchema, buildReviewPrompt(ctx, input));
  }

  async answer(ctx: MediatorContext, input: AnswerInput): Promise<AnswerResult> {
    return this.complete(answerSchema, buildAnswerPrompt(ctx, input));
  }

  async discuss(ctx: MediatorContext, input: DiscussInput): Promise<DiscussResult> {
    return this.complete(discussSchema, buildDiscussPrompt(ctx, input));
  }

  async enhance(ctx: MediatorContext, input: EnhanceInput): Promise<EnhanceResult> {
    return this.complete(enhanceSchema, buildEnhancePrompt(ctx, input));
  }

  async eligibility(input: { submission: string; brief: string }): Promise<{ serves_request: boolean; reason: string }> {
    // Fresh session, no tools (this driver always runs tool-free) over only the
    // submission + brief — an independent faithfulness verdict.
    return this.complete(eligibilitySchema, buildEligibilityPrompt(input));
  }

  async conciliate(ctx: MediatorContext, input: ConciliateInput): Promise<ConciliateResult> {
    return this.complete(conciliateSchema, buildConciliatePrompt(ctx, input));
  }
}
