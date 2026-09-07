/**
 * OpenAI-compatible provider catalog for org BYOK.
 * Defaults live in code so `use_default` orgs pick up catalog bumps without migrations.
 */

export type ProviderId =
  | "openrouter"
  | "openai"
  | "xai"
  | "groq"
  | "together"
  | "fireworks"
  | "deepseek"
  | "custom";

export type ModelMode = "use_default" | "override";

export interface ProviderProfile {
  id: ProviderId;
  label: string;
  /** Null for custom — caller supplies base URL. */
  baseUrl: string | null;
  defaultLiteModel: string;
  defaultThinkingModel: string;
}

export const PROVIDER_CATALOG: Record<ProviderId, ProviderProfile> = {
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultLiteModel: "google/gemini-3.1-flash-lite",
    defaultThinkingModel: "z-ai/glm-5.2",
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    defaultLiteModel: "gpt-4.1-mini",
    defaultThinkingModel: "gpt-5",
  },
  xai: {
    id: "xai",
    label: "xAI",
    baseUrl: "https://api.x.ai/v1",
    defaultLiteModel: "grok-3-mini",
    defaultThinkingModel: "grok-3",
  },
  groq: {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultLiteModel: "llama-3.3-70b-versatile",
    defaultThinkingModel: "llama-3.3-70b-versatile",
  },
  together: {
    id: "together",
    label: "Together AI",
    baseUrl: "https://api.together.xyz/v1",
    defaultLiteModel: "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo",
    defaultThinkingModel: "meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo",
  },
  fireworks: {
    id: "fireworks",
    label: "Fireworks",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    defaultLiteModel: "accounts/fireworks/models/llama-v3p3-70b-instruct",
    defaultThinkingModel: "accounts/fireworks/models/llama-v3p3-70b-instruct",
  },
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    defaultLiteModel: "deepseek-chat",
    defaultThinkingModel: "deepseek-reasoner",
  },
  custom: {
    id: "custom",
    label: "Custom OpenAI-compatible",
    baseUrl: null,
    defaultLiteModel: "gpt-4o-mini",
    defaultThinkingModel: "gpt-4o",
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDER_CATALOG) as ProviderId[];

export function isProviderId(value: string): value is ProviderId {
  return value in PROVIDER_CATALOG;
}

export function getProviderProfile(id: ProviderId): ProviderProfile {
  return PROVIDER_CATALOG[id];
}

/** Resolve chat-completions base URL for a provider (+ optional custom URL). */
export function resolveBaseUrl(providerId: ProviderId, customBaseUrl?: string | null): string {
  const profile = getProviderProfile(providerId);
  if (providerId === "custom") {
    const url = customBaseUrl?.trim() ?? "";
    if (!url) throw new Error("custom provider requires a base URL");
    if (!/^https:\/\//i.test(url)) throw new Error("custom base URL must use https");
    return url.replace(/\/+$/, "");
  }
  if (!profile.baseUrl) throw new Error(`provider ${providerId} has no base URL`);
  return profile.baseUrl;
}

export function resolveModelId(
  providerId: ProviderId,
  arm: "lite" | "thinking",
  mode: ModelMode,
  override: string | null | undefined,
): string {
  if (mode === "override") {
    const id = override?.trim() ?? "";
    if (!id) throw new Error(`${arm} model override is empty`);
    return id;
  }
  const profile = getProviderProfile(providerId);
  return arm === "lite" ? profile.defaultLiteModel : profile.defaultThinkingModel;
}

export function resolveModels(input: {
  providerId: ProviderId;
  liteMode: ModelMode;
  liteOverride?: string | null;
  thinkingMode: ModelMode;
  thinkingOverride?: string | null;
}): { liteModel: string; thinkingModel: string } {
  return {
    liteModel: resolveModelId(input.providerId, "lite", input.liteMode, input.liteOverride),
    thinkingModel: resolveModelId(
      input.providerId,
      "thinking",
      input.thinkingMode,
      input.thinkingOverride,
    ),
  };
}
