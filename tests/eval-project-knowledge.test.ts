import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  PROJECT_KNOWLEDGE_MUTATIONS,
  runProjectKnowledgeEval,
  type ProjectKnowledgeMutation,
} from "../src/eval/project-knowledge.js";

const execFileAsync = promisify(execFile);

describe("adaptive project-knowledge eval", () => {
  it("grades the real refresh pipeline by persisted outcomes", async () => {
    const card = await runProjectKnowledgeEval();

    expect(card.domainCount).toBe(10);
    expect(card.failed).toBe(0);
    expect(card.perCase.every((result) => result.ok)).toBe(true);

    const adaptive = card.perCase.find((result) => result.name === "equal-age-adapts-to-current-context")!;
    expect(adaptive.observations.architectureSelection).not.toEqual(adaptive.observations.teamSelection);
    expect(adaptive.observations.architectureSelection).toContain("architecture-tech");
    expect(adaptive.observations.teamSelection).toContain("team-people");

    const competent = card.perCase.find((result) => result.name === "competent-context-asks-nothing")!;
    expect(competent.observations.questionCount).toBe(0);

    const triggers = card.perCase.find((result) => result.name === "all-trigger-classes-reach-the-channel")!;
    expect(triggers.observations.triggers).toEqual(["EVENTS", "STALENESS", "TIME"]);

    const channel = card.perCase.find((result) => result.name === "question-channel-is-bounded")!;
    expect(channel.observations.questionCount).toBeLessThanOrEqual(3);
    expect(channel.observations.questionMarks).toEqual(
      expect.arrayContaining(Array(channel.observations.questionCount as number).fill(1)),
    );

    const oldest = card.perCase.find((result) => result.name === "oldest-knowledge-wins")!;
    expect(oldest.observations.oldestFirst).toBe(true);

    const answer = card.perCase.find((result) => result.name === "project-answer-curates-memory")!;
    expect(answer.observations.questionStatus).toBe("answered");
    expect(answer.observations.memoryUpdated).toBe(true);
    expect(answer.observations.toolNames).toEqual(expect.arrayContaining(["okf_grep", "okf_read", "okf_update"]));
  });

  it.each(PROJECT_KNOWLEDGE_MUTATIONS)("catches the %s mutation", async (mutation: ProjectKnowledgeMutation) => {
    const card = await runProjectKnowledgeEval({ mutations: [mutation] });
    expect(card.failed).toBeGreaterThan(0);
    expect(card.perCase.some((result) => !result.ok)).toBe(true);
  });

  it("is available as a standalone flag and runs in the default offline gate", async () => {
    const standalone = await execFileAsync(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "scripts/eval.ts", "--project-knowledge"],
      { cwd: process.cwd(), timeout: 30_000 },
    );
    expect(standalone.stdout).toContain("Project-knowledge eval");
    expect(standalone.stdout).toContain("domains: 10");
    expect(standalone.stdout).toContain("RESULT: PASS");

    const defaultRun = await execFileAsync(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "scripts/eval.ts"],
      { cwd: process.cwd(), timeout: 30_000 },
    );
    expect(defaultRun.stdout).toContain("Project-knowledge eval");
    expect(defaultRun.stdout).toContain("domains: 10");
    expect(defaultRun.stdout).toContain("RESULT: PASS");
  }, 65_000);
});
