import { describe, expect, it } from "vitest";
import {
  buildSpendSeries,
  compareScorecardModels,
  modelFamily,
  resolvedModelLabel,
} from "../src/dashboard/analytics.js";

describe("scorecard model slots and stable order", () => {
  it("classifies brand models, other models, and unattributed distinctly", () => {
    expect(modelFamily("gemini-2.5-pro")).toBe("gemini");
    expect(modelFamily("gemini-3.1-flash-lite")).toBe("gemini");
    expect(modelFamily("glm-5.2")).toBe("glm");
    expect(modelFamily("claude-sonnet-4")).toBe("other");
    expect(modelFamily("deepseek-r1")).toBe("other");
    expect(modelFamily("unknown")).toBe("unknown");
    expect(modelFamily("")).toBe("unknown");
    expect(modelFamily("  ")).toBe("unknown");
    expect(resolvedModelLabel(null)).toBe("unknown");
    expect(resolvedModelLabel("")).toBe("unknown");
  });

  it("orders segments by family rank then name, never by completions", () => {
    const models = ["unknown", "claude-sonnet-4", "glm-5.2", "gemini-3.1-flash-lite", "gemini-2.5-pro"];
    const sorted = [...models].sort(compareScorecardModels);
    expect(sorted).toEqual([
      "gemini-2.5-pro",
      "gemini-3.1-flash-lite",
      "glm-5.2",
      "claude-sonnet-4",
      "unknown",
    ]);

    // Same order when completions would reverse the ranking for two kinds.
    const kindA = [
      { model: "claude-sonnet-4", completions: 90 },
      { model: "gemini-2.5-pro", completions: 1 },
      { model: "unknown", completions: 50 },
      { model: "glm-5.2", completions: 20 },
    ];
    const kindB = [
      { model: "unknown", completions: 1 },
      { model: "glm-5.2", completions: 80 },
      { model: "claude-sonnet-4", completions: 2 },
      { model: "gemini-2.5-pro", completions: 40 },
    ];
    const orderA = [...kindA].sort((l, r) => compareScorecardModels(l.model, r.model)).map((s) => s.model);
    const orderB = [...kindB].sort((l, r) => compareScorecardModels(l.model, r.model)).map((s) => s.model);
    expect(orderA).toEqual(orderB);
    expect(orderA).toEqual(["gemini-2.5-pro", "glm-5.2", "claude-sonnet-4", "unknown"]);
  });

  it("buildSpendSeries buckets hourly for 24h and daily for 7d, keeps unattributed color slot", () => {
    const day = Date.UTC(2026, 6, 20);
    const hourA = day + 3 * 3_600_000;
    const hourB = day + 5 * 3_600_000;
    const nextDay = day + 24 * 3_600_000;
    const usage = [
      { resolved_model: "gemini-2.5-pro", cost_usd: 1.5, created_at: hourA },
      { resolved_model: null, cost_usd: 0.25, created_at: hourA },
      { resolved_model: "glm-5.2", cost_usd: 2, created_at: hourB },
      { resolved_model: "gemini-2.5-pro", cost_usd: 0.5, created_at: nextDay },
      { resolved_model: "", cost_usd: 0, created_at: hourB },
    ];
    const hourly = buildSpendSeries(usage, "24h", nextDay + 1);
    expect(hourly).toHaveLength(3);
    expect(hourly[0].segments.map((s) => s.model)).toEqual(["gemini-2.5-pro", "unknown"]);
    expect(hourly[0].segments.find((s) => s.model === "unknown")?.cost_usd).toBe(0.25);
    expect(modelFamily("unknown")).toBe("unknown");

    const daily = buildSpendSeries(usage, "7d", nextDay + 1);
    expect(daily).toHaveLength(2);
    expect(daily[0].total_usd).toBe(3.75);
    expect(daily[1].segments.map((s) => s.model)).toEqual(["gemini-2.5-pro"]);
  });
});
