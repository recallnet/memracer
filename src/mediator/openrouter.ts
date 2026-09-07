import { Data, Effect, Schedule } from "effect";
import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type {
  AnswerInput,
  AnswerResult,
  CompletionMeta,
  CompletionUsage,
  ConciliateInput,
  ConciliateResult,
  DiscussInput,
  DiscussResult,
  EnhanceInput,
  EnhanceResult,
  GroomResult,
  MediatorContext,
  MediatorDriver,
  MemoryToolExecutor,
  ProjectKnowledgeRefreshInput,
  ProjectKnowledgeRefreshResult,
  ReviewInput,
  ReviewResult,
  Submission,
} from "./driver.js";
import { SYSTEM, buildAnswerPrompt, buildConciliatePrompt, buildDiscussPrompt, buildEligibilityPrompt, buildEnhancePrompt, buildGroomPrompt, buildProjectKnowledgePrompt, buildRetryPrompt, buildReviewPrompt, buildTruncatedRetryPrompt } from "./prompts.js";
import { answerSchema, conciliateSchema, discussSchema, eligibilitySchema, enhanceSchema, groomSchema, projectKnowledgeRefreshSchema, reviewSchema } from "./schemas.js";
import {
  defaultMediatorEffectRunner,
  type EffectPromiseRunner,
} from "./effect-runtime.js";
import type { MediatorReasoningEffort } from "./routing-policy.js";

export type OpenRouterReasoning = false | true | { max_tokens: number } | {
  effort: Exclude<MediatorReasoningEffort, "none">;
};

export interface OpenRouterDriverOptions {
  /** Called after every winning completion. Hedged losers are never metered. */
  meter?: (u: CompletionUsage) => void;
  /**
   * If a completion request hasn't resolved within this many ms, fire one
   * duplicate request and race them (tail-latency hedge). Default 10_000.
   */
  hedgeDelayMs?: number;
  /**
   * OpenRouter provider routing sort (https://openrouter.ai/docs/features/provider-routing).
   * Default "latency"; pass false to omit only the sort constraint.
   */
  providerSort?: "latency" | "price" | "throughput" | false;
  /** Provider price ceiling in USD per million tokens/request/image. */
  providerMaxPrice?: Partial<Record<"prompt" | "completion" | "request" | "image", number>>;
  /** Provider slugs excluded from routing. Defaults to the measured-slow Inceptron endpoint. */
  providerIgnore?: string[];
  /** Reasoning control. Defaults disabled; enable it, set a token budget, or choose a supported effort. */
  reasoning?: OpenRouterReasoning;
  /** Maximum memory-tool rounds before a strict no-tools closeout. Default 12. */
  maxToolIters?: number;
  /** Auto Router cost/quality dial. 0 favors quality; 10 favors cost. Default 7. */
  costQualityTradeoff?: number;
  /** Ordered fallbacks used only for openrouter/auto and openrouter/auto-beta. */
  fallbackModels?: string[];
  /** Initial delay for retryable 429/529 and infrastructure-404 responses. Doubles per retry. */
  retryBaseDelayMs?: number;
  /** Total deadline for one completion's retries, backoff, and hedge. Default 180 seconds. */
  requestTimeoutMs?: number;
  /** Initial completion budget. A truncation retry may double it up to 65,536. Default 32,768. */
  maxTokens?: number;
  /** Prompt-cache rollout. Defaults off for direct construction. */
  promptCacheMode?: "off" | "canary" | "on";
  /** Stable 1-5% selection used only in canary mode. */
  promptCacheCanaryPercent?: number;
  /** Per-job sticky-routing key; required before caching can activate. */
  cacheSessionId?: string;
  /** Service-free runner bound to the shared mediator Effect runtime. */
  effectRunner?: EffectPromiseRunner;
  /** HTTP transport injection for deterministic driver evals. Defaults to global fetch. */
  fetch?: typeof fetch;
  /**
   * Override the review prompt builder (real-model A/B baseline omits the
   * wholeness bar). Defaults to buildReviewPrompt.
   */
  reviewPromptBuilder?: (ctx: MediatorContext, input: ReviewInput) => string;
}

const DEFAULT_MAX_TOOL_ITERS = 12;
const DEFAULT_GROOM_MAX_TOOL_ITERS = 6;
const COMPACT_AFTER_TOOL_MSGS = 4;
const DEFAULT_COST_QUALITY_TRADEOFF = 7;
export const DEFAULT_AUTO_FALLBACK_MODELS = ["anthropic/claude-sonnet-4.6", "z-ai/glm-5.2"] as const;

export function promptCacheEnabled(mode: "off" | "canary" | "on", canaryPercent: number, sessionId: string | undefined): boolean {
  if (!sessionId || mode === "off") return false;
  if (mode === "on") return true;
  let hash = 2166136261;
  for (const char of sessionId) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0) % 100 < canaryPercent;
}

type ProviderMaxPrice = NonNullable<OpenRouterDriverOptions["providerMaxPrice"]>;

function parseBoundedNumber(name: string, raw: string | undefined, min: number, max = Number.POSITIVE_INFINITY): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number from ${min} to ${max}`);
  }
  return value;
}

function parseBoundedInteger(name: string, raw: string | undefined, min: number, max: number): number | undefined {
  const value = parseBoundedNumber(name, raw, min, max);
  if (value !== undefined && !Number.isInteger(value)) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}

export function openRouterOptionsFromEnv(env: NodeJS.ProcessEnv): OpenRouterDriverOptions {
  const sort = env.OPENROUTER_PROVIDER_SORT;
  if (sort !== undefined && !["latency", "price", "throughput", "none"].includes(sort)) {
    throw new Error("OPENROUTER_PROVIDER_SORT must be latency, price, throughput, or none");
  }
  const providerMaxPrice: ProviderMaxPrice = {};
  for (const [field, variable] of [
    ["prompt", "OPENROUTER_MAX_PROMPT_PRICE"],
    ["completion", "OPENROUTER_MAX_COMPLETION_PRICE"],
    ["request", "OPENROUTER_MAX_REQUEST_PRICE"],
    ["image", "OPENROUTER_MAX_IMAGE_PRICE"],
  ] as const) {
    const value = parseBoundedNumber(variable, env[variable], 0);
    if (value !== undefined) providerMaxPrice[field] = value;
  }
  const fallbackModels = env.OPENROUTER_FALLBACK_MODELS
    ?.split(",")
    .map((model) => model.trim())
    .filter(Boolean);
  const providerSort: OpenRouterDriverOptions["providerSort"] = sort === undefined
    ? undefined
    : sort === "none"
      ? false
      : sort as Exclude<OpenRouterDriverOptions["providerSort"], false | undefined>;
  const promptCacheMode = env.OPENROUTER_PROMPT_CACHE_MODE ?? "canary";
  if (!["off", "canary", "on"].includes(promptCacheMode)) {
    throw new Error("OPENROUTER_PROMPT_CACHE_MODE must be off, canary, or on");
  }
  const promptCacheCanaryPercent = parseBoundedInteger(
    "OPENROUTER_PROMPT_CACHE_CANARY_PERCENT",
    env.OPENROUTER_PROMPT_CACHE_CANARY_PERCENT ?? "1",
    1,
    5,
  )!;
  const maxTokens = env.OPENROUTER_MAX_TOKENS === undefined
    ? undefined
    : parseBoundedInteger("OPENROUTER_MAX_TOKENS", env.OPENROUTER_MAX_TOKENS, 1_024, 65_536);
  const rawReasoning = env.OPENROUTER_REASONING ?? "off";
  const reasoning: NonNullable<OpenRouterDriverOptions["reasoning"]> = rawReasoning === "off"
    || rawReasoning === "none"
    ? false
    : rawReasoning === "on"
      ? true
      : (["low", "high", "xhigh"] as const).includes(rawReasoning as "low" | "high" | "xhigh")
        ? { effort: rawReasoning as "low" | "high" | "xhigh" }
        : { max_tokens: parseBoundedInteger("OPENROUTER_REASONING", rawReasoning, 1_024, 128_000)! };
  if (typeof reasoning === "object" && "max_tokens" in reasoning && reasoning.max_tokens >= (maxTokens ?? DEFAULT_MAX_TOKENS)) {
    throw new Error("OPENROUTER_REASONING must be strictly less than OPENROUTER_MAX_TOKENS");
  }
  const providerIgnore = [...new Set([
    "inceptron",
    ...(env.OPENROUTER_IGNORE_PROVIDERS ?? "")
      .split(",")
      .map((provider) => provider.trim())
      .filter(Boolean),
  ])];
  return {
    ...(providerSort === undefined ? {} : { providerSort }),
    ...(Object.keys(providerMaxPrice).length === 0 ? {} : { providerMaxPrice }),
    ...(fallbackModels === undefined ? {} : { fallbackModels }),
    ...(env.OPENROUTER_COST_QUALITY_TRADEOFF === undefined ? {} : {
      costQualityTradeoff: parseBoundedNumber(
        "OPENROUTER_COST_QUALITY_TRADEOFF",
        env.OPENROUTER_COST_QUALITY_TRADEOFF,
        0,
        10,
      ),
    }),
    requestTimeoutMs: parseBoundedNumber(
      "OPENROUTER_REQUEST_TIMEOUT_MS",
      env.OPENROUTER_REQUEST_TIMEOUT_MS ?? "180000",
      1,
    ),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    promptCacheMode: promptCacheMode as "off" | "canary" | "on",
    promptCacheCanaryPercent,
    providerIgnore,
    reasoning,
    maxToolIters: parseBoundedInteger(
      "OPENROUTER_MAX_TOOL_ITERS",
      env.OPENROUTER_MAX_TOOL_ITERS ?? String(DEFAULT_MAX_TOOL_ITERS),
      1,
      40,
    ),
  };
}

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  reasoning?: string;
  reasoning_details?: unknown;
}

interface CompletionData {
  // OpenRouter surfaces GLM chain-of-thought on message.reasoning (or
  // reasoning_content on some providers) — a channel separate from the JSON
  // body. Captured so a session records it as a reasoning event instead of
  // discarding it.
  choices: { finish_reason?: string | null; message: { content: string | null; reasoning?: string; reasoning_content?: string; reasoning_details?: unknown; tool_calls?: ToolCall[] } }[];
  model?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    cost?: number;
    cache_discount?: number;
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
    cost_details?: { cache_discount?: number };
  };
}

interface ResultFormat {
  name: string;
  schema: Record<string, unknown>;
}

interface CompletionOutcome {
  raw: string;
  finishReason: string | null;
  toolBudgetExhausted?: boolean;
  retryMessages?: ChatMessage[];
}

export const DEFAULT_MAX_TOKENS = 32_768;
const MAX_RETRY_TOKENS = 65_536;

function resultFormat(name: string, schema: z.ZodTypeAny): ResultFormat {
  const jsonSchema = zodToJsonSchema(schema, { $refStrategy: "none" }) as Record<string, unknown>;
  delete jsonSchema.$schema;
  return { name, schema: jsonSchema };
}

function embeddedToolCall(content: string | null | undefined, allowedNames: ReadonlySet<string>): ToolCall | null {
  const match = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i.exec(content ?? "");
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]) as {
      name?: unknown;
      arguments?: unknown;
      function?: { name?: unknown; arguments?: unknown };
    };
    const fn = parsed.function ?? parsed;
    if (typeof fn.name !== "string" || !allowedNames.has(fn.name)) return null;
    const args = fn.arguments ?? {};
    return {
      id: "embedded_tool_call",
      type: "function",
      function: {
        name: fn.name,
        arguments: typeof args === "string" ? args : JSON.stringify(args),
      },
    };
  } catch {
    return null;
  }
}

interface DriverErrorFields {
  readonly message: string;
  readonly model: string;
  readonly rawOutput?: string;
  readonly status?: number;
}

export class OpenRouterTransientError extends Data.TaggedError("OpenRouterTransientError")<DriverErrorFields> {}
export class OpenRouterPermanentError extends Data.TaggedError("OpenRouterPermanentError")<DriverErrorFields> {}
export class OpenRouterRetriesExhaustedError extends Data.TaggedError("OpenRouterRetriesExhaustedError")<DriverErrorFields> {}
export class OpenRouterTransportError extends Data.TaggedError("OpenRouterTransportError")<DriverErrorFields> {}
export class OpenRouterTimeoutError extends Data.TaggedError("OpenRouterTimeoutError")<DriverErrorFields> {}
export class OpenRouterToolError extends Data.TaggedError("OpenRouterToolError")<DriverErrorFields> {}

interface MalformedOutputFields extends DriverErrorFields {
  readonly kind: "invalid" | "truncated";
}

export class OpenRouterMalformedOutput extends Data.TaggedError("OpenRouterMalformedOutput")<MalformedOutputFields> {}
/** @deprecated Use OpenRouterMalformedOutput. Kept for source compatibility. */
export const MediatorOutputError = OpenRouterMalformedOutput;
export type MediatorOutputError = OpenRouterMalformedOutput;

type OpenRouterRequestError =
  | OpenRouterTransientError
  | OpenRouterPermanentError
  | OpenRouterRetriesExhaustedError
  | OpenRouterTransportError
  | OpenRouterTimeoutError;

type OpenRouterCompletionError = OpenRouterRequestError | OpenRouterToolError;

const REQUEST_ERROR_TAGS = new Set<OpenRouterRequestError["_tag"]>([
  "OpenRouterTransientError",
  "OpenRouterPermanentError",
  "OpenRouterRetriesExhaustedError",
  "OpenRouterTransportError",
  "OpenRouterTimeoutError",
]);

function isOpenRouterRequestError(error: unknown): error is OpenRouterRequestError {
  return Boolean(
    error &&
    typeof error === "object" &&
    "_tag" in error &&
    REQUEST_ERROR_TAGS.has((error as { _tag: OpenRouterRequestError["_tag"] })._tag),
  );
}

function transportError(error: unknown, model: string): OpenRouterRequestError {
  if (isOpenRouterRequestError(error)) return error;
  return new OpenRouterTransportError({
    message: `openrouter request failed: ${error instanceof Error ? error.message : String(error)}`,
    model,
  });
}

const INFRASTRUCTURE_404 = /(?:infrastructure|upstream|provider|route).*(?:temporar|unavailable)|temporar.*unavailable/i;

export function classifyOpenRouterFailure(status: number, detail: string, model: string): OpenRouterTransientError | OpenRouterPermanentError {
  const fields = { message: `openrouter ${status}: ${detail}`, model, status };
  if (status === 429 || status === 529 || (status === 404 && INFRASTRUCTURE_404.test(detail))) {
    return new OpenRouterTransientError(fields);
  }
  return new OpenRouterPermanentError(fields);
}

function parseJsonCandidate(raw: string): { value?: unknown; error?: string } {
  const trimmed = raw.trim();
  try {
    return { value: JSON.parse(trimmed) as unknown };
  } catch (firstError) {
    let lastError = firstError;
    for (let start = 0; start < raw.length; start++) {
      if (raw[start] !== "{" && raw[start] !== "[") continue;
      const stack: string[] = [];
      let quoted = false;
      let escaped = false;
      for (let i = start; i < raw.length; i++) {
        const char = raw[i];
        if (quoted) {
          if (escaped) escaped = false;
          else if (char === "\\") escaped = true;
          else if (char === '"') quoted = false;
          continue;
        }
        if (char === '"') {
          quoted = true;
          continue;
        }
        if (char === "{" || char === "[") stack.push(char);
        else if (char === "}" || char === "]") {
          const open = stack.pop();
          if ((open === "{" && char !== "}") || (open === "[" && char !== "]") || open === undefined) break;
          if (stack.length === 0) {
            try {
              return { value: JSON.parse(raw.slice(start, i + 1)) as unknown };
            } catch (err) {
              lastError = err;
              break;
            }
          }
        }
      }
    }
    return { error: lastError instanceof Error ? lastError.message : String(lastError) };
  }
}

function unwrapXmlOutput(raw: string): string {
  const match = /^\s*<tool_call>\s*([\s\S]*?)\s*<\/tool_call>\s*$/i.exec(raw);
  if (!match) return raw;
  const inner = match[1];
  const parsed = parseJsonCandidate(inner);
  if (!parsed.value || typeof parsed.value !== "object") return inner;
  const wrapper = parsed.value as {
    arguments?: unknown;
    function?: { arguments?: unknown };
  };
  const args = wrapper.function?.arguments ?? wrapper.arguments;
  if (typeof args === "string") return args;
  if (args && typeof args === "object") return JSON.stringify(args);
  return inner;
}

function normalizeResult(schemaName: string, value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (schemaName === "project_knowledge_refresh_result" && Array.isArray(record.checked_domains)) {
    return { ...record, checked_domains: [...new Set(record.checked_domains)] };
  }
  if (schemaName === "groom_result" && Array.isArray(record.knowledge_events)) {
    return {
      ...record,
      knowledge_events: record.knowledge_events.map((event) => {
        if (!event || typeof event !== "object") return event;
        const entry = event as Record<string, unknown>;
        return typeof entry.reason === "string" ? { ...entry, reason: entry.reason.slice(0, 300) } : event;
      }),
    };
  }
  return value;
}

export function reanchorMessages(messages: ChatMessage[], goalReminder: string): ChatMessage[] {
  // Drop any earlier reminder (marked by exact goal content) so it never stacks,
  // then append it as the most-recent user turn — recency wins the attention race.
  const kept = messages.filter((m) => !(m.role === "user" && m.content === goalReminder));
  return [...kept, { role: "user", content: goalReminder }];
}

export function compactToolResults(messages: ChatMessage[]): ChatMessage[] {
  const encoder = new TextEncoder();
  const contentHash = (content: string): string => {
    let hash = 2166136261;
    for (const char of content) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`;
  };
  const boundedMarker = (toolCallId: string, content: string): string => {
    const sourcePreview = (() => {
      try {
        return JSON.stringify(JSON.parse(content) as unknown);
      } catch {
        return content;
      }
    })();
    const excerptChars = Array.from(sourcePreview).slice(0, 320);
    const idChars = Array.from(toolCallId).slice(0, 128);
    let marker = "";
    while (true) {
      marker = JSON.stringify({
        compacted: true,
        tool_call_id: idChars.join(""),
        byte_length: encoder.encode(content).byteLength,
        content_hash: contentHash(content),
        excerpt: excerptChars.join(""),
      });
      if (encoder.encode(marker).byteLength <= 512) return marker;
      if (excerptChars.length > 0) excerptChars.pop();
      else if (idChars.length > 0) idChars.pop();
      else return marker;
    }
  };
  let newestToolIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "tool") { newestToolIndex = i; break; }
  }
  return messages.map((message, index) => {
    if (
      message.role !== "tool"
      || index === newestToolIndex
      || encoder.encode(message.content ?? "").byteLength <= 512
    ) return { ...message };
    return {
      ...message,
      content: boundedMarker(message.tool_call_id ?? "", message.content ?? ""),
    };
  });
}

function isStructurallyIncompleteJson(raw: string): boolean {
  for (let start = 0; start < raw.length; start++) {
    if (raw[start] !== "{" && raw[start] !== "[") continue;
    const stack: string[] = [];
    let quoted = false;
    let escaped = false;
    let invalid = false;
    for (let i = start; i < raw.length; i++) {
      const char = raw[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === "{" || char === "[") stack.push(char);
      else if (char === "}" || char === "]") {
        const open = stack.pop();
        if ((open === "{" && char !== "}") || (open === "[" && char !== "]") || open === undefined) {
          invalid = true;
          break;
        }
        if (stack.length === 0) break;
      }
    }
    if (!invalid && (quoted || stack.length > 0)) return true;
  }
  return false;
}

export class OpenRouterDriver implements MediatorDriver {
  private readonly costQualityTradeoff: number;
  private readonly fallbackModels: string[];
  private readonly promptCacheActive: boolean;
  private readonly runEffect: EffectPromiseRunner;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl = "https://openrouter.ai/api/v1",
    private readonly options: OpenRouterDriverOptions = {},
  ) {
    this.runEffect = options.effectRunner ?? defaultMediatorEffectRunner;
    this.costQualityTradeoff = options.costQualityTradeoff ?? DEFAULT_COST_QUALITY_TRADEOFF;
    if (!Number.isFinite(this.costQualityTradeoff) || this.costQualityTradeoff < 0 || this.costQualityTradeoff > 10) {
      throw new Error("costQualityTradeoff must be a number from 0 to 10");
    }
    this.fallbackModels = options.fallbackModels ?? [...DEFAULT_AUTO_FALLBACK_MODELS];
    const cacheMode = options.promptCacheMode ?? "off";
    const canaryPercent = options.promptCacheCanaryPercent ?? 1;
    if (!Number.isInteger(canaryPercent) || canaryPercent < 1 || canaryPercent > 5) {
      throw new Error("promptCacheCanaryPercent must be an integer from 1 to 5");
    }
    if (options.cacheSessionId !== undefined && options.cacheSessionId.length > 256) {
      throw new Error("cacheSessionId must be at most 256 characters");
    }
    const pinnedGlm = model === "z-ai/glm-5.2";
    this.promptCacheActive = pinnedGlm && promptCacheEnabled(cacheMode, canaryPercent, options.cacheSessionId);
    if (this.fallbackModels.length === 0 || this.fallbackModels.some((fallback) => fallback.trim() === "")) {
      throw new Error("fallbackModels must contain at least one non-empty model id");
    }
    for (const [field, value] of Object.entries(options.providerMaxPrice ?? {})) {
      if (!Number.isFinite(value) || value < 0) throw new Error(`providerMaxPrice.${field} must be non-negative`);
    }
    if (options.maxTokens !== undefined && (!Number.isInteger(options.maxTokens) || options.maxTokens < 1_024 || options.maxTokens > MAX_RETRY_TOKENS)) {
      throw new Error(`maxTokens must be an integer from 1024 to ${MAX_RETRY_TOKENS}`);
    }
    if (options.maxToolIters !== undefined && (!Number.isInteger(options.maxToolIters) || options.maxToolIters < 1 || options.maxToolIters > 40)) {
      throw new Error("maxToolIters must be an integer from 1 to 40");
    }
    if (typeof options.reasoning === "object") {
      if ("max_tokens" in options.reasoning && (
        !Number.isInteger(options.reasoning.max_tokens)
        || options.reasoning.max_tokens < 1_024
        || options.reasoning.max_tokens > 128_000
        || options.reasoning.max_tokens >= (options.maxTokens ?? DEFAULT_MAX_TOKENS)
      )) {
        throw new Error("reasoning.max_tokens must be an integer from 1024 to 128000 and strictly less than maxTokens");
      }
      if ("effort" in options.reasoning && !(["low", "high", "xhigh"] as const).includes(options.reasoning.effort)) {
        throw new Error("reasoning.effort must be low, high, or xhigh");
      }
    }
  }

  /** Metadata for the last winning completion; consumed (and cleared) by takeMeta. */
  private lastMeta: CompletionMeta | undefined;
  /** Usage across tool turns and schema retries; consumed independently from transcript metadata. */
  private accumulatedUsage: CompletionUsage | undefined;

  takeMeta(): CompletionMeta | undefined {
    const meta = this.lastMeta;
    this.lastMeta = undefined;
    return meta;
  }

  takeUsage(): CompletionUsage | undefined {
    const usage = this.accumulatedUsage;
    this.accumulatedUsage = undefined;
    return usage;
  }

  private buildBody(messages: ChatMessage[], format: ResultFormat, maxTokens: number, tools?: MemoryToolExecutor): string {
    const providerSort = this.options.providerSort ?? "latency";
    const autoRouter = this.model === "openrouter/auto" || this.model === "openrouter/auto-beta";
    const provider = {
      // require_parameters filters routing to providers that support EVERY
      // parameter we send. It is only meaningful for the Auto Router (to avoid
      // routing to a param-incapable model). On a PINNED model it instead
      // eliminates all endpoints — our tools + parallel_tool_calls + reasoning
      // params satisfy no single provider — yielding OpenRouter 404 "No
      // endpoints found that can handle the requested parameters" and taking
      // every groom/review/discuss down. So send it only for the Auto Router.
      ...(autoRouter ? { require_parameters: true } : {}),
      ...(providerSort === false ? {} : { sort: providerSort }),
      ...(this.options.providerMaxPrice ? { max_price: this.options.providerMaxPrice } : {}),
      ignore: this.options.providerIgnore ?? ["inceptron"],
    };
    const capability = tools
      ? { tools: tools.toolDefinitions(), tool_choice: "auto", parallel_tool_calls: false }
      : { response_format: { type: "json_schema", json_schema: { ...format, strict: true } }, tool_choice: "none" };
    const reasoning = this.options.reasoning ?? false;
    return JSON.stringify({
      model: this.model,
      ...(this.promptCacheActive ? {
        session_id: this.options.cacheSessionId,
        cache_control: { type: "ephemeral" },
      } : {}),
      ...(autoRouter ? {
        models: this.fallbackModels,
        plugins: [{ id: "auto-router", cost_quality_tradeoff: this.costQualityTradeoff }],
      } : {}),
      ...capability,
      messages: compactToolResults(messages),
      max_tokens: maxTokens,
      reasoning: typeof reasoning === "boolean" ? { enabled: reasoning } : reasoning,
      provider,
    });
  }

  private async requestOnce(body: string, signal: AbortSignal): Promise<CompletionData> {
    try {
      const res = await (this.options.fetch ?? globalThis.fetch)(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body,
        signal,
      });
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 512);
        throw classifyOpenRouterFailure(res.status, detail, this.model);
      }
      return (await res.json()) as CompletionData;
    } catch (error) {
      throw transportError(error, this.model);
    }
  }

  private requestWithBackoff(body: string): Effect.Effect<CompletionData, OpenRouterRequestError> {
    const baseDelay = this.options.retryBaseDelayMs ?? 500;
    const requestTimeoutMs = this.options.requestTimeoutMs ?? 180_000;
    const retryPolicy = Schedule.exponential(baseDelay).pipe(
      Schedule.intersect(Schedule.recurs(2)),
      Schedule.whileInput((error: OpenRouterRequestError) => error._tag === "OpenRouterTransientError"),
    );
    const requestAttempt = Effect.tryPromise({
      try: (signal) => this.hedgedRequest(body, signal),
      catch: (error) => transportError(error, this.model),
    });
    return requestAttempt.pipe(
      Effect.retry(retryPolicy),
      Effect.catchTag("OpenRouterTransientError", (error) => Effect.fail(new OpenRouterRetriesExhaustedError({
        message: error.message,
        model: error.model,
        rawOutput: error.rawOutput,
        status: error.status,
      }))),
      Effect.timeoutFail({
        duration: requestTimeoutMs,
        onTimeout: () => new OpenRouterTimeoutError({
          message: `openrouter request timed out after ${requestTimeoutMs}ms`,
          model: this.model,
        }),
      }),
    );
  }

  /**
   * One attempt with tail-latency hedging: start the primary request; if it
   * hasn't settled after hedgeDelayMs, fire one identical duplicate and race.
   * First response wins; the loser is aborted. Errors reject only once no
   * request can still win.
   */
  private hedgedRequest(body: string, effectSignal: AbortSignal): Promise<CompletionData> {
    const hedgeDelayMs = this.options.hedgeDelayMs ?? 10_000;
    return new Promise<CompletionData>((resolve, reject) => {
      const primaryCtl = new AbortController();
      let hedgeCtl: AbortController | null = null;
      let settled = false;
      let primaryFailed = false;
      let hedgeFailed = false;
      let hedgeTimer: ReturnType<typeof setTimeout> | undefined;

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (hedgeTimer !== undefined) clearTimeout(hedgeTimer);
        effectSignal.removeEventListener("abort", abortRequests);
        fn();
      };

      const abortRequests = () => {
        settle(() => {
          primaryCtl.abort(effectSignal.reason);
          hedgeCtl?.abort(effectSignal.reason);
          reject(effectSignal.reason ?? new DOMException("aborted", "AbortError"));
        });
      };
      if (effectSignal.aborted) {
        abortRequests();
        return;
      }
      effectSignal.addEventListener("abort", abortRequests, { once: true });

      const primary = this.requestOnce(body, primaryCtl.signal);
      hedgeTimer = setTimeout(() => {
        if (settled || effectSignal.aborted) {
          if (effectSignal.aborted) abortRequests();
          return;
        }
        hedgeCtl = new AbortController();
        this.requestOnce(body, hedgeCtl.signal).then(
          (data) => settle(() => {
            primaryCtl.abort();
            resolve(data);
          }),
          (err: unknown) => {
            hedgeFailed = true;
            if (primaryFailed) settle(() => reject(err));
          },
        );
      }, hedgeDelayMs);
      primary.then(
        (data) => settle(() => {
          hedgeCtl?.abort();
          resolve(data);
        }),
        (err: unknown) => {
          primaryFailed = true;
          if (hedgeCtl === null || hedgeFailed) settle(() => reject(err));
        },
      );
    });
  }

  /**
   * Meter token usage on a winning completion and capture its sidecar
   * (reasoning + usage) into lastMeta for the thread transcript. Called on
   * every winning completion, including each turn of the tool loop, so the
   * final answer's metadata is what takeMeta surfaces.
   */
  private meter(data: CompletionData): void {
    const resolvedModel = data.model ?? this.model;
    const cacheDiscount = data.usage?.cache_discount ?? data.usage?.cost_details?.cache_discount;
    const usage = data.usage
      ? {
          promptTokens: data.usage.prompt_tokens,
          completionTokens: data.usage.completion_tokens,
          cachedTokens: data.usage.prompt_tokens_details?.cached_tokens ?? 0,
          cacheWriteTokens: data.usage.prompt_tokens_details?.cache_write_tokens ?? 0,
          ...(typeof cacheDiscount === "number" ? { cacheDiscountUsd: cacheDiscount } : {}),
          ...(typeof data.usage.cost === "number" ? { costUsd: data.usage.cost } : {}),
          completionCount: 1,
          requestedModel: this.model,
          resolvedModel,
        }
      : undefined;
    if (usage && this.options.meter) this.options.meter(usage);
    if (usage) {
      this.accumulatedUsage = {
        promptTokens: (this.accumulatedUsage?.promptTokens ?? 0) + usage.promptTokens,
        completionTokens: (this.accumulatedUsage?.completionTokens ?? 0) + usage.completionTokens,
        cachedTokens: (this.accumulatedUsage?.cachedTokens ?? 0) + (usage.cachedTokens ?? 0),
        cacheWriteTokens: (this.accumulatedUsage?.cacheWriteTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
        completionCount: (this.accumulatedUsage?.completionCount ?? 0) + 1,
        cacheReadByCompletion: [...(this.accumulatedUsage?.cacheReadByCompletion ?? []), usage.cachedTokens ?? 0],
        requestedModel: this.model,
        resolvedModel,
        ...(
          this.accumulatedUsage?.cacheDiscountUsd !== undefined || usage.cacheDiscountUsd !== undefined
            ? { cacheDiscountUsd: (this.accumulatedUsage?.cacheDiscountUsd ?? 0) + (usage.cacheDiscountUsd ?? 0) }
            : {}
        ),
        ...(
          this.accumulatedUsage?.costUsd !== undefined || usage.costUsd !== undefined
            ? { costUsd: (this.accumulatedUsage?.costUsd ?? 0) + (usage.costUsd ?? 0) }
            : {}
        ),
      };
    }
    const msg = data.choices[0]?.message;
    const reasoning = msg?.reasoning ?? msg?.reasoning_content;
    this.lastMeta = { model: resolvedModel, ...(reasoning ? { reasoning } : {}), ...(usage ? { usage } : {}) };
  }

  /**
   * One agentic turn: request completions, and while the model emits tool
   * calls, dispatch each through the project-scoped executor, append the
   * results, and re-request. Returns the model's final assistant text (the
   * JSON answer). Bounded by maxToolIters so a looping model still settles.
   */
  private runToolLoop(messages: ChatMessage[], tools: MemoryToolExecutor, format: ResultFormat, maxTokens: number, goalReminder?: string, maxToolIters?: number): Effect.Effect<CompletionOutcome, OpenRouterCompletionError> {
    const allowedNames = new Set(tools.toolDefinitions().map((tool) => tool.function.name));
    const iterCap = maxToolIters ?? this.options.maxToolIters ?? DEFAULT_MAX_TOOL_ITERS;
    return Effect.gen(this, function* () {
      for (let i = 0; i < iterCap; i++) {
        // Distill accumulated tool bodies instead of resending them raw, so the
        // submission never loses the attention race as the transcript grows.
        if (messages.filter((m) => m.role === "tool").length > COMPACT_AFTER_TOOL_MSGS) {
          messages = compactToolResults(messages);
        }
        const turn = goalReminder ? reanchorMessages(messages, goalReminder) : messages;
        const data = yield* this.requestWithBackoff(this.buildBody(turn, format, maxTokens, tools));
        this.meter(data);
        const message = data.choices[0]?.message;
        const nativeCalls = message?.tool_calls ?? [];
        const fallbackCall = nativeCalls.length === 0 ? embeddedToolCall(message?.content, allowedNames) : null;
        const calls = nativeCalls.length > 0 ? nativeCalls : fallbackCall ? [fallbackCall] : [];
        if (calls.length === 0) {
          const retryMessages = messages.some((entry) => entry.role === "tool")
            ? messages.map((entry) => ({ ...entry }))
            : undefined;
          return {
            raw: message?.content ?? "",
            finishReason: data.choices[0]?.finish_reason ?? null,
            ...(retryMessages ? { retryMessages } : {}),
          };
        }
        messages.push({
          role: "assistant",
          content: nativeCalls.length > 0 ? message?.content ?? null : null,
          tool_calls: calls,
          ...(message?.reasoning !== undefined || message?.reasoning_content !== undefined
            ? { reasoning: message.reasoning ?? message.reasoning_content }
            : {}),
          ...(message?.reasoning_details !== undefined ? { reasoning_details: message.reasoning_details } : {}),
        });
        for (const call of calls) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
          } catch {
            args = {};
          }
          const result = yield* Effect.tryPromise({
            try: () => tools.dispatch(call.function.name, args),
            catch: (error) => new OpenRouterToolError({
              message: `memory tool ${call.function.name} failed: ${error instanceof Error ? error.message : String(error)}`,
              model: this.model,
            }),
          });
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
        }
      }
      // Loop budget spent without a final answer — force a no-tools close-out.
      const closeout = goalReminder ? reanchorMessages(messages, goalReminder) : messages;
      const data = yield* this.requestWithBackoff(this.buildBody(closeout, format, maxTokens));
      this.meter(data);
      return {
        raw: data.choices[0]?.message?.content ?? "",
        finishReason: data.choices[0]?.finish_reason ?? null,
        toolBudgetExhausted: true,
        retryMessages: messages.map((message) => ({ ...message })),
      };
    });
  }

  private completionOutcome(
    prompt: string,
    format: ResultFormat,
    maxTokens: number,
    tools?: MemoryToolExecutor,
    retryMessages?: ChatMessage[],
    goalReminder?: string,
    maxToolIters?: number,
  ): Effect.Effect<CompletionOutcome, OpenRouterCompletionError> {
    const messages: ChatMessage[] = retryMessages
      ? [...retryMessages.map((message) => ({ ...message })), { role: "user", content: prompt }]
      : [
          { role: "system", content: SYSTEM },
          { role: "user", content: prompt },
        ];
    if (tools) return this.runToolLoop(messages, tools, format, maxTokens, goalReminder, maxToolIters);
    return this.requestWithBackoff(this.buildBody(messages, format, maxTokens)).pipe(
      Effect.map((data) => {
        this.meter(data);
        return {
          raw: data.choices[0]?.message?.content ?? "",
          finishReason: data.choices[0]?.finish_reason ?? null,
        };
      }),
    );
  }

  /**
   * Effective tool-loop iteration bound for this job kind. Groom needs far less
   * roaming than the default 12 — extra roaming fuels goal drift — so it caps at
   * OPENROUTER_GROOM_MAX_TOOL_ITERS (default 6). Other kinds keep the default.
   */
  private effectiveMaxToolIters(schemaName: string): number {
    const base = this.options.maxToolIters ?? DEFAULT_MAX_TOOL_ITERS;
    if (schemaName !== "groom_result") return base;
    return parseBoundedInteger(
      "OPENROUTER_GROOM_MAX_TOOL_ITERS",
      process.env.OPENROUTER_GROOM_MAX_TOOL_ITERS ?? String(DEFAULT_GROOM_MAX_TOOL_ITERS),
      1,
      40,
    ) ?? DEFAULT_GROOM_MAX_TOOL_ITERS;
  }

  private complete<T>(schema: z.ZodType<T>, schemaName: string, prompt: string, tools?: MemoryToolExecutor, goalReminder?: string): Promise<T> {
    const format = resultFormat(schemaName, schema);
    const maxToolIters = this.effectiveMaxToolIters(schemaName);
    let userContent = prompt;
    let maxTokens = this.options.maxTokens ?? DEFAULT_MAX_TOKENS;
    let attempt = 0;
    let retryWithoutTools = false;
    let currentHasToolTranscript = false;
    let retryMessages: ChatMessage[] | undefined;
    const outputRetry = Schedule.recurs(1).pipe(
      Schedule.whileInput((error: OpenRouterCompletionError | OpenRouterMalformedOutput) =>
        error instanceof OpenRouterMalformedOutput),
    );
    const structuredAttempt = Effect.suspend(() => {
      attempt += 1;
      return this.completionOutcome(
        userContent,
        format,
        maxTokens,
        retryWithoutTools ? undefined : tools,
        retryWithoutTools ? retryMessages : undefined,
        goalReminder,
        maxToolIters,
      ).pipe(
        Effect.flatMap((outcome) => {
          currentHasToolTranscript = outcome.retryMessages !== undefined;
          if (outcome.retryMessages) retryMessages = outcome.retryMessages;
          const recoveredRaw = unwrapXmlOutput(outcome.raw);
          const candidate = parseJsonCandidate(recoveredRaw);
          const checked = schema.safeParse(normalizeResult(schemaName, candidate.value));
          if (checked.success) {
            const reasoning = this.lastMeta?.reasoning;
            return Effect.succeed(reasoning && checked.data && typeof checked.data === "object"
              ? { ...checked.data, reasoning }
              : checked.data);
          }
          const truncated = outcome.finishReason === "length"
            || (candidate.error !== undefined && isStructurallyIncompleteJson(recoveredRaw));
          const detail = truncated
            ? `truncated completion (${outcome.finishReason ?? "unterminated JSON"})`
            : candidate.error
              ? `JSON parse error: ${candidate.error}`
              : `schema validation error: ${checked.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("; ")}`;
          return Effect.fail(new OpenRouterMalformedOutput({
            kind: truncated ? "truncated" : "invalid",
            message: `${truncated ? "truncated" : "invalid"} mediator output${attempt > 1 ? " after retry" : ""}; ${detail}`,
            model: this.model,
            rawOutput: outcome.raw,
          }));
        }),
        Effect.tapError((error) => error instanceof OpenRouterMalformedOutput
          ? Effect.sync(() => {
              if (currentHasToolTranscript) retryWithoutTools = true;
              if (error.kind === "truncated") {
                maxTokens = Math.min(maxTokens * 2, MAX_RETRY_TOKENS);
                userContent = buildTruncatedRetryPrompt(prompt);
              } else {
                userContent = buildRetryPrompt(prompt, error.rawOutput ?? "");
              }
            })
          : Effect.void),
      );
    }).pipe(Effect.retry(outputRetry));
    return this.runEffect(structuredAttempt);
  }

  async groom(ctx: MediatorContext, s: Submission): Promise<GroomResult> {
    const goalReminder = `AUTHORITATIVE SUBMISSION TO GROOM (this is the task — your brief MUST be about THIS):\n${s.title}\n${s.body}`;
    return this.complete(groomSchema, "groom_result", buildGroomPrompt(ctx, s), ctx.tools, goalReminder);
  }

  async review(ctx: MediatorContext, input: ReviewInput): Promise<ReviewResult> {
    const build = this.options.reviewPromptBuilder ?? buildReviewPrompt;
    return this.complete(reviewSchema, "review_result", build(ctx, input), ctx.tools);
  }

  async answer(ctx: MediatorContext, input: AnswerInput): Promise<AnswerResult> {
    return this.complete(answerSchema, "answer_result", buildAnswerPrompt(ctx, input), ctx.tools);
  }

  async enhance(ctx: MediatorContext, input: EnhanceInput): Promise<EnhanceResult> {
    return this.complete(enhanceSchema, "enhance_result", buildEnhancePrompt(ctx, input));
  }

  async eligibility(input: { submission: string; brief: string }): Promise<{ serves_request: boolean; reason: string }> {
    // Fresh, minimal context: ONLY submission + brief, no tool loop — an
    // independent verdict that can't inherit the groom loop's drift. Routing to
    // the cheap tier is the caller/policy-driver's job.
    return this.complete(eligibilitySchema, "eligibility", buildEligibilityPrompt(input));
  }

  async discuss(ctx: MediatorContext, input: DiscussInput): Promise<DiscussResult> {
    return this.complete(discussSchema, "discuss_result", buildDiscussPrompt(ctx, input), ctx.tools);
  }

  async conciliate(ctx: MediatorContext, input: ConciliateInput): Promise<ConciliateResult> {
    return this.complete(conciliateSchema, "conciliate_result", buildConciliatePrompt(ctx, input), ctx.tools);
  }

  async refreshProjectKnowledge(ctx: MediatorContext, input: ProjectKnowledgeRefreshInput): Promise<ProjectKnowledgeRefreshResult> {
    return this.complete(
      projectKnowledgeRefreshSchema,
      "project_knowledge_refresh_result",
      buildProjectKnowledgePrompt(ctx, input),
      ctx.tools,
    );
  }
}
