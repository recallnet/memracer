import { describe, expect, it } from "vitest";
import { formatUsd } from "../src/dashboard/web/lib/format-usd.js";

describe("formatUsd", () => {
  it("renders exact zero as $0.00", () => {
    expect(formatUsd(0)).toBe("$0.00");
  });

  it("never renders nonzero sub-cent spend as $0.00", () => {
    expect(formatUsd(0.001)).toBe("<$0.01");
    expect(formatUsd(0.004)).toBe("<$0.01");
    expect(formatUsd(0.0001)).toBe("<$0.01");
    // Rounds up to a visible cent — not free, not the floor indicator.
    expect(formatUsd(0.009)).toBe("$0.01");
  });

  it("uses two decimals for amounts that survive cents rounding", () => {
    expect(formatUsd(0.207)).toBe("$0.21");
    expect(formatUsd(4.5)).toBe("$4.50");
    expect(formatUsd(14.72)).toBe("$14.72");
  });

  it("preserves sign on negative sub-cent amounts", () => {
    expect(formatUsd(-0.001)).toBe("-<$0.01");
    expect(formatUsd(-1.5)).toBe("-$1.50");
  });
});
