// tests/coder-kit-task-prompt.test.ts
import { describe, expect, it } from "vitest";
import { buildTaskPrompt } from "../coder-kit/task-prompt.mjs";
import { isGoalTaskBody } from "../coder-kit/goal-task.mjs";

const brief = {
  id: 42,
  project_id: "demo",
  title: "Rate limit ingest",
  body: "Add a limiter.\n\nAcceptance: 429 after 100 req/min per token.",
  priority: 1,
  state: "CLAIMED",
  base_sha: "abc123",
  repo: "recallnet/ingest",
  submitted_by: "dana",
  lease_agent: "cc-7f2",
  lease_expires_at: 1234567890,
  result_summary: null,
  result_pr_url: null,
  grooming_rationale: "accepted; scoped to the ingest API only",
  parent_id: null,
  evidence: [
    { kind: "code", path: "src/ingest.ts", lines: "10-24", snippet: "app.post('/ingest', ...)", note: "unthrottled handler" },
    { kind: "link", note: "design doc", path: undefined, lines: undefined, snippet: "https://example.com/doc" },
  ],
  attempts: [{ agent: "cc-old", outcome: "lease_expired", notes: "lease expired; task requeued" }],
  questions: [{ question: "which window?", answer: "sliding", status: "answered", asked_by: "cc-old" }],
};

describe("buildTaskPrompt", () => {
  const prompt = buildTaskPrompt(brief);

  it("carries the full brief: title, body, priority, repo, base sha, grooming rationale", () => {
    expect(prompt).toContain("Task 42: Rate limit ingest");
    expect(prompt).toContain("Acceptance: 429 after 100 req/min per token.");
    expect(prompt).toContain("Priority: 1");
    expect(prompt).toContain("recallnet/ingest");
    expect(prompt).toContain("abc123");
    expect(prompt).toContain("accepted; scoped to the ingest API only");
  });

  it("renders evidence with file:lines and snippets", () => {
    expect(prompt).toContain("src/ingest.ts:10-24");
    expect(prompt).toContain("app.post('/ingest', ...)");
    expect(prompt).toContain("unthrottled handler");
  });

  it("renders prior attempts and answered questions", () => {
    expect(prompt).toContain("cc-old");
    expect(prompt).toContain("lease expired; task requeued");
    expect(prompt).toContain("which window?");
    expect(prompt).toContain("sliding");
  });

  it("instructs plan proposal and approval before any coding", () => {
    expect(prompt).toMatch(/coder_propose_plan/);
    expect(prompt).toMatch(/before (writing|you write) any code/i);
    expect(prompt).toMatch(/pending/i);
    expect(prompt).toMatch(/SAME args|same args/i);
    expect(prompt).toMatch(/"approved"/);
    expect(prompt).toMatch(/"revise"/);
  });

  it("instructs progress cadence and the correction boundary", () => {
    expect(prompt).toMatch(/coder_progress/);
    expect(prompt).toMatch(/every few minutes/i);
    expect(prompt).toMatch(/no reliable channel for mid-execution corrections/i);
    expect(prompt).not.toMatch(/pending_steers/);
  });

  it("covers ask/park/complete/block/release endgame", () => {
    expect(prompt).toContain("coder_ask");
    expect(prompt).toContain("coder_park");
    expect(prompt).toContain("coder_complete");
    expect(prompt).toContain("coder_block");
    expect(prompt).toContain("coder_release");
    expect(prompt).toContain("task_id 42");
  });

  it("states the plan window and strict PR completion requirements", () => {
    expect(prompt).toMatch(/60 minutes/);
    expect(prompt).toContain("pr_url");
    expect(prompt).toContain("pr_description");
    expect(prompt).toMatch(/verbatim/);
  });

  it("defaults to stacked PRs while preserving one PR per completion", () => {
    expect(prompt).toMatch(/Default to stacked PRs/i);
    expect(prompt).toMatch(/one small logical change per PR/i);
    expect(prompt).toMatch(/Each coder_complete call carries one PR URL/i);
  });

  it("omits empty sections", () => {
    const bare = buildTaskPrompt({ ...brief, evidence: [], attempts: [], questions: [], grooming_rationale: null, base_sha: null, repo: null });
    expect(bare).not.toContain("## Evidence");
    expect(bare).not.toContain("## Prior attempts");
    expect(bare).not.toContain("## Questions");
    expect(bare).not.toContain("Grooming rationale");
  });

  it("adds continuous verification instructions only for all-three-marker goals", () => {
    const goal = buildTaskPrompt({
      ...brief,
      body: "Goal: all auth tests pass.\nVerify: pnpm test:auth; PASS means exit 0.\nInvariants: public auth behavior; do not change migrations.",
    });
    expect(goal).toContain("## Goal execution");
    expect(goal).toMatch(/keep iterating until the exact Verify command/i);
    expect(goal).toMatch(/Finish only when verified/i);

    const partial = buildTaskPrompt({ ...brief, body: "Goal: improve auth.\nVerify: pnpm test:auth" });
    expect(partial).not.toContain("## Goal execution");
  });

  it("recognizes only the exact ordered three-line canonical goal shape", () => {
    const canonical = "Goal: auth passes.\nVerify: pnpm test:auth; PASS means exit 0.\nInvariants: preserve API.";
    expect(isGoalTaskBody(canonical)).toBe(true);
    expect(isGoalTaskBody(`${canonical}\nExtra: nope`)).toBe(false);
    expect(isGoalTaskBody(`${canonical}\nGoal: duplicate`)).toBe(false);
    expect(isGoalTaskBody("Verify: pnpm test\nGoal: tests pass\nInvariants: preserve API")).toBe(false);
    expect(isGoalTaskBody("Goal: tests pass\nVerify: pnpm test")).toBe(false);
    expect(isGoalTaskBody("Goal:\nVerify: pnpm test\nInvariants: preserve API")).toBe(false);
  });
});
