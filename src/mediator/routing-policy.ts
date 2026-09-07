import { createHash } from "node:crypto";
import { z } from "zod";
import type { JobPolicyEffort } from "./job-policy-log.js";

export type MediatorReasoningEffort = "none" | "low" | "high" | "xhigh";
export type GroomDifficulty = "simple" | "medium" | "hard";
export type RoutingArm = "flat" | "routed";
export type RoutedMediatorJobKind = "refresh" | "consolidate" | "answer" | "review" | "discuss" | "groom";

export interface MediatorRoute {
  model: string;
  effort: MediatorReasoningEffort;
  maxTokens: number;
  difficulty?: GroomDifficulty;
  /** Flat A/B control keeps the pre-policy OpenRouter options byte-for-byte. */
  useFlatOptions?: boolean;
  /** Exact applied values when flat rollback preserves legacy OpenRouter options. */
  telemetryEffort?: JobPolicyEffort;
  telemetryMaxTokens?: number;
}

export interface MediatorRoutingBudgets {
  flat: number;
  refresh: number;
  consolidate: number;
  answer: number;
  review: number;
  discuss: number;
  groomSimple: number;
  groomMedium: number;
  groomHard: number;
  fallback: number;
  classifier: number;
}

export interface MediatorRoutingPolicy {
  mode: "flat" | "routed" | "ab";
  abPercent: number;
  cheapQualified: boolean;
  classifierEnabled: boolean;
  glmModel: string;
  cheapModel: string;
  classifierModel: string;
  budgets: MediatorRoutingBudgets;
}

export interface GroomRoutingInput {
  title: string;
  body: string;
  evidence?: unknown[];
  queue?: unknown[];
}

export interface GroomDifficultyResult {
  difficulty: GroomDifficulty;
  reason: string;
}

const DEFAULT_CHEAP_MODEL = "google/gemini-3.1-flash-lite";
const DEFAULT_CHEAP_MAX_TOKENS = 8_192;
const DEFAULT_GLM_MAX_TOKENS = 32_768;
const DEFAULT_CLASSIFIER_MAX_TOKENS = 1_024;
const AUTO_ROUTER_MODELS = new Set(["openrouter/auto", "openrouter/auto-beta"]);

const groomDifficultySchema = z.object({
  difficulty: z.enum(["simple", "medium", "hard"]),
  reason: z.string().trim().min(1).max(500),
}).strict();

function parseInteger(name: string, raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function parseBoolean(name: string, raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  throw new Error(`${name} must be one of: 0, 1, false, true`);
}

function parseModel(name: string, raw: string | undefined, fallback: string): string {
  const model = raw?.trim() || fallback;
  if (AUTO_ROUTER_MODELS.has(model)) {
    throw new Error(`${name} cannot use the OpenRouter Auto Router; routing policy requires a pinned model`);
  }
  return model;
}

export function mediatorRoutingPolicyFromEnv(env: NodeJS.ProcessEnv, projectModel: string): MediatorRoutingPolicy {
  const mode = env.MEMRACER_MEDIATOR_POLICY_MODE ?? "flat";
  if (!(["flat", "routed", "ab"] as const).includes(mode as "flat" | "routed" | "ab")) {
    throw new Error("MEMRACER_MEDIATOR_POLICY_MODE must be flat, routed, or ab");
  }
  const glmModel = parseModel("project mediator model", projectModel, projectModel);
  const cheapModel = parseModel("MEMRACER_MEDIATOR_CHEAP_MODEL", env.MEMRACER_MEDIATOR_CHEAP_MODEL, DEFAULT_CHEAP_MODEL);
  const classifierModel = parseModel(
    "MEMRACER_MEDIATOR_CLASSIFIER_MODEL",
    env.MEMRACER_MEDIATOR_CLASSIFIER_MODEL,
    cheapModel,
  );
  const budget = (suffix: string, fallback: number) => parseInteger(
    `MEMRACER_MEDIATOR_${suffix}_MAX_TOKENS`,
    env[`MEMRACER_MEDIATOR_${suffix}_MAX_TOKENS`],
    fallback,
    1_024,
    65_536,
  );
  return {
    mode: mode as MediatorRoutingPolicy["mode"],
    abPercent: parseInteger(
      "MEMRACER_MEDIATOR_POLICY_AB_PERCENT",
      env.MEMRACER_MEDIATOR_POLICY_AB_PERCENT,
      0,
      0,
      100,
    ),
    cheapQualified: parseBoolean(
      "MEMRACER_MEDIATOR_CHEAP_QUALIFIED",
      env.MEMRACER_MEDIATOR_CHEAP_QUALIFIED,
      false,
    ),
    classifierEnabled: parseBoolean(
      "MEMRACER_MEDIATOR_GROOM_CLASSIFIER_ENABLED",
      env.MEMRACER_MEDIATOR_GROOM_CLASSIFIER_ENABLED,
      false,
    ),
    glmModel,
    cheapModel,
    classifierModel,
    budgets: {
      flat: budget("FLAT", DEFAULT_GLM_MAX_TOKENS),
      refresh: budget("REFRESH", DEFAULT_CHEAP_MAX_TOKENS),
      consolidate: budget("CONSOLIDATE", DEFAULT_CHEAP_MAX_TOKENS),
      answer: budget("ANSWER", DEFAULT_CHEAP_MAX_TOKENS),
      review: budget("REVIEW", DEFAULT_GLM_MAX_TOKENS),
      discuss: budget("DISCUSS", DEFAULT_GLM_MAX_TOKENS),
      groomSimple: budget("GROOM_SIMPLE", DEFAULT_CHEAP_MAX_TOKENS),
      groomMedium: budget("GROOM_MEDIUM", DEFAULT_GLM_MAX_TOKENS),
      groomHard: budget("GROOM_HARD", DEFAULT_GLM_MAX_TOKENS),
      fallback: budget("FALLBACK", DEFAULT_GLM_MAX_TOKENS),
      classifier: budget("CLASSIFIER", DEFAULT_CLASSIFIER_MAX_TOKENS),
    },
  };
}

function stablePercent(key: string): number {
  const digest = createHash("sha256").update(key).digest();
  return digest.readUInt32BE(0) % 100;
}

export function selectRoutingArm(policy: MediatorRoutingPolicy, key: string): RoutingArm {
  if (policy.mode === "flat") return "flat";
  if (policy.mode === "routed") return "routed";
  return stablePercent(key) < policy.abPercent ? "routed" : "flat";
}

function cheapRoute(
  policy: MediatorRoutingPolicy,
  effort: "none" | "low",
  maxTokens: number,
  difficulty?: GroomDifficulty,
): MediatorRoute {
  return {
    model: policy.cheapQualified ? policy.cheapModel : policy.glmModel,
    effort: policy.cheapQualified ? effort : "none",
    maxTokens,
    ...(difficulty ? { difficulty } : {}),
  };
}

/**
 * Static (model, effort) table for the routed arm.
 * Derived from job_policy_log telemetry; the groom difficulty classifier stays on.
 */
export function routeMediatorJob(
  policy: MediatorRoutingPolicy,
  jobKind: string,
  arm: RoutingArm,
  difficulty?: GroomDifficulty,
): MediatorRoute {
  const routedKind = (["refresh", "consolidate", "answer", "review", "discuss", "groom"] as const)
    .includes(jobKind as RoutedMediatorJobKind);
  if (!routedKind) {
    // reconcile and other non-routed kinds → GLM high (findings §5)
    return { model: policy.glmModel, effort: "high", maxTokens: policy.budgets.fallback };
  }
  if (arm === "flat") {
    return {
      model: policy.glmModel,
      effort: "none",
      maxTokens: policy.budgets.flat,
      useFlatOptions: true,
      ...(jobKind === "groom" && difficulty ? { difficulty } : {}),
    };
  }
  switch (jobKind as RoutedMediatorJobKind) {
    case "refresh":
      // flash-lite none — 96 ok @ ~4.3s vs flat GLM ~25s
      return cheapRoute(policy, "none", policy.budgets.refresh);
    case "consolidate":
      // Sparse sample (n=2, GLM only) — stay on GLM none, not cheap model
      return { model: policy.glmModel, effort: "none", maxTokens: policy.budgets.consolidate };
    case "answer":
      // flash-lite low — 5 ok @ ~2.6s vs flat GLM ~28s
      return cheapRoute(policy, "low", policy.budgets.answer);
    case "review":
      // GLM high — 62 ok; keep high for quality headroom
      return { model: policy.glmModel, effort: "high", maxTokens: policy.budgets.review };
    case "discuss":
      // GLM high — 27 ok
      return { model: policy.glmModel, effort: "high", maxTokens: policy.budgets.discuss };
    case "groom": {
      // Classifier KEEP: simple 16% → flash; medium 49% / hard 35% → GLM
      const classified = difficulty ?? "hard";
      if (classified === "simple") return cheapRoute(policy, "none", policy.budgets.groomSimple, classified);
      if (classified === "medium") {
        return { model: policy.glmModel, effort: "high", maxTokens: policy.budgets.groomMedium, difficulty: classified };
      }
      return { model: policy.glmModel, effort: "xhigh", maxTokens: policy.budgets.groomHard, difficulty: classified };
    }
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? "undefined" : encoded;
}

export function groomRoutingHash(input: GroomRoutingInput): string {
  return createHash("sha256").update(stableJson(input)).digest("hex");
}

function parseClassifierResult(value: unknown): GroomDifficultyResult {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  return groomDifficultySchema.parse(parsed);
}

export class GroomDifficultyClassifier {
  private readonly cache = new Map<string, Promise<GroomDifficultyResult>>();

  constructor(
    private readonly request: (input: GroomRoutingInput) => Promise<unknown>,
    private readonly maxEntries = 1_024,
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error("classifier maxEntries must be a positive integer");
    }
  }

  classify(input: GroomRoutingInput): Promise<GroomDifficultyResult> {
    const hash = groomRoutingHash(input);
    const cached = this.cache.get(hash);
    if (cached) {
      this.cache.delete(hash);
      this.cache.set(hash, cached);
      return cached;
    }
    const pending = Promise.resolve()
      .then(() => this.request(input))
      .then(parseClassifierResult)
      .catch((error: unknown) => ({
        difficulty: "hard" as const,
        reason: `classification failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500),
      }));
    if (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(hash, pending);
    return pending;
  }

  clear(): void {
    this.cache.clear();
  }
}

export interface OpenRouterGroomClassifierOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxTokens?: number;
  providerIgnore?: string[];
}

export function createOpenRouterGroomClassifier(options: OpenRouterGroomClassifierOptions): GroomDifficultyClassifier {
  const model = parseModel("classifier model", options.model, options.model);
  const baseUrl = options.baseUrl ?? "https://openrouter.ai/api/v1";
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxTokens = options.maxTokens ?? DEFAULT_CLASSIFIER_MAX_TOKENS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("classifier timeoutMs must be positive");
  if (!Number.isInteger(maxTokens) || maxTokens < 1_024 || maxTokens > 65_536) {
    throw new Error("classifier maxTokens must be an integer from 1024 to 65536");
  }
  return new GroomDifficultyClassifier(async (input) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("classifier timed out", "TimeoutError")), timeoutMs);
    try {
      const response = await (options.fetch ?? globalThis.fetch)(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "groom_difficulty",
              strict: true,
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  difficulty: { type: "string", enum: ["simple", "medium", "hard"] },
                  reason: { type: "string", minLength: 1, maxLength: 500 },
                },
                required: ["difficulty", "reason"],
              },
            },
          },
          tool_choice: "none",
          messages: [
            {
              role: "system",
              content: "Classify implementation difficulty. Return only the strict JSON result. Simple is bounded and mechanical; medium is cross-cutting but conventional; hard is ambiguous, high-risk, architectural, or safety-critical.",
            },
            { role: "user", content: stableJson(input) },
          ],
          max_tokens: maxTokens,
          reasoning: { enabled: false },
          provider: { sort: "latency", ignore: options.providerIgnore ?? ["inceptron"] },
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`openrouter classifier ${response.status}: ${(await response.text()).slice(0, 512)}`);
      const data = await response.json() as { choices?: Array<{ message?: { content?: string | null } }> };
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error("openrouter classifier returned no content");
      return content;
    } finally {
      clearTimeout(timer);
    }
  });
}
