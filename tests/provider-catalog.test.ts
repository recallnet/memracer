import { describe, expect, it } from "vitest";
import {
  PROVIDER_CATALOG,
  resolveBaseUrl,
  resolveModelId,
  resolveModels,
} from "../src/provider-catalog.js";

describe("provider catalog", () => {
  it("ships OpenRouter defaults matching production pins", () => {
    expect(PROVIDER_CATALOG.openrouter.defaultLiteModel).toBe("google/gemini-3.1-flash-lite");
    expect(PROVIDER_CATALOG.openrouter.defaultThinkingModel).toBe("z-ai/glm-5.2");
    expect(PROVIDER_CATALOG.openrouter.baseUrl).toBe("https://openrouter.ai/api/v1");
  });

  it("resolves catalog defaults for use_default and sticky overrides", () => {
    expect(resolveModelId("openrouter", "lite", "use_default", null)).toBe(
      "google/gemini-3.1-flash-lite",
    );
    expect(resolveModelId("openrouter", "thinking", "override", "acme/my-model")).toBe(
      "acme/my-model",
    );
    expect(() => resolveModelId("openrouter", "lite", "override", "  ")).toThrow(/empty/i);
  });

  it("requires https custom base URL", () => {
    expect(resolveBaseUrl("openai")).toBe("https://api.openai.com/v1");
    expect(resolveBaseUrl("custom", "https://gateway.example.com/v1/")).toBe(
      "https://gateway.example.com/v1",
    );
    expect(() => resolveBaseUrl("custom", "http://insecure.example")).toThrow(/https/i);
    expect(() => resolveBaseUrl("custom", null)).toThrow(/base URL/i);
  });

  it("resolveModels pairs lite + thinking", () => {
    const m = resolveModels({
      providerId: "openrouter",
      liteMode: "use_default",
      thinkingMode: "override",
      thinkingOverride: "z-ai/glm-5.2-custom",
    });
    expect(m.liteModel).toBe("google/gemini-3.1-flash-lite");
    expect(m.thinkingModel).toBe("z-ai/glm-5.2-custom");
  });
});
