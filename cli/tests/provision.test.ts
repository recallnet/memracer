import { describe, expect, it, vi } from "vitest";
import { provisionSeat } from "../src/provision.js";
import type { RedeemedSeat } from "../src/api.js";
import type { HarnessWriter, Runner, SeatConfig } from "../src/harness/index.js";

const seat: RedeemedSeat = {
  key: "mzr_live_secret",
  keyId: "k1abcdef",
  project: "proj-123",
  projectId: "proj-123",
  projectName: "Memracer",
  role: "coder",
  mcpUrl: "https://memracer.com/mcp",
};

function writer(id: HarnessWriter["id"], write: HarnessWriter["write"]): HarnessWriter {
  return { id, bin: id, write, locate: () => `loc-${id}` };
}

describe("provisionSeat", () => {
  it("redeems, writes the scoped SeatConfig, and records the seat", async () => {
    const write = vi.fn(async (_seat: SeatConfig, _run: Runner) => undefined);
    const redeem = vi.fn(async () => seat);
    const register = vi.fn(async () => {});
    const result = await provisionSeat({
      baseUrl: "https://memracer.com",
      token: "mzr_enrl_tok",
      folder: "/repo/coder",
      harness: writer("claude", write),
      redeem,
      register,
      writeSeatEnv: vi.fn(async () => {}),
    });

    expect(result).toBe(seat);
    expect(redeem).toHaveBeenCalledWith("https://memracer.com", "mzr_enrl_tok");
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]![0]).toEqual({
      name: "memracer",
      url: seat.mcpUrl,
      token: seat.key,
      folder: "/repo/coder",
    });
    expect(register).toHaveBeenCalledWith({
      project: "proj-123",
      role: "coder",
      folder: "/repo/coder",
      harness: "claude",
      keyId: "k1abcdef",
      envVar: undefined,
    });
  });

  it("gives codex a unique server name and records the returned env var", async () => {
    const write = vi.fn(async (_seat: SeatConfig, _run: Runner) => ({
      envVar: "MEMRACER_TOKEN_X",
      token: seat.key,
    }));
    const register = vi.fn(async () => {});
    await provisionSeat({
      baseUrl: "b",
      token: "t",
      folder: "/f",
      harness: writer("codex", write),
      redeem: async () => seat,
      register,
      writeSeatEnv: vi.fn(async () => {}),
    });

    expect(write.mock.calls[0]![0].name).toBe(`memracer_coder_${seat.keyId.slice(0, 4)}`);
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({ harness: "codex", envVar: "MEMRACER_TOKEN_X" }),
    );
  });
});
