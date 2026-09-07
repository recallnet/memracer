import { describe, expect, it, vi } from "vitest";
import { claudeWriter } from "../src/harness/claude.js";
import type { SeatConfig } from "../src/harness/index.js";

const seat: SeatConfig = {
  name: "memracer",
  url: "https://memracer.com/mcp",
  token: "mzr_live_x",
  folder: "/repo/wt/coder",
};

describe("claudeWriter", () => {
  it("runs the exact claude mcp add argv in the seat folder", async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    await claudeWriter.write(seat, run);
    expect(run).toHaveBeenCalledWith(
      "claude",
      [
        "mcp",
        "add",
        "memracer",
        "--transport",
        "http",
        "https://memracer.com/mcp",
        "--header",
        "Authorization: Bearer mzr_live_x",
        "--scope",
        "local",
      ],
      { cwd: "/repo/wt/coder" },
    );
  });

  it("throws when the harness exits non-zero", async () => {
    const run = vi.fn(async () => ({ code: 1, stdout: "", stderr: "boom" }));
    await expect(claudeWriter.write(seat, run)).rejects.toThrow(/boom/);
  });
});
