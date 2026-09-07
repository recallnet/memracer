import { describe, expect, it } from "vitest";
import { answerFixtures, groomFixtures, reviewFixtures } from "../src/eval/fixtures.js";

describe("eval fixtures", () => {
  it("has at least 30 groom cases with the required category mix", () => {
    expect(groomFixtures.length).toBeGreaterThanOrEqual(30);
    const byAction = (a: string) => groomFixtures.filter((f) => f.golden.action === a);
    expect(byAction("accept").length).toBeGreaterThanOrEqual(12);
    expect(byAction("merge").length).toBeGreaterThanOrEqual(8);
    expect(byAction("clarify").length).toBeGreaterThanOrEqual(6);
  });

  it("golden merges point at a task that exists in the fixture's queue", () => {
    for (const f of groomFixtures) {
      if (f.golden.action === "merge") {
        expect(f.golden.into_task_id, f.name).toBeDefined();
        expect(f.queue.map((t) => t.id), f.name).toContain(f.golden.into_task_id);
      } else {
        expect(f.golden.into_task_id, f.name).toBeUndefined();
      }
    }
  });

  it("no groom fixture is gameable via FakeDriver markers", () => {
    for (const f of groomFixtures) {
      const text = JSON.stringify(f.submission);
      expect(text, f.name).not.toMatch(/MERGE:/);
      expect(text, f.name).not.toMatch(/CLARIFY:/);
    }
  });

  it("groom fixture names are unique", () => {
    const names = groomFixtures.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("has at least 15 review cases with the required mix", () => {
    expect(reviewFixtures.length).toBeGreaterThanOrEqual(15);
    const approved = reviewFixtures.filter((f) => f.golden.verdict === "approved");
    const revise = reviewFixtures.filter((f) => f.golden.verdict === "revise");
    expect(approved.length).toBeGreaterThanOrEqual(5);
    expect(revise.length).toBeGreaterThanOrEqual(8);
    const names = reviewFixtures.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("has at least 10 answer cases, split between answerable and escalate", () => {
    expect(answerFixtures.length).toBeGreaterThanOrEqual(10);
    const escalate = answerFixtures.filter((f) => f.golden.escalate);
    const answerable = answerFixtures.filter((f) => !f.golden.escalate);
    expect(escalate.length).toBeGreaterThanOrEqual(4);
    expect(answerable.length).toBeGreaterThanOrEqual(4);
    const names = answerFixtures.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
