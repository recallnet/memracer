import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendGitignore } from "../src/harness/gitignore.js";

describe("appendGitignore", () => {
  it("creates .gitignore and appends the line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memracer-gi-"));
    await appendGitignore(dir, ".grok/");
    const out = await readFile(join(dir, ".gitignore"), "utf8");
    expect(out).toContain(".grok/");
  });

  it("is idempotent when the line already exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memracer-gi-"));
    await writeFile(join(dir, ".gitignore"), "node_modules\n.grok/\n");
    await appendGitignore(dir, ".grok/");
    const out = await readFile(join(dir, ".gitignore"), "utf8");
    expect(out.match(/\.grok\//g)?.length).toBe(1);
  });
});
