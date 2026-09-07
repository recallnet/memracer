import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolve } from "node:path";

describe("dependency order-only contract", () => {
  it("discuss/steward prompt never claims dependents are unleaseable until DONE", () => {
    const path = resolve("src/mediator/prompts.ts");
    const src = readFileSync(path, "utf8");
    expect(src).not.toMatch(/not leased to any coder until the predecessor is DONE/i);
    expect(src).toMatch(/Order hint ONLY/i);
    expect(src).toMatch(/never a claim gate/i);
  });

  it("groom prompt states depends_on is order-only", () => {
    const src = readFileSync(resolve("src/mediator/prompts.ts"), "utf8");
    expect(src).toMatch(/ORDER hint only, never a gate/i);
  });

  it("queue.ts documents dependencies as order-only", () => {
    const src = readFileSync(resolve("src/queue.ts"), "utf8");
    expect(src).toMatch(/ORDER ONLY/i);
    expect(src).toMatch(/never a claim gate/i);
  });
});
