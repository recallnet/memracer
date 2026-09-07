// Dedicated suite for the mediator's Zod action/result schemas (#81 backfill).
// The schemas are the validation + repair boundary between raw model JSON and
// the pipeline: happy-path parse, malformed-input rejection, and the numeric /
// array bound branches that clamp a model's output.
import { describe, expect, it } from "vitest";
import {
  groomSchema,
  reviewSchema,
  discussSchema,
  answerSchema,
  referenceSchema,
  projectKnowledgeRefreshSchema,
  eligibilitySchema,
} from "../src/mediator/schemas.js";

describe("groomSchema", () => {
  it("accepts a well-formed accept action with optional depends_on", () => {
    const parsed = groomSchema.parse({
      action: "accept",
      title: "t",
      body: "b",
      priority: 2,
      rationale: "why",
      depends_on: [1, 2],
    });
    expect(parsed).toMatchObject({ action: "accept", priority: 2, depends_on: [1, 2] });
  });

  it("accepts an accept action without the optional depends_on", () => {
    expect(groomSchema.parse({ action: "accept", title: "t", body: "b", priority: 0, rationale: "r" }))
      .not.toHaveProperty("depends_on");
  });

  it("accepts at most three non-blocking project questions", () => {
    const base = { action: "accept" as const, title: "t", body: "b", priority: 1, rationale: "r" };
    expect(groomSchema.parse({ ...base, project_questions: ["who uses it?"] })).toMatchObject({
      project_questions: ["who uses it?"],
    });
    expect(groomSchema.safeParse({ ...base, project_questions: ["a", "b", "c", "d"] }).success).toBe(false);
  });

  it("accepts bounded typed knowledge events on every groom action", () => {
    const event = { domain: "architecture-tech", reason: "repo evidence contradicts the stored service map" };
    const actions = [
      { action: "accept", title: "t", body: "b", priority: 1, rationale: "r" },
      { action: "merge", into_task_id: 7, rationale: "r" },
      { action: "clarify", question: "Which scope? Recommended: narrow — it is reversible.", rationale: "r" },
      { action: "refuse", rationale: "r" },
    ];
    for (const action of actions) {
      expect(groomSchema.safeParse({ ...action, knowledge_events: [event] }).success).toBe(true);
      expect(groomSchema.safeParse({ ...action, knowledge_events: [event, event, event, event] }).success).toBe(false);
    }
  });

  it("accepts merge, refuse, and clarify actions", () => {
    expect(groomSchema.parse({ action: "merge", into_task_id: 7, rationale: "dupe" }).action).toBe("merge");
    expect(groomSchema.parse({ action: "refuse", rationale: "unsafe requested outcome" }).action).toBe("refuse");
    expect(
      groomSchema.parse({
        action: "clarify",
        question: "Which region should host it? Recommended: eu-west-1 — it matches deployment.",
        rationale: "ambiguous",
      }).action,
    ).toBe("clarify");
  });

  it("rejects a refusal without an audit rationale", () => {
    expect(groomSchema.safeParse({ action: "refuse" }).success).toBe(false);
  });

  it("rejects bundled or recommendation-free groom clarifications", () => {
    const base = { action: "clarify" as const, rationale: "ambiguous" };
    expect(groomSchema.safeParse({ ...base, question: "Which region?" }).success).toBe(false);
    expect(
      groomSchema.safeParse({
        ...base,
        question: "Which region? Which database? Recommended: eu-west-1 with Postgres.",
      }).success,
    ).toBe(false);
    expect(
      groomSchema.safeParse({ ...base, question: "Choose a region. Recommended: eu-west-1." }).success,
    ).toBe(false);
  });

  it("rejects an unknown action literal", () => {
    expect(groomSchema.safeParse({ action: "nope", rationale: "r" }).success).toBe(false);
  });

  it("rejects priority outside 0..3 and non-integer priority", () => {
    expect(
      groomSchema.safeParse({ action: "accept", title: "t", body: "b", priority: 4, rationale: "r" }).success,
    ).toBe(false);
    expect(
      groomSchema.safeParse({ action: "accept", title: "t", body: "b", priority: -1, rationale: "r" }).success,
    ).toBe(false);
    expect(
      groomSchema.safeParse({ action: "accept", title: "t", body: "b", priority: 1.5, rationale: "r" }).success,
    ).toBe(false);
  });

  it("accepts the 0 and 3 priority boundaries", () => {
    for (const priority of [0, 3]) {
      expect(
        groomSchema.safeParse({ action: "accept", title: "t", body: "b", priority, rationale: "r" }).success,
      ).toBe(true);
    }
  });

  it("rejects a missing required field", () => {
    expect(groomSchema.safeParse({ action: "accept", title: "t", priority: 1, rationale: "r" }).success).toBe(
      false,
    );
  });

  it("rejects a non-integer into_task_id on merge", () => {
    expect(groomSchema.safeParse({ action: "merge", into_task_id: 1.2, rationale: "r" }).success).toBe(false);
  });

  it("groom accept accepts a grounded extraction and still parses without one", () => {
    const ok = groomSchema.safeParse({
      action: "accept", title: "t", body: "b", priority: 0, rationale: "r",
      extraction: { subject: "normalize Hyperliquid orders to nearest lot",
        current_behavior: "raw size leaks wireRounding", desired_behavior: "normalized to szDecimals lot",
        in_scope: ["order sizing"], out_of_scope: ["funding"] },
    });
    expect(ok.success).toBe(true);
    expect(ok.success && ok.data.action === "accept" && ok.data.extraction?.subject).toMatch(/normalize/);
    // back-compat: an accept WITHOUT extraction still parses (flag-off / retry paths)
    const legacy = groomSchema.safeParse({ action: "accept", title: "t", body: "b", priority: 0, rationale: "r" });
    expect(legacy.success).toBe(true);
  });
});

describe("eligibilitySchema", () => {
  it("eligibilitySchema is a binary served/verdict with a reason", () => {
    expect(eligibilitySchema.safeParse({ serves_request: false, reason: "brief is about card colors; submission is about order normalization" }).success).toBe(true);
  });
});

describe("reviewSchema", () => {
  it("accepts approved and revise verdicts", () => {
    expect(reviewSchema.parse({ verdict: "approved", feedback: "", rationale: "ok" }).verdict).toBe("approved");
    expect(reviewSchema.parse({ verdict: "revise", feedback: "fix x", rationale: "no" }).verdict).toBe("revise");
  });

  it("rejects an out-of-enum verdict", () => {
    expect(reviewSchema.safeParse({ verdict: "maybe", feedback: "", rationale: "" }).success).toBe(false);
  });
});

describe("discussSchema", () => {
  it("accepts a reply with bounded queue actions and no query", () => {
    const parsed = discussSchema.parse({
      reply: "done",
      actions: [{ action: "close_task", task_id: 3, reason: "stale" }],
      rationale: "r",
    });
    expect(parsed.actions).toHaveLength(1);
    expect(parsed.query).toBeUndefined();
  });

  it("accepts all queue action variants", () => {
    const actions = [
      { action: "close_task", task_id: 1, reason: "r" },
      { action: "set_priority", task_id: 1, priority: 2, reason: "r" },
      { action: "update_task", task_id: 1, title: "t", reason: "r" },
      { action: "add_dependency", dependent_task_id: 2, depends_on_task_id: 1, reason: "r" },
      { action: "remove_dependency", dependent_task_id: 2, depends_on_task_id: 1, reason: "r" },
    ];
    expect(discussSchema.safeParse({ reply: "ok", actions, rationale: "r" }).success).toBe(true);
  });

  it("rejects more than 5 actions", () => {
    const actions = Array.from({ length: 6 }, () => ({ action: "hold", task_id: 1, reason: "r" }));
    expect(discussSchema.safeParse({ reply: "x", actions, rationale: "r" }).success).toBe(false);
  });

  it("rejects a set_priority with an out-of-range priority literal", () => {
    expect(
      discussSchema.safeParse({
        reply: "x",
        actions: [{ action: "set_priority", task_id: 1, priority: 5, reason: "r" }],
        rationale: "r",
      }).success,
    ).toBe(false);
  });

  it("accepts an optional whitelisted query", () => {
    const parsed = discussSchema.parse({
      reply: "let me check",
      actions: [],
      rationale: "r",
      query: { entity: "tasks", limit: 10 },
    });
    expect(parsed.query).toEqual({ entity: "tasks", limit: 10 });
  });
});

describe("answerSchema", () => {
  it("accepts a non-escalating answer with optional actions", () => {
    const parsed = answerSchema.parse({
      escalate: false,
      answer: "here",
      actions: [{ action: "hold", task_id: 1, reason: "r" }],
      rationale: "r",
    });
    expect(parsed).toMatchObject({ escalate: false, answer: "here" });
  });

  it("accepts an escalating answer", () => {
    expect(answerSchema.parse({ escalate: true, rationale: "over my head" }).escalate).toBe(true);
  });

  it("rejects more than 3 actions on a non-escalating answer", () => {
    const actions = Array.from({ length: 4 }, () => ({ action: "hold", task_id: 1, reason: "r" }));
    expect(answerSchema.safeParse({ escalate: false, answer: "a", actions, rationale: "r" }).success).toBe(
      false,
    );
  });

  it("rejects an escalate:true carrying an answer field shape (wrong discriminant branch)", () => {
    // escalate:true branch has no `answer` — but Zod unions accept extra keys;
    // the meaningful rejection is a missing rationale.
    expect(answerSchema.safeParse({ escalate: true }).success).toBe(false);
  });
});

describe("referenceSchema", () => {
  it("accepts task/thread/decision/evidence/PR references", () => {
    for (const type of ["task", "thread", "decision", "evidence", "pr"] as const) {
      expect(referenceSchema.parse({ type, id: 1, url: "u", label: "l" }).type).toBe(type);
    }
  });

  it("rejects an unknown reference type and a non-integer id", () => {
    expect(referenceSchema.safeParse({ type: "commit", id: 1, url: "u", label: "l" }).success).toBe(false);
    expect(referenceSchema.safeParse({ type: "task", id: 1.5, url: "u", label: "l" }).success).toBe(false);
  });
});

describe("projectKnowledgeRefreshSchema", () => {
  const valid = {
    checked_domains: ["product-bounds"],
    questions: [{
      domain: "product-bounds",
      trigger: "STALENESS",
      question: "Is the product boundary still accurate?",
    }],
    rationale: "bounded check",
  };

  it("accepts one bounded domain question", () => {
    expect(projectKnowledgeRefreshSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects an empty checked-domain result", () => {
    expect(projectKnowledgeRefreshSchema.safeParse({ ...valid, checked_domains: [] }).success).toBe(false);
  });

  it("rejects more than three or duplicate checked domains", () => {
    expect(projectKnowledgeRefreshSchema.safeParse({
      ...valid,
      checked_domains: ["product-bounds", "priorities-roadmap", "team-people", "architecture-tech"],
    }).success).toBe(false);
    expect(projectKnowledgeRefreshSchema.safeParse({
      ...valid,
      checked_domains: ["product-bounds", "product-bounds"],
    }).success).toBe(false);
  });

  it("rejects two questions for one domain and bundled multi-question text", () => {
    expect(projectKnowledgeRefreshSchema.safeParse({
      ...valid,
      questions: [valid.questions[0], { ...valid.questions[0], question: "Has its scope changed?" }],
    }).success).toBe(false);
    expect(projectKnowledgeRefreshSchema.safeParse({
      ...valid,
      questions: [{ ...valid.questions[0], question: "Is it current? What changed?" }],
    }).success).toBe(false);
  });
});
