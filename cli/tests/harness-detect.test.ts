import { describe, expect, it, vi } from "vitest";
import { detectHarnesses } from "../src/harness/detect.js";

describe("detectHarnesses", () => {
  it("returns only the writers whose bin resolves", async () => {
    const which = vi.fn(async (bin: string) =>
      bin === "claude" || bin === "codex" ? `/usr/local/bin/${bin}` : null,
    );
    const found = await detectHarnesses(which);
    expect(found.map((w) => w.id).sort()).toEqual(["claude", "codex"]);
  });
});
