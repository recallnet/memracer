import { describe, expect, it, vi } from "vitest";
import { pickHarness, runEnroll, type EnrollDeps } from "../src/commands/enroll.js";
import type { RedeemedSeat } from "../src/api.js";
import type { HarnessWriter } from "../src/harness/index.js";

const claude: HarnessWriter = { id: "claude", bin: "claude", write: async () => undefined, locate: () => "" };
const grok: HarnessWriter = { id: "grok", bin: "grok", write: async () => undefined, locate: () => "" };

const seat: RedeemedSeat = {
  key: "mzr_live_x",
  keyId: "k1",
  project: "proj-1",
  projectId: "proj-1",
  projectName: "Memracer",
  role: "coder",
  mcpUrl: "https://memracer.com/mcp",
};

describe("pickHarness", () => {
  it("throws when none detected", () => {
    expect(() => pickHarness([])).toThrow(/No supported harness/);
  });
  it("returns the sole detected harness", () => {
    expect(pickHarness([claude])).toBe(claude);
  });
  it("throws when multiple detected and no --harness", () => {
    expect(() => pickHarness([claude, grok])).toThrow(/Multiple harnesses/);
  });
  it("selects the requested harness", () => {
    expect(pickHarness([claude, grok], "grok")).toBe(grok);
  });
  it("throws when the requested harness is not detected", () => {
    expect(() => pickHarness([claude], "codex")).toThrow(/not detected/);
  });
});

describe("runEnroll", () => {
  function deps(over: Partial<EnrollDeps> = {}): { deps: EnrollDeps; logs: string[]; provision: ReturnType<typeof vi.fn> } {
    const logs: string[] = [];
    const provision = vi.fn(async () => seat);
    return {
      logs,
      provision,
      deps: {
        detect: async () => [claude],
        provision,
        redeem: async () => seat,
        register: async () => {},
        baseUrl: () => "https://memracer.com",
        cwd: () => "/repo",
        log: (m) => logs.push(m),
        ...over,
      },
    };
  }

  it("wires provision with the picked harness and prints the connect line", async () => {
    const { deps: d, logs, provision } = deps();
    await runEnroll({ token: "tok" }, d);
    expect(provision).toHaveBeenCalledTimes(1);
    const arg = provision.mock.calls[0]![0];
    expect(arg).toMatchObject({ baseUrl: "https://memracer.com", token: "tok", folder: "/repo", harness: claude });
    expect(logs[0]).toContain("coder seat connected to Memracer via claude");
  });

  it("tells codex seats to just run codex in the configured folder", async () => {
    const codex: HarnessWriter = { id: "codex", bin: "codex", write: async () => undefined, locate: () => "" };
    const { deps: d, logs } = deps({ detect: async () => [codex] });
    await runEnroll({ token: "tok" }, d);
    expect(logs.join("\n")).toMatch(/\.codex\/config\.toml/);
    expect(logs.join("\n")).toContain("run `codex`");
  });

  it("surfaces the no-harness error", async () => {
    const { deps: d } = deps({ detect: async () => [] });
    await expect(runEnroll({ token: "tok" }, d)).rejects.toThrow(/No supported harness/);
  });
});
