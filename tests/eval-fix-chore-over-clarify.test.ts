import { describe, expect, it } from "vitest";
import { FakeDriver } from "../src/mediator/fake.js";
import type { MediatorContext, Submission } from "../src/mediator/driver.js";
import { isFixOrChore } from "../src/mediator/pipelines.js";
import {
  fixChoreOverClarifyFixtures,
  groomWithFixChorePreclass,
  isInvisibleSliceReshapeClarify,
  runFixChoreBaselineTreatment,
  runFixChoreArm,
} from "../src/eval/fix-chore-over-clarify.js";

class AlwaysReshapeDriver extends FakeDriver {
  override async groom(_ctx: MediatorContext, _s: Submission) {
    return {
      action: "clarify" as const,
      question:
        "What visible, usable delivery should complete this backend-only feature slice? Recommended: reshape it as a working vertical whose acceptance names how a human observes or uses the result.",
      rationale:
        "invisible/backend-only feature slice; DONE requires observable, usable value — reshape into a working vertical",
    };
  }
}

describe("fix-chore-over-clarify eval", () => {
  it("pre-classifies every fix_chore fixture and leaves invisible_feature to the model", async () => {
    for (const fixture of fixChoreOverClarifyFixtures) {
      if (fixture.label === "fix_chore") {
        expect(isFixOrChore(fixture.title, fixture.body), fixture.name).toBe(true);
        const result = await groomWithFixChorePreclass(new AlwaysReshapeDriver(), fixture);
        expect(result.action, fixture.name).toBe("accept");
        expect(isInvisibleSliceReshapeClarify(result), fixture.name).toBe(false);
      } else {
        expect(isFixOrChore(fixture.title, fixture.body), fixture.name).toBe(false);
        const result = await groomWithFixChorePreclass(new AlwaysReshapeDriver(), fixture);
        expect(isInvisibleSliceReshapeClarify(result), fixture.name).toBe(true);
      }
    }
  });

  it("baseline-vs-treatment reports treatment gate pass (0 fix/chore reshape)", async () => {
    // Treatment driver is also AlwaysReshape: pre-class short-circuits fix/chore,
    // and invisible_feature still reaches the reshape path (precision).
    const ab = await runFixChoreBaselineTreatment({
      baselineDriver: () => new AlwaysReshapeDriver(),
      treatmentDriver: () => new AlwaysReshapeDriver(),
      samples: 1,
    });
    expect(ab.baseline.fixChoreReshape).toBe(ab.baseline.fixChoreTotal);
    expect(ab.treatment.fixChoreReshape).toBe(0);
    expect(ab.treatment.featureReshape).toBeGreaterThan(0);
    expect(ab.treatmentGatePass).toBe(true);
    expect(ab.summary).toMatch(/treatment gate: PASS/);
  });

  it("treatment arm alone is green under pre-class", async () => {
    const arm = await runFixChoreArm("treatment", () => new AlwaysReshapeDriver(), { samples: 1 });
    expect(arm.fixChoreReshape).toBe(0);
    expect(arm.gatePass).toBe(true);
  });
});
