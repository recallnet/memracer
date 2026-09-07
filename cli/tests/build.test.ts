import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist/index.js");

describe("build", () => {
  beforeAll(() => {
    execFileSync("node", ["build.mjs"], { cwd: root });
  }, 30000);

  it("emits dist/index.js", () => {
    expect(existsSync(dist)).toBe(true);
  });

  it("runs --help listing the enroll command", () => {
    const out = execFileSync("node", [dist, "--help"], { cwd: root }).toString();
    expect(out).toContain("enroll");
  });

  // Regression: a global install (npm bin / ~/.local/bin) invokes the bundle
  // through a symlink. The main guard must resolve realpath, or the CLI does
  // nothing when installed (exit 0, no output).
  it("runs when invoked through a symlinked bin", () => {
    const binDir = mkdtempSync(join(tmpdir(), "mzr-bin-"));
    const link = join(binDir, "memracer");
    symlinkSync(dist, link);
    const out = execFileSync("node", [link, "--help"], { cwd: binDir }).toString();
    expect(out).toContain("enroll");
    expect(out).toContain("seat");
  });
});
