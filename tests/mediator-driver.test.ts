// Dedicated suite for the driver contract's shared grounding + sidecar helpers
// (#81 backfill). Every driver reply flows through the same Anthropic-Citations
// post-validation seam: blankUncitedIds scrubs invented ids, mintReferences
// derives server-minted links only for grounded ids, and refUrl builds the
// deep link. takeMeta is the optional per-completion sidecar (reasoning/model/
// usage) — surfaced once, then cleared. These are the branches an LLM's output
// actually stresses, so they get direct coverage independent of the pipelines.
import { describe, expect, it } from "vitest";
import { blankUncitedIds, mintReferences, refUrl, sanitizeReferenceTokens, type CitableRefs } from "../src/mediator/pipelines.js";
import { personOwnedFromClarify, type CompletionMeta, type MediatorDriver } from "../src/mediator/driver.js";

describe("blankUncitedIds", () => {
  it("keeps grounded ids and blanks invented ones", () => {
    const allowed = new Set([7, 42, 88]);
    const out = blankUncitedIds("Fixed in #7 (DEC-42). Also DEC-999, task 88, and #500.", allowed);
    expect(out).toContain("#7");
    expect(out).toContain("DEC-42");
    expect(out).toContain("88");
    expect(out).not.toContain("999");
    expect(out).not.toContain("500");
  });

  it("blanks every id when nothing is grounded", () => {
    const out = blankUncitedIds("see #1 and DEC-2", new Set<number>());
    expect(out).not.toMatch(/#1\b/);
    expect(out).not.toContain("DEC-2");
  });

  it("passes prose with no cited ids through untouched", () => {
    const text = "no records support this in the window";
    expect(blankUncitedIds(text, new Set([1, 2]))).toBe(text);
  });

  it("does not reinterpret a PR number as a task id", () => {
    expect(blankUncitedIds("Shipped in PR #19; task #99 is invented.", new Set())).toBe(
      "Shipped in PR #19; task #? is invented.",
    );
  });
});

describe("refUrl", () => {
  it("builds a dashboard deep link per entity type", () => {
    expect(refUrl("https://x.test", "task", 5)).toBe("https://x.test/dashboard?task=5");
    expect(refUrl("https://x.test", "decision", 9)).toBe("https://x.test/dashboard?decision=9");
    expect(refUrl("https://x.test", "thread", 3)).toBe("https://x.test/dashboard?thread=3");
  });

  it("normalizes a trailing slash on the base", () => {
    expect(refUrl("https://x.test/", "task", 5)).toBe("https://x.test/dashboard?task=5");
    expect(refUrl("https://x.test///", "task", 5)).toBe("https://x.test/dashboard?task=5");
  });
});

describe("mintReferences", () => {
  const refs: CitableRefs = { tasks: new Set([7, 88]), decisions: new Set([42]) };

  it("mints references only for grounded ids and drops fabricated ones", () => {
    const out = mintReferences("https://x.test", "Fixed #7 per DEC-42; ignore #999 and DEC-1.", refs);
    expect(out).toEqual([
      { type: "task", id: 7, url: "https://x.test/dashboard?task=7", label: "task #7" },
      { type: "decision", id: 42, url: "https://x.test/dashboard?decision=42", label: "DEC-42" },
    ]);
  });

  it("preserves first-mention order across entity types", () => {
    const out = mintReferences("https://x.test", "DEC-42 then #7 then #88", refs);
    expect(out.map((r) => `${r.type}:${r.id}`)).toEqual(["decision:42", "task:7", "task:88"]);
  });

  it("dedupes repeated citations per entity", () => {
    const out = mintReferences("https://x.test", "#7 #7 task:7 DEC-42 DEC-42", refs);
    expect(out).toHaveLength(2);
  });

  it("recognizes the task:<id> citation token as a task reference", () => {
    const out = mintReferences("https://x.test", "see task:88", refs);
    expect(out).toEqual([
      { type: "task", id: 88, url: "https://x.test/dashboard?task=88", label: "task #88" },
    ]);
  });

  it("mints a plan citation through the task reference type with a plan anchor", () => {
    const out = mintReferences("https://x.test", "The retry shape came from PLAN-88.", {
      ...refs,
      projectId: "project a",
      plans: new Set([88]),
    });
    expect(out).toEqual([
      {
        type: "task",
        id: 88,
        url: "https://x.test/dashboard?project=project+a&task=88#plan",
        label: "plan for task #88",
      },
    ]);
    expect(mintReferences("https://x.test", "Invented PLAN-999.", { ...refs, plans: new Set([88]) })).toEqual([]);
  });

  it("returns no references when the base is unset (never throws)", () => {
    expect(mintReferences(undefined, "#7 DEC-42", refs)).toEqual([]);
  });

  it("mints grounded evidence and PR tokens without treating PR #n as task #n", () => {
    const out = mintReferences("https://x.test", "EVID-5 proves it; shipped in PR #7; task #7 tracks rollout.", {
      ...refs,
      evidence: new Map([[5, 88]]),
      prs: new Map([[7, "https://github.com/acme/repo/pull/7"]]),
    });
    expect(out).toEqual([
      { type: "evidence", id: 5, url: "https://x.test/dashboard?task=88#evidence-5", label: "EVID-5" },
      { type: "pr", id: 7, url: "https://github.com/acme/repo/pull/7", label: "PR #7" },
      { type: "task", id: 7, url: "https://x.test/dashboard?task=7", label: "task #7" },
    ]);
  });

  it("keeps colliding task and decision ids on their own owners", () => {
    const out = mintReferences("https://x.test", "#7 and DEC-7", {
      tasks: new Set([7]), decisions: new Set([7]), decisionOwners: new Map([[7, 88]]),
    });
    expect(out.map((reference) => reference.url)).toEqual([
      "https://x.test/dashboard?task=7",
      "https://x.test/dashboard?task=88#decision-7",
    ]);
  });
});

describe("sanitizeReferenceTokens", () => {
  const refs: CitableRefs = {
    projectId: "project a",
    tasks: new Set([7]),
    decisions: new Set([7]),
    decisionOwners: new Map([[7, 9]]),
    evidence: new Map([[5, 7]]),
    prs: new Map([[19, "https://github.com/acme/repo/pull/19"]]),
    plans: new Set([7]),
  };

  it("preserves grounded typed tokens and blanks fabricated ids by type", () => {
    expect(sanitizeReferenceTokens(
      "EVID-5 EVID-7 PR #19 PR #7 DEC-7 DEC-5 PLAN-7 PLAN-5 task #7 task #5",
      refs,
    )).toBe("EVID-5 EVID-? PR #19 PR #? DEC-7 DEC-? PLAN-7 PLAN-? task #7 task #?");
  });

  it("does not ground one entity type through a numeric collision", () => {
    expect(sanitizeReferenceTokens("EVID-7 PR #7 DEC-7 #7", refs)).toBe("EVID-? PR #? DEC-7 #7");
  });
});

describe("takeMeta sidecar contract", () => {
  // A minimal driver honoring only the takeMeta seam: surfaces the captured
  // metadata once, then clears — the pipeline records it on the thread and
  // never feeds it back.
  class MetaDriver implements Pick<MediatorDriver, "takeMeta"> {
    private pending: CompletionMeta | undefined;
    capture(meta: CompletionMeta) {
      this.pending = meta;
    }
    takeMeta(): CompletionMeta | undefined {
      const m = this.pending;
      this.pending = undefined;
      return m;
    }
  }

  it("surfaces the captured reasoning/model/usage exactly once", () => {
    const d = new MetaDriver();
    d.capture({ model: "m", reasoning: "weighed it", usage: { promptTokens: 5, completionTokens: 3 } });
    expect(d.takeMeta()).toEqual({
      model: "m",
      reasoning: "weighed it",
      usage: { promptTokens: 5, completionTokens: 3 },
    });
    // consumed on read
    expect(d.takeMeta()).toBeUndefined();
  });

  it("degrades to no sidecar when the driver captured nothing", () => {
    expect(new MetaDriver().takeMeta()).toBeUndefined();
  });

  it("a driver may omit takeMeta entirely (optional member)", () => {
    const driver: Pick<MediatorDriver, "takeMeta"> = {};
    // The capture layer calls it with optional chaining and degrades to no meta.
    expect(driver.takeMeta?.()).toBeUndefined();
  });
});

describe("personOwnedFromClarify", () => {
  const withRecommended =
    "Which region? Recommended: eu-west-1 — it matches the current deployment.";

  it("honors an explicit person_owned true even when Recommended: is present", () => {
    expect(personOwnedFromClarify({ question: withRecommended, person_owned: true })).toBe(true);
  });

  it("honors an explicit person_owned false", () => {
    expect(personOwnedFromClarify({ question: "No recommended line?", person_owned: false })).toBe(false);
  });

  it("defaults false when field is absent and Recommended: is present (legacy drivers)", () => {
    expect(personOwnedFromClarify({ question: withRecommended })).toBe(false);
  });

  it("defaults true when field is absent and Recommended: is missing", () => {
    expect(personOwnedFromClarify({ question: "Which venue do you want?" })).toBe(true);
  });
});
