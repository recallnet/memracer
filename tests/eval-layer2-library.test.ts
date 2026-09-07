import { describe, expect, it } from "vitest";
import { FakeDriver } from "../src/mediator/fake.js";
import {
  classifyGroomFidelity,
  groomFidelityFixtures,
  runGroomFidelityBaselineTreatment,
  runGroomFidelityEval,
} from "../src/eval/groom-fidelity.js";
import {
  ConfabulatingKnowledgeDriver,
  classifyOkfCuration,
  okfCurationFixtures,
  runOkfCurationBaselineTreatment,
  runOkfCurationEval,
} from "../src/eval/okf-curation-faithfulness.js";
import {
  AnchorAwareAnswerDriver,
  NeverEscalateDriver,
  classifyClarifyAnswer,
  clarifyAnswerFixtures,
  runClarifyAnswerBaselineTreatment,
  runClarifyAnswerEval,
} from "../src/eval/clarify-answer-quality.js";
import {
  DriftBlindEligibilityDriver,
  runLayer2Library,
  runLayer2TreatmentSmoke,
} from "../src/eval/layer2-library.js";

describe("groom-fidelity eval", () => {
  it("has drift and faithful fixtures including the colors class", () => {
    const drift = groomFidelityFixtures.filter((f) => f.label === "drift");
    const faithful = groomFidelityFixtures.filter((f) => f.label === "faithful");
    expect(drift.length).toBeGreaterThanOrEqual(3);
    expect(faithful.length).toBeGreaterThanOrEqual(2);
    expect(drift.some((f) => f.name === "colors-vs-orders")).toBe(true);
  });

  it("FakeDriver treatment catches semantic goal-drift without cheat markers", async () => {
    expect(groomFidelityFixtures.every((f) => !/\bDRIFT\b/.test(f.brief))).toBe(true);
    const card = await runGroomFidelityEval(() => new FakeDriver());
    expect(card.passRate).toBe(1);
    expect(card.driftRecall).toBe(1);
    expect(card.faithfulPrecision).toBe(1);
  });

  it("baseline vs treatment shows drift-recall lift", async () => {
    const ab = await runGroomFidelityBaselineTreatment({
      baselineDriver: () => new DriftBlindEligibilityDriver(),
      treatmentDriver: () => new FakeDriver(),
    });
    expect(ab.baseline.driftRecall).toBe(0);
    expect(ab.treatment.driftRecall).toBe(1);
    expect(ab.summary).toContain("groom-fidelity");
  });

  it("classifier grades serves_request against fixture expectation", () => {
    const fixture = groomFidelityFixtures.find((f) => f.name === "colors-vs-orders")!;
    expect(
      classifyGroomFidelity(fixture, { serves_request: false, reason: "drift" }).pass,
    ).toBe(true);
    expect(
      classifyGroomFidelity(fixture, { serves_request: true, reason: "miss" }).pass,
    ).toBe(false);
  });
});

describe("okf-curation-faithfulness eval", () => {
  it("FakeDriver does not confabulate domains or invent questions", async () => {
    const card = await runOkfCurationEval(() => new FakeDriver());
    expect(card.passRate).toBe(1);
    expect(card.confabFreeRate).toBe(1);
  });

  it("confabulating baseline fails cleanliness", async () => {
    const card = await runOkfCurationEval(() => new ConfabulatingKnowledgeDriver());
    expect(card.confabFreeRate).toBe(0);
  });

  it("baseline vs treatment lifts confab-free rate", async () => {
    const ab = await runOkfCurationBaselineTreatment({
      baselineDriver: () => new ConfabulatingKnowledgeDriver(),
      treatmentDriver: () => new FakeDriver(),
    });
    expect(ab.baseline.confabFreeRate).toBe(0);
    expect(ab.treatment.confabFreeRate).toBe(1);
    expect(ab.summary).toContain("okf-curation");
  });

  it("classifier rejects unknown checked domains", () => {
    const fixture = okfCurationFixtures.find((f) => f.name === "must-not-claim-unknown-domain")!;
    const graded = classifyOkfCuration(fixture, {
      checked_domains: ["architecture-tech", "preferences-felt-experience"],
      questions: [],
      rationale: "x",
    });
    expect(graded.noConfab).toBe(false);
  });
});

describe("clarify-answer-quality eval", () => {
  it("has escalate and agent-answer fixtures", () => {
    expect(clarifyAnswerFixtures.some((f) => f.label === "escalate")).toBe(true);
    expect(clarifyAnswerFixtures.some((f) => f.label === "agent-answer")).toBe(true);
  });

  it("AnchorAware treatment escalates human-owned questions and cites anchors", async () => {
    const card = await runClarifyAnswerEval(() => new AnchorAwareAnswerDriver());
    expect(card.passRate).toBe(1);
    expect(card.escalateAccuracy).toBe(1);
    expect(card.groundedDefinition).toMatch(/requiredAnchors/);
  });

  it("never-escalate baseline under-escalates", async () => {
    const card = await runClarifyAnswerEval(() => new NeverEscalateDriver());
    expect(card.escalateAccuracy).toBeLessThan(1);
  });

  it("baseline vs treatment lifts escalate accuracy", async () => {
    const ab = await runClarifyAnswerBaselineTreatment({
      baselineDriver: () => new NeverEscalateDriver(),
      treatmentDriver: () => new AnchorAwareAnswerDriver(),
    });
    expect(ab.treatment.escalateAccuracy).toBe(1);
    expect(ab.baseline.escalateAccuracy).toBeLessThan(ab.treatment.escalateAccuracy);
    expect(ab.summary).toContain("clarify-answer");
    expect(ab.summary).toContain("requiredAnchors");
  });

  it("classifier requires escalate match and anchors for agent-answer", () => {
    const fixture = clarifyAnswerFixtures.find((f) => f.name === "budget-approval")!;
    expect(
      classifyClarifyAnswer(fixture, {
        escalate: true,
        rationale: "needs human",
      }).pass,
    ).toBe(true);
    expect(
      classifyClarifyAnswer(fixture, {
        escalate: false,
        answer: "no",
        rationale: "wrong",
      }).pass,
    ).toBe(false);
    const factual = clarifyAnswerFixtures.find((f) => f.name === "factual-queue")!;
    expect(
      classifyClarifyAnswer(factual, {
        escalate: false,
        answer: "awaiting_merge holds the lease until the pr merges",
        rationale: "from lifecycle",
      }).pass,
    ).toBe(true);
    expect(
      classifyClarifyAnswer(factual, {
        escalate: false,
        answer: "it means something",
        rationale: "non-empty is not grounded",
      }).pass,
    ).toBe(false);
  });
});

describe("layer2 library", () => {
  it("treatment smoke is fully green", async () => {
    const smoke = await runLayer2TreatmentSmoke();
    expect(smoke.ok).toBe(true);
  });

  it("runs all three dimensions with baselines", async () => {
    const lib = await runLayer2Library();
    expect(lib.groomFidelity.treatment.passRate).toBe(1);
    expect(lib.okfCuration.treatment.passRate).toBe(1);
    expect(lib.clarifyAnswer.treatment.passRate).toBe(1);
    expect(lib.summary).toContain("Layer 2");
  });
});
