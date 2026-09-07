import { describe, expect, it } from "vitest";
import { parseConsolidationCliArgs } from "../src/mediator/okf-consolidation-cli.js";

describe("project-memory consolidation CLI modes", () => {
  it("requires an input file and requires apply to consume one explicit input", () => {
    expect(parseConsolidationCliArgs(["memracer", "spec.json"]))
      .toMatchObject({ projectId: "memracer", inputPath: "spec.json", apply: false, restore: false });
    expect(() => parseConsolidationCliArgs(["memracer"])).toThrow(/input is required/);
    expect(parseConsolidationCliArgs(["memracer", "reviewed-plan.json", "--apply", "--writers-stopped"]))
      .toMatchObject({ inputPath: "reviewed-plan.json", apply: true, writersStopped: true });
    expect(() => parseConsolidationCliArgs(["memracer", "--apply"]))
      .toThrow(/explicit input file/);
  });

  it("keeps restore exclusive from apply", () => {
    expect(() => parseConsolidationCliArgs(["memracer", "snapshot.json", "--restore", "--apply"]))
      .toThrow(/mutually exclusive/);
  });
});
