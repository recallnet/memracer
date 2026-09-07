import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  EFFECT_WORKER_SCORECARD,
  measureTypeScriptSource,
} from "../src/eval/effect-worker-scorecard.js";

describe("Effect worker adoption scorecard", () => {
  it("keeps the committed candidate source measurements reproducible", async () => {
    const [worker, openRouter] = await Promise.all([
      readFile("src/mediator/worker.ts", "utf8"),
      readFile("src/mediator/openrouter.ts", "utf8"),
    ]);

    expect(measureTypeScriptSource(worker, "worker.ts"))
      .toEqual(EFFECT_WORKER_SCORECARD.candidate.source.worker);
    expect(measureTypeScriptSource(openRouter, "openrouter.ts"))
      .toEqual(EFFECT_WORKER_SCORECARD.candidate.source.openRouter);
  });

  it("stops the migration before queue.ts", () => {
    expect(EFFECT_WORKER_SCORECARD.interpretation.recommendation).toBe("stop");
    expect(EFFECT_WORKER_SCORECARD.interpretation.queueTsNext).toBe(false);
  });
});
