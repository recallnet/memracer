import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertDashboardArtifacts, missingDashboardArtifacts } from "../src/dashboard-artifacts.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function webDistFixture(): string {
  const release = mkdtempSync(path.join(tmpdir(), "memracer-artifact-gate-"));
  dirs.push(release);
  const output = path.join(release, "src/dashboard/web-dist");
  mkdirSync(path.join(output, "assets"), { recursive: true });
  writeFileSync(path.join(output, "index.html"), '<script type="module" src="/dashboard/app.js"></script>');
  writeFileSync(path.join(output, "app.js"), "console.log('ok');");
  writeFileSync(path.join(output, "marketing.html"), '<script type="module" src="/dashboard/marketing.js"></script>');
  writeFileSync(path.join(output, "marketing.js"), "console.log('marketing');");
  writeFileSync(path.join(output, "dashboard.css"), "body { color: white; }");
  writeFileSync(path.join(output, "assets", "font.woff2"), "font");
  return output;
}

describe("dashboard artifact contract", () => {
  it("is asserted at server startup", () => {
    expect(readFileSync(path.join(ROOT, "src/main.ts"), "utf8")).toContain("assertDashboardArtifacts");
  });

  it("accepts a complete dashboard output", () => {
    const root = webDistFixture();
    expect(missingDashboardArtifacts(root)).toEqual([]);
    expect(() => assertDashboardArtifacts(root)).not.toThrow();
  });

  it("reports missing files and logs a critical startup error", () => {
    const root = webDistFixture();
    rmSync(path.join(root, "index.html"));
    expect(missingDashboardArtifacts(root)).toEqual(["index.html"]);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => assertDashboardArtifacts(root)).toThrow(/index\.html/);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("[critical]"));
    error.mockRestore();
  });

  it.each([
    ["index.html", "index.html"],
    ["app.js", "app.js"],
    ["marketing.html", "marketing.html"],
    ["marketing.js", "marketing.js"],
    ["dashboard.css", "dashboard.css"],
    ["assets", "assets/font.woff2"],
  ])("rejects a missing %s", (label, relative) => {
    const root = webDistFixture();
    rmSync(path.join(root, relative), { recursive: true, force: true });
    expect(missingDashboardArtifacts(root)).toContain(label);
    expect(() => assertDashboardArtifacts(root)).toThrow(label);
  });

  it("rejects empty required files", () => {
    const root = webDistFixture();
    writeFileSync(path.join(root, "app.js"), "");
    expect(missingDashboardArtifacts(root)).toContain("app.js");
  });

  it("rejects an empty asset file", () => {
    const root = webDistFixture();
    writeFileSync(path.join(root, "assets/font.woff2"), "");
    expect(missingDashboardArtifacts(root)).toContain("assets");
  });
});
