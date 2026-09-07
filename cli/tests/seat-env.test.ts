import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provisionSeat } from "../src/provision.js";
import { readSeatEnv, SEAT_ENV_FILE } from "../src/seat-env.js";
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

describe("provisionSeat writes .memracer.env (Fix B)", () => {
  it("writes the 5 seat vars, chmods 0600, and gitignores the file", async () => {
    const folder = mkdtempSync(join(tmpdir(), "seat-env-"));
    const write = vi.fn(async (_seat: SeatConfig, _run: Runner) => undefined);
    const register = vi.fn(async () => {});

    await provisionSeat({
      baseUrl: "https://memracer.com",
      token: "mzr_enrl_tok",
      folder,
      harness: writer("claude", write),
      redeem: async () => seat,
      register,
    });

    const envPath = join(folder, SEAT_ENV_FILE);
    const text = readFileSync(envPath, "utf8");
    expect(text).toContain("MEMRACER_URL=https://memracer.com");
    expect(text).toContain("MEMRACER_MCP_URL=https://memracer.com/mcp");
    expect(text).toContain("MEMRACER_TOKEN=mzr_live_secret");
    expect(text).toContain("MEMRACER_PROJECT=proj-123");
    expect(text).toContain("MEMRACER_ROLE=coder");

    // mode 0600 — it holds the seat secret
    expect(statSync(envPath).mode & 0o777).toBe(0o600);

    // gitignored so the secret never gets committed
    expect(readFileSync(join(folder, ".gitignore"), "utf8")).toContain(SEAT_ENV_FILE);

    // and it round-trips back into a seat context
    const ctx = readSeatEnv(folder, {});
    expect(ctx).toMatchObject({
      baseUrl: "https://memracer.com",
      token: "mzr_live_secret",
      project: "proj-123",
      role: "coder",
    });
  });
});
