import { describe, expect, it } from "vitest";
import type {
  AnswerInput,
  AnswerResult,
  GroomResult,
  MediatorContext,
  MediatorDriver,
  ReviewInput,
  ReviewResult,
  Submission,
} from "../src/mediator/driver.js";
import type { AnswerFixture, GroomFixture, ReviewFixture } from "../src/eval/fixtures.js";
import { runEval } from "../src/eval/run.js";
import { FakeDriver } from "../src/mediator/fake.js";

/** Driver returning pre-programmed results keyed by submission title / plan / question. */
class ScriptedDriver implements MediatorDriver {
  constructor(
    private readonly grooms: Record<string, GroomResult>,
    private readonly reviews: Record<string, ReviewResult> = {},
    private readonly answers: Record<string, AnswerResult> = {},
  ) {}
  async groom(_ctx: MediatorContext, s: Submission): Promise<GroomResult> {
    const r = this.grooms[s.title];
    if (!r) throw new Error(`unscripted groom: ${s.title}`);
    return r;
  }
  async review(_ctx: MediatorContext, input: ReviewInput): Promise<ReviewResult> {
    const r = this.reviews[input.plan];
    if (!r) throw new Error(`unscripted review: ${input.plan}`);
    return r;
  }
  async answer(_ctx: MediatorContext, input: AnswerInput): Promise<AnswerResult> {
    const r = this.answers[input.question];
    if (!r) throw new Error(`unscripted answer: ${input.question}`);
    return r;
  }
  async curate(): Promise<never> {
    throw new Error("curate not evaluated");
  }
  async eligibility(): Promise<never> {
    throw new Error("eligibility not evaluated");
  }
}

const queue = [{ id: 7, title: "existing task", state: "QUEUED", priority: 1 }];

function groomCase(name: string, title: string, golden: GroomFixture["golden"]): GroomFixture {
  return { name, queue, submission: { title, body: `body of ${title}`, priority: 1, evidence: [] }, golden };
}

const groomFixtures: GroomFixture[] = [
  groomCase("g-accept", "add feature", { action: "accept" }),
  groomCase("g-merge", "dup of existing", { action: "merge", into_task_id: 7 }),
  groomCase("g-clarify", "vague ask", { action: "clarify" }),
];

const reviewFixtures: ReviewFixture[] = [
  {
    name: "r-sound",
    task: { title: "t1", body: "criteria: test added" },
    plan: "plan-sound",
    golden: { verdict: "approved" },
  },
  {
    name: "r-miss-ac",
    task: { title: "t2", body: "criteria: migration reversible" },
    plan: "plan-miss-ac",
    missesAcceptanceCriterion: true,
    golden: { verdict: "revise" },
  },
  {
    name: "r-risky",
    task: { title: "t3", body: "criteria: zero downtime" },
    plan: "plan-risky",
    golden: { verdict: "revise" },
  },
];

const answerFixtures: AnswerFixture[] = [
  { name: "a-answerable", task: { title: "t", body: "b" }, question: "q-answerable", golden: { escalate: false } },
  { name: "a-escalate", task: { title: "t", body: "b" }, question: "q-escalate", golden: { escalate: true } },
];

const fixtures = { groom: groomFixtures, review: reviewFixtures, answer: answerFixtures };
const longFeedback = "Add the reversible down migration and a regression test covering the criteria.";

describe("runEval scoring", () => {
  it("keeps the default FakeDriver above every enforced CLI threshold", async () => {
    const card = await runEval(new FakeDriver());

    expect(card.perCase.length).toBeGreaterThanOrEqual(55);
    expect(card.groom.accuracy).toBeGreaterThanOrEqual(0.9);
    expect(card.groom.mergePrecision).toBeGreaterThanOrEqual(0.95);
    expect(card.groom.mergeRecall).toBeGreaterThanOrEqual(0.8);
    expect(card.groom.clarifyRate).toBeGreaterThanOrEqual(0.8);
    expect(card.review.badPlanApprovals).toBe(0);
    expect(card.review.actionableFeedbackRate).toBeGreaterThanOrEqual(0.9);
    expect(card.answer.accuracy).toBeGreaterThanOrEqual(0.9);
    expect(card.invalidJsonCount).toBe(0);
    expect(card.latency.p95Ms).toBeLessThan(20_000);
  });

  it("scores a perfect driver at 1.0 across the board", async () => {
    const driver = new ScriptedDriver(
      {
        "add feature": { action: "accept", title: "add feature", body: "b", priority: 1, rationale: "r" },
        "dup of existing": { action: "merge", into_task_id: 7, rationale: "r" },
        "vague ask": { action: "clarify", question: "what exactly?", rationale: "r" },
      },
      {
        "plan-sound": { verdict: "approved", feedback: "", rationale: "r" },
        "plan-miss-ac": { verdict: "revise", feedback: longFeedback, rationale: "r" },
        "plan-risky": { verdict: "revise", feedback: longFeedback, rationale: "r" },
      },
      {
        "q-answerable": { escalate: false, answer: "yes", rationale: "r" },
        "q-escalate": { escalate: true, rationale: "r" },
      },
    );
    const card = await runEval(driver, { fixtures });
    expect(card.groom).toEqual({ accuracy: 1, mergePrecision: 1, mergeRecall: 1, clarifyRate: 1 });
    expect(card.review).toEqual({ accuracy: 1, badPlanApprovals: 0, actionableFeedbackRate: 1 });
    expect(card.answer).toEqual({ accuracy: 1 });
    expect(card.invalidJsonCount).toBe(0);
    expect(card.costPer100Jobs).toBeNull();
    expect(card.perCase).toHaveLength(8);
    expect(card.perCase.every((c) => c.ok)).toBe(true);
    expect(card.perCase.every((c) => typeof c.ms === "number" && c.ms >= 0)).toBe(true);
    expect(card.latency.p50Ms).toBeGreaterThanOrEqual(0);
    expect(card.latency.p95Ms).toBeGreaterThanOrEqual(card.latency.p50Ms);
  });

  it("scores an all-wrong driver at 0 and counts bad-plan approvals", async () => {
    const driver = new ScriptedDriver(
      {
        "add feature": { action: "clarify", question: "?", rationale: "r" },
        "dup of existing": { action: "accept", title: "t", body: "b", priority: 1, rationale: "r" },
        "vague ask": { action: "merge", into_task_id: 7, rationale: "r" },
      },
      {
        "plan-sound": { verdict: "revise", feedback: "no", rationale: "r" },
        "plan-miss-ac": { verdict: "approved", feedback: "", rationale: "r" },
        "plan-risky": { verdict: "approved", feedback: "", rationale: "r" },
      },
      {
        "q-answerable": { escalate: true, rationale: "r" },
        "q-escalate": { escalate: false, answer: "no", rationale: "r" },
      },
    );
    const card = await runEval(driver, { fixtures });
    expect(card.groom.accuracy).toBe(0);
    expect(card.groom.mergePrecision).toBe(0); // 1 predicted merge, 0 correct
    expect(card.groom.mergeRecall).toBe(0); // 1 golden merge, 0 correct
    expect(card.groom.clarifyRate).toBe(0); // clarify never used on the golden-clarify case
    expect(card.review.accuracy).toBe(0);
    // only the golden-revise case flagged missesAcceptanceCriterion counts
    expect(card.review.badPlanApprovals).toBe(1);
    // one revise verdict issued, feedback "no" is shorter than 40 chars
    expect(card.review.actionableFeedbackRate).toBe(0);
    expect(card.answer.accuracy).toBe(0);
    expect(card.invalidJsonCount).toBe(0);
    expect(card.perCase.every((c) => !c.ok)).toBe(true);
  });

  it("computes mixed metrics exactly", async () => {
    const mixedGroom: GroomFixture[] = [
      groomCase("m-accept-ok", "a1", { action: "accept" }),
      groomCase("m-merge-ok", "m1", { action: "merge", into_task_id: 7 }),
      groomCase("m-merge-wrong-target", "m2", { action: "merge", into_task_id: 7 }),
      groomCase("m-clarify-missed", "c1", { action: "clarify" }),
      groomCase("m-false-merge", "a2", { action: "accept" }),
    ];
    const driver = new ScriptedDriver(
      {
        a1: { action: "accept", title: "a1", body: "b", priority: 1, rationale: "r" },
        m1: { action: "merge", into_task_id: 7, rationale: "r" },
        m2: { action: "merge", into_task_id: 999, rationale: "r" }, // merge but wrong target
        c1: { action: "accept", title: "c1", body: "b", priority: 1, rationale: "r" },
        a2: { action: "merge", into_task_id: 7, rationale: "r" }, // false merge
      },
      {
        "plan-sound": { verdict: "approved", feedback: "", rationale: "r" },
        "plan-miss-ac": { verdict: "revise", feedback: "short", rationale: "r" },
        "plan-risky": { verdict: "revise", feedback: longFeedback, rationale: "r" },
      },
      {
        "q-answerable": { escalate: false, answer: "yes", rationale: "r" },
        "q-escalate": { escalate: false, answer: "no", rationale: "r" },
      },
    );
    const card = await runEval(driver, { fixtures: { ...fixtures, groom: mixedGroom } });
    expect(card.groom.accuracy).toBeCloseTo(2 / 5); // a1, m1 correct
    expect(card.groom.mergePrecision).toBeCloseTo(1 / 3); // 3 predicted merges, 1 correct
    expect(card.groom.mergeRecall).toBeCloseTo(1 / 2); // 2 golden merges, 1 correct
    expect(card.groom.clarifyRate).toBe(0); // 1 golden clarify, missed
    expect(card.review.accuracy).toBe(1);
    expect(card.review.badPlanApprovals).toBe(0);
    expect(card.review.actionableFeedbackRate).toBeCloseTo(1 / 2); // one short, one long feedback
    expect(card.answer.accuracy).toBeCloseTo(1 / 2);
  });

  it("counts driver throws as invalid-JSON failures, not crashes", async () => {
    const throwing: MediatorDriver = {
      async groom() { throw new Error("invalid mediator output after retry"); },
      async review() { throw new Error("invalid mediator output after retry"); },
      async answer() { throw new Error("invalid mediator output after retry"); },
      async curate() { throw new Error("invalid mediator output after retry"); },
      async eligibility() { throw new Error("invalid mediator output after retry"); },
    };
    const card = await runEval(throwing, { fixtures });
    expect(card.invalidJsonCount).toBe(8);
    expect(card.groom.accuracy).toBe(0);
    expect(card.review.accuracy).toBe(0);
    expect(card.answer.accuracy).toBe(0);
    expect(card.perCase.every((c) => !c.ok)).toBe(true);
    expect(card.perCase.every((c) => c.got.startsWith("error"))).toBe(true);
  });

  it("uses the provided cost callback after the run", async () => {
    const driver = new ScriptedDriver(
      { a1: { action: "accept", title: "a1", body: "b", priority: 1, rationale: "r" } },
    );
    const card = await runEval(driver, {
      fixtures: { groom: [groomCase("g", "a1", { action: "accept" })], review: [], answer: [] },
      costPer100Jobs: () => 1.23,
    });
    expect(card.costPer100Jobs).toBe(1.23);
  });

  it("defaults to the golden fixture suite", async () => {
    const throwing: MediatorDriver = {
      async groom() { throw new Error("x"); },
      async review() { throw new Error("x"); },
      async answer() { throw new Error("x"); },
      async curate() { throw new Error("x"); },
      async eligibility() { throw new Error("x"); },
    };
    const card = await runEval(throwing);
    expect(card.perCase.length).toBeGreaterThanOrEqual(55);
  });
});
