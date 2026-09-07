import { describe, expect, it, vi } from "vitest";
import { runPs, type PsDeps } from "../src/commands/ps.js";
import type { SeatRecord } from "../src/registry.js";
import type { SeatLive } from "../src/api.js";

const records: SeatRecord[] = [
  { project: "proj-1", role: "human", folder: "/repo", harness: "claude", keyId: "k1" },
  { project: "proj-1", role: "coder", folder: "/repo/.mcr/coder-1", harness: "codex", keyId: "k2", envVar: "V" },
];

function deps(over: Partial<PsDeps> = {}): { deps: PsDeps; logs: string[]; seatsLive: ReturnType<typeof vi.fn> } {
  const logs: string[] = [];
  const seatsLive = vi.fn(async (_b: string, _p: string, _t?: string): Promise<SeatLive[]> => []);
  return {
    logs,
    seatsLive,
    deps: {
      list: () => records,
      seatsLive: seatsLive as unknown as PsDeps["seatsLive"],
      baseUrl: () => "https://memracer.com",
      operatorToken: () => undefined,
      log: (m) => logs.push(m),
      ...over,
    },
  };
}

describe("runPs", () => {
  it("renders one row per local seat with unknown liveness when no operator token", async () => {
    const { deps: d, logs, seatsLive } = deps();
    await runPs(d);
    expect(seatsLive).not.toHaveBeenCalled();
    const out = logs.join("\n");
    expect(out).toContain("proj-1");
    expect(out).toContain("/repo  human  claude  —");
    expect(out).toContain("/repo/.mcr/coder-1  coder  codex  —");
  });

  it("annotates live/idle from seats/live when an operator token is set", async () => {
    const seatsLive = vi.fn(async () => [
      { keyId: "k1", role: "human", name: null, lastRequest: Date.now(), live: true },
      { keyId: "k2", role: "coder", name: null, lastRequest: null, live: false },
    ] as SeatLive[]);
    const { deps: d, logs } = deps({ operatorToken: () => "op_tok", seatsLive: seatsLive as unknown as PsDeps["seatsLive"] });
    await runPs(d);
    expect(seatsLive).toHaveBeenCalledWith("https://memracer.com", "proj-1", "op_tok");
    const out = logs.join("\n");
    expect(out).toContain("/repo  human  claude  ●live");
    expect(out).toContain("/repo/.mcr/coder-1  coder  codex  ○idle");
  });

  it("degrades to unknown when the liveness fetch fails", async () => {
    const seatsLive = vi.fn(async () => {
      throw new Error("network down");
    });
    const { deps: d, logs } = deps({ operatorToken: () => "op_tok", seatsLive: seatsLive as unknown as PsDeps["seatsLive"] });
    await runPs(d);
    expect(logs.join("\n")).toContain("/repo  human  claude  —");
  });

  it("reports when nothing is configured", async () => {
    const { deps: d, logs } = deps({ list: () => [] });
    await runPs(d);
    expect(logs.join("\n")).toMatch(/No seats configured/);
  });
});
