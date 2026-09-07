import { describe, expect, it } from "vitest";
import { findRawSpacingDeclarations } from "../scripts/lint-dashboard-spacing.mjs";

describe("dashboard spacing lint", () => {
  it("accepts zero and token-composed spacing", () => {
    expect(findRawSpacingDeclarations(`
      .a { padding: 0 var(--sp-4); margin-block: var(--sp-2); }
      .b { gap: calc(var(--sp-3) + var(--sp-1)); }
      .c { border: 1px solid; width: 12rem; }
    `)).toEqual([]);
  });

  it("rejects raw px and rem in shorthand, logical, and gap declarations", () => {
    expect(findRawSpacingDeclarations(`
      .a { padding: 4px 0; }
      .b { margin-inline-start: -1px; }
      .c { row-gap: .5rem; }
    `, "fixture.css")).toEqual([
      { file: "fixture.css", line: 2, property: "padding", value: "4px 0" },
      { file: "fixture.css", line: 3, property: "margin-inline-start", value: "-1px" },
      { file: "fixture.css", line: 4, property: "row-gap", value: ".5rem" },
    ]);
  });

  it("rejects raw spacing in inline HTML styles", () => {
    expect(findRawSpacingDeclarations('<div style="margin-top:12px">', "join.html")).toEqual([
      { file: "join.html", line: 1, property: "margin-top", value: "12px" },
    ]);
  });
});
