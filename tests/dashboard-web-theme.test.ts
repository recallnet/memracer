import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const expectedTokens = new Map<string, string>([
  ["bg", "#f7f9fb"], ["panel", "#ffffff"], ["panel-2", "#f0f3f6"], ["panel-3", "#e7ebef"],
  ["border", "#c8d0d8"], ["border-soft", "rgba(135, 148, 161, 0.35)"], ["border-hair", "rgba(135, 148, 161, 0.55)"], ["border-input", "#8794a1"],
  ["text-strong", "#111820"], ["white", "var(--text-strong)"], ["text", "#25313c"], ["muted", "#52606d"], ["text-dim", "#5d6975"],
  ["identity-mark", "#65727e"], ["accent", "#b9daf7"], ["live", "#0064c7"], ["green", "#147a36"], ["red", "#a61b1b"], ["amber", "#735c00"],
  ["state-incubating", "#854708"], ["state-incubating-bg", "#fff1e6"],
  ["state-queued", "#665100"], ["state-queued-bg", "#fff8d9"],
  ["state-claimed", "#005783"], ["state-claimed-bg", "#e6f4ff"],
  ["state-executing", "#005273"], ["state-executing-bg", "#e2f3fb"],
  ["state-blocked", "#981b1b"], ["state-blocked-bg", "#fdebec"],
  ["state-parked", "#43515e"], ["state-parked-bg", "#eef1f4"],
  ["state-done", "#0f5c28"], ["state-done-bg", "#e7f7ec"],
  ["state-review", "#07585c"], ["state-review-bg", "#e4f7f8"],
  ["state-merged", "#633a94"], ["state-merged-bg", "#f1eafb"],
  ["actor-human", "#52606d"], ["actor-mediator", "#0064c7"], ["actor-coder", "#176b32"], ["actor-system", "#65727e"],
  ["hover", "color-mix(in srgb, var(--live) 8%, transparent)"], ["hover-strong", "color-mix(in srgb, var(--live) 14%, transparent)"],
  ["edge-live", "color-mix(in srgb, var(--live) 45%, transparent)"], ["edge-green", "color-mix(in srgb, var(--green) 45%, transparent)"],
  ["edge-red", "color-mix(in srgb, var(--red) 45%, transparent)"], ["edge-amber", "color-mix(in srgb, var(--amber) 45%, transparent)"],
  ...[9, 10, 11, 12, 13, 14, 16, 18, 20, 22, 28].map((size) => [`fs-${size}`, `${size}px`] as [string, string]),
  ["w-normal", "400"], ["w-medium", "500"], ["w-semibold", "600"], ["w-bold", "700"], ["w-kpi", "650"], ["nums", "tabular-nums"],
  ...[2, 4, 6, 8, 12, 16, 20, 24, 32, 40].map((size, index) => [`sp-${index + 1}`, `${size}px`] as [string, string]),
  ["r-1", "1px"], ["r-2", "3px"], ["r-3", "6px"], ["r-4", "8px"], ["r-pill", "999px"],
  ["shadow-1", "0 1px 2px rgba(17, 24, 32, 0.12)"], ["shadow-2", "0 8px 24px rgba(17, 24, 32, 0.16)"], ["shadow-3", "-18px 0 48px rgba(17, 24, 32, 0.2)"],
  ["label-size", "10px"], ["label-tracking", "0.12em"],
  ["sans", "\"Space Grotesk\", -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"],
  ["mono", "\"JetBrains Mono\", ui-monospace, \"SF Mono\", Menlo, Consolas, monospace"],
]);

const darkTokens = new Map<string, string>([
  ["bg", "#07080b"], ["panel", "#0e1117"], ["panel-2", "#141922"], ["panel-3", "#1b212c"],
  ["text-strong", "#ffffff"], ["text", "#b2bbc6"], ["muted", "#87929e"], ["text-dim", "#78838f"],
  ["state-incubating", "#f0a868"], ["state-incubating-bg", "#30231d"],
  ["state-queued", "#e0b24a"], ["state-queued-bg", "#2c271d"],
  ["state-claimed", "#5cc0ff"], ["state-claimed-bg", "#0f2537"],
  ["state-executing", "#7cccff"], ["state-executing-bg", "#0f2b41"],
  ["state-blocked", "#f28b82"], ["state-blocked-bg", "#2d2025"],
  ["state-parked", "#9aa6b2"], ["state-parked-bg", "#1a1e24"],
  ["state-done", "#4fd873"], ["state-done-bg", "#142d20"],
  ["state-review", "#5cd6de"], ["state-review-bg", "#162c33"],
  ["state-merged", "#c09cf0"], ["state-merged-bg", "#26203b"],
]);

function rootDeclarations(path: string): Array<[string, string]> {
  const css = readFileSync(join(process.cwd(), path), "utf8");
  const root = css.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
  return [...root.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)]
    .map((match) => [match[1], match[2].trim()] as [string, string])
    .filter(([name]) => expectedTokens.has(name));
}

function explicitDarkDeclarations(path: string): Map<string, string> {
  const css = readFileSync(join(process.cwd(), path), "utf8");
  const blocks = [...css.matchAll(/:root\[data-theme="dark"\]\s*\{([\s\S]*?)\}/g)];
  const body = blocks.find((match) => match[1].includes("--bg:"))?.[1] ?? "";
  return new Map([...body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]));
}

function luminance(hex: string): number {
  const channels = hex.slice(1).match(/../g)!.map((value) => Number.parseInt(value, 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(foreground: string, background: string): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("Recall dashboard theme foundation", () => {
  it("applies the persisted preference before the dashboard module can paint", () => {
    const html = readFileSync(join(process.cwd(), "src/dashboard/web/index.html"), "utf8");
    const preference = html.indexOf("memracer.react.theme");
    const moduleEntry = html.indexOf('<script type="module"');
    expect(preference).toBeGreaterThan(0);
    expect(preference).toBeLessThan(moduleEntry);
    expect(html).toContain('theme === "light" || theme === "dark"');
    expect(html).toContain('removeAttribute("data-theme")');
  });

  it("keeps the complete shared token sequence exact and ordered", () => {
    const expected = [...expectedTokens];
    expect(rootDeclarations("src/dashboard/public/styles.css")).toEqual(expected);
    expect(rootDeclarations("src/dashboard/web/styles/theme.css")).toEqual(expected);
  });

  it("keeps every light and dark status pair at enhanced contrast on its final ground", () => {
    for (const state of ["incubating", "queued", "claimed", "executing", "blocked", "parked", "done", "review", "merged"]) {
      expect(contrast(expectedTokens.get(`state-${state}`)!, expectedTokens.get(`state-${state}-bg`)!)).toBeGreaterThanOrEqual(6.5);
      expect(contrast(darkTokens.get(`state-${state}`)!, darkTokens.get(`state-${state}-bg`)!)).toBeGreaterThanOrEqual(6.5);
    }
  });

  it("defaults to light and keeps explicit theme stamps above OS preference", () => {
    for (const path of ["src/dashboard/public/styles.css", "src/dashboard/web/styles/theme.css"]) {
      const css = readFileSync(join(process.cwd(), path), "utf8");
      expect(css).toContain(":root {\n  color-scheme: light;");
      expect(css).toMatch(/:root:not\(\[data-theme\]\)\s*\{\s*color-scheme: dark;/);
      expect(css).toMatch(/:root\[data-theme="dark"\]\s*\{\s*color-scheme: dark;/);
      expect(css).toContain(':root[data-theme="light"] { color-scheme: light; }');
      const explicitDark = explicitDarkDeclarations(path);
      for (const [name, value] of darkTokens) expect(explicitDark.get(name), `${path} --${name}`).toBe(value);
    }
  });

  it("bundles both font families and preserves semantic aliases", () => {
    const css = readFileSync(join(process.cwd(), "src/dashboard/web/styles/theme.css"), "utf8");
    for (const weight of [400, 500, 600, 700]) expect(css).toContain(`@import \"@fontsource/space-grotesk/${weight}.css\"`);
    for (const weight of [400, 500, 700]) expect(css).toContain(`@import \"@fontsource/jetbrains-mono/${weight}.css\"`);
    expect(css).toContain("--background: var(--bg)");
    expect(css).toContain("--primary: var(--accent)");
    expect(css).toContain("--ring: var(--live)");
  });

});
