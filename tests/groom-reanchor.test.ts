import { describe, it, expect } from "vitest";
import { reanchorMessages, compactToolResults } from "../src/mediator/openrouter";

describe("reanchorMessages", () => {
  it("appends the verbatim goal as the last user message", () => {
    const msgs = [
      { role: "system", content: "SYS" },
      { role: "user", content: "groom prompt" },
      { role: "assistant", content: null, tool_calls: [] },
      { role: "tool", tool_call_id: "t1", content: "sibling task body about colors" },
    ] as any[];
    const out = reanchorMessages(msgs, "GOAL: normalize Hyperliquid orders to nearest lot");
    expect(out[out.length - 1]).toEqual({ role: "user", content: "GOAL: normalize Hyperliquid orders to nearest lot" });
  });

  it("replaces a prior reminder instead of stacking duplicates", () => {
    const msgs = [
      { role: "user", content: "GOAL: X" },
      { role: "tool", tool_call_id: "t1", content: "r" },
      { role: "user", content: "GOAL: X" },
    ] as any[];
    const out = reanchorMessages(msgs, "GOAL: X");
    expect(out.filter((m) => m.content === "GOAL: X").length).toBe(1);
    expect(out[out.length - 1].content).toBe("GOAL: X");
  });
});

describe("compactToolResults", () => {
  it("compacts accumulated tool results before re-requesting", () => {
    const msgs = Array.from({ length: 8 }, (_, i) => ({ role: "tool", tool_call_id: `t${i}`, content: "X".repeat(4000) })) as any[];
    const compacted = compactToolResults(msgs);
    const before = msgs.reduce((n, m) => n + (m.content?.length ?? 0), 0);
    const after = compacted.reduce((n, m) => n + (m.content?.length ?? 0), 0);
    expect(after).toBeLessThan(before);
  });
});
