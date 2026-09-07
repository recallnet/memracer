import { describe, expect, it, vi } from "vitest";
import { grokWriter } from "../src/harness/grok.js";
import type { SeatConfig } from "../src/harness/index.js";

const seat: SeatConfig = {
  name: "memracer",
  url: "https://memracer.com/mcp",
  token: "mzr_live_x",
  folder: "/repo/wt/coder",
};

describe("grokWriter", () => {
  it("runs the grok argv and gitignores .grok/", async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const ensure = vi.fn(async () => {});
    await grokWriter.write(seat, run, ensure);
    expect(run).toHaveBeenCalledWith(
      "grok",
      [
        "mcp",
        "add",
        "memracer",
        "https://memracer.com/mcp",
        "-t",
        "http",
        "-H",
        "Authorization: Bearer mzr_live_x",
        "-s",
        "project",
      ],
      { cwd: "/repo/wt/coder" },
    );
    expect(ensure).toHaveBeenCalledWith("/repo/wt/coder", ".grok/");
  });

  it("throws when the harness exits non-zero", async () => {
    const run = vi.fn(async () => ({ code: 2, stdout: "", stderr: "nope" }));
    const ensure = vi.fn(async () => {});
    await expect(grokWriter.write(seat, run, ensure)).rejects.toThrow(/nope/);
    expect(ensure).not.toHaveBeenCalled();
  });
});
