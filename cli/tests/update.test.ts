import { describe, expect, it, vi } from "vitest";
import { runUpdate, type UpdateDeps } from "../src/commands/update.js";
import type { SeatRecord } from "../src/registry.js";
import type { RunResult } from "../src/harness/index.js";

const claude: SeatRecord = { project: "p", role: "human", folder: "/repo", harness: "claude", keyId: "k1abcd" };
const codex: SeatRecord = { project: "p", role: "coder", folder: "/wt", harness: "codex", keyId: "k2wxyz", envVar: "V" };

function deps(list: SeatRecord[], run: UpdateDeps["run"]): { deps: UpdateDeps; logs: string[] } {
  const logs: string[] = [];
  return { logs, deps: { list: () => list, run, log: (m) => logs.push(m) } };
}

const ok: RunResult = { code: 0, stdout: "", stderr: "" };

describe("runUpdate", () => {
  it("reports OK when claude mcp get succeeds", async () => {
    const run = vi.fn(async () => ok);
    const { deps: d, logs } = deps([claude], run);
    await runUpdate(d);
    expect(run).toHaveBeenCalledWith("claude", ["mcp", "get", "memracer"], { cwd: "/repo" });
    expect(logs[0]).toMatch(/^OK.*claude.*\/repo/);
  });

  it("reports MISSING when the harness cannot find the entry", async () => {
    const run = vi.fn(async () => ({ code: 1, stdout: "", stderr: "no such server" }));
    const { deps: d, logs } = deps([claude], run);
    await runUpdate(d);
    expect(logs[0]).toMatch(/^MISSING/);
  });

  it("checks codex by the per-seat server name in the list output", async () => {
    const name = `memracer_coder_${codex.keyId.slice(0, 4)}`;
    const present = vi.fn(async () => ({ code: 0, stdout: `some other\n${name}\n`, stderr: "" }));
    const absent = vi.fn(async () => ({ code: 0, stdout: "unrelated\n", stderr: "" }));

    const a = deps([codex], present);
    await runUpdate(a.deps);
    expect(present).toHaveBeenCalledWith("codex", ["mcp", "list"], { cwd: "/wt" });
    expect(a.logs[0]).toMatch(/^OK/);

    const b = deps([codex], absent);
    await runUpdate(b.deps);
    expect(b.logs[0]).toMatch(/^MISSING/);
  });
});
