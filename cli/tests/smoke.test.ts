import { describe, expect, it } from "vitest";
import { buildProgram } from "../src/index.js";

describe("buildProgram", () => {
  it("registers the seven subcommands", () => {
    const names = buildProgram().commands.map((c) => c.name()).sort();
    expect(names).toEqual(["enroll", "login", "ps", "run", "seat", "update", "wait"].sort());
  });
});
