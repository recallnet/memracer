import { describe, expect, it } from "vitest";
import {
  hasUniqueCompetingClaimSplit,
  idleSnapshotsUnchanged,
  type IdleDbSnapshot,
} from "../src/eval/bare-coder-grader.js";

const baseline: IdleDbSnapshot = {
  tasks: [{ id: 1, state: "CLAIMED", lease_agent: "sentinel", lease_expires_at: 10 }],
  attempts: [],
  projects: [{ id: "demo", claim_generation: 1, last_active_lease_at: 5 }],
};

describe("bare-coder eval grader", () => {
  it("requires every observed empty-cycle database snapshot to stay identical", () => {
    expect(idleSnapshotsUnchanged(baseline, [structuredClone(baseline), structuredClone(baseline)])).toBe(true);
    const mutated = structuredClone(baseline);
    (mutated.tasks[0] as { lease_agent: string }).lease_agent = "hidden-check-owner";
    expect(idleSnapshotsUnchanged(baseline, [structuredClone(baseline), mutated])).toBe(false);
    expect(idleSnapshotsUnchanged(baseline, [])).toBe(false);
  });

  it("requires the competitor and primary coder to receive distinct intended tasks", () => {
    const common = {
      primaryAgent: "bare-coder",
      competitorAgent: "bare-competitor",
      raceTaskId: 2,
      lifecycleTaskId: 3,
    };
    expect(hasUniqueCompetingClaimSplit({
      ...common,
      claims: [
        { agent: "bare-competitor", taskId: 2 },
        { agent: "bare-coder", taskId: 3 },
      ],
    })).toBe(true);
    expect(hasUniqueCompetingClaimSplit({
      ...common,
      claims: [
        { agent: "bare-competitor", taskId: 2 },
        { agent: "bare-coder", taskId: null },
      ],
    })).toBe(false);
    expect(hasUniqueCompetingClaimSplit({
      ...common,
      claims: [
        { agent: "bare-competitor", taskId: 2 },
        { agent: "bare-coder", taskId: 2 },
      ],
    })).toBe(false);
    expect(hasUniqueCompetingClaimSplit({
      ...common,
      claims: [
        { agent: "bare-competitor", taskId: 2 },
        { agent: "bare-coder", taskId: null },
        { agent: "bare-coder", taskId: 3 },
      ],
    })).toBe(false);
  });
});
