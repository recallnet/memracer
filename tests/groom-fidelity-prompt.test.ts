import { describe, expect, it } from "vitest";
import { buildGroomPrompt, buildEligibilityPrompt } from "../src/mediator/prompts.js";
import type { MediatorContext, Submission } from "../src/mediator/driver.js";

const ctx: MediatorContext = {
  projectId: "p1",
  projectName: "Project One",
  queue: [{ id: 7, title: "existing task", state: "QUEUED", priority: 1 }],
  decisions: [{ kind: "groom", summary: "s", rationale: "r" }],
  memory: "",
};

const submission: Submission = {
  taskId: 9,
  title: "new task",
  body: "do the thing",
  priority: 2,
  submittedBy: "dana",
  evidence: [{ kind: "log", content: "boom" }],
};

describe("buildGroomPrompt fidelity", () => {
  it("groom prompt orders extraction before exploration and demands source fidelity", () => {
    const p = buildGroomPrompt(ctx, submission);
    expect(p).toMatch(/extract before you explore|restate the submission/i);
    expect(p).toMatch(/your brief MUST be about the submission's subject/i);
    expect(p).toMatch(/never substitute an easier or adjacent task/i);
  });
});

describe("buildEligibilityPrompt", () => {
  it("eligibility prompt asks the FACTS phase-1 question over only submission+brief", () => {
    const p = buildEligibilityPrompt({ submission: "normalize orders", brief: "add color customization" });
    expect(p).toMatch(/serve the same request/i);
    expect(p).not.toMatch(/tool|queue|memory|sibling/i); // no loop context leaks in
  });
});
