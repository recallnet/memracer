// tests/groom-eligibility.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { Queue } from "../src/queue.js";
import { MediatorWorker } from "../src/mediator/worker.js";
import { registerPipelines } from "../src/mediator/pipelines.js";
import { FakeDriver } from "../src/mediator/fake.js";
import type { GroomResult } from "../src/mediator/driver.js";
import type { Db } from "../src/db.js";
import { openTestDb } from "./helpers/db.js";

// Scripted driver: control both the groom accept `result` and the fresh-context
// eligibility verdict independently, so a test can drive drift vs. fidelity.
class ScriptedGroomDriver extends FakeDriver {
  constructor(
    private readonly scriptedResult: GroomResult,
    private readonly verdict: { serves_request: boolean; reason: string },
  ) {
    super();
  }
  override async groom(): Promise<GroomResult> {
    return this.scriptedResult;
  }
  override async eligibility(): Promise<{ serves_request: boolean; reason: string }> {
    return this.verdict;
  }
}

async function harnessWithGroom(input: {
  submission: { title: string; body: string };
  groomResult: GroomResult;
  eligibility: { serves_request: boolean; reason: string };
}): Promise<{ db: Db; queue: Queue; worker: MediatorWorker; taskId: number }> {
  const db = await openTestDb();
  await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
  const queue = new Queue(db);
  const worker = new MediatorWorker(db, { tickMs: 20, jobTimeoutMs: 2000 });
  const driver = new ScriptedGroomDriver(input.groomResult, input.eligibility);
  registerPipelines({ db, queue, worker, driverFor: () => driver });
  worker.start();
  active = worker;
  const taskId = await queue.submit("p", "dana", {
    title: input.submission.title,
    body: input.submission.body,
    evidence: [],
  });
  await worker.waitForJob(await worker.enqueue("p", "groom", { taskId, submittedBy: "dana" }), 3000);
  return { db, queue, worker, taskId };
}

async function lastMediatorClarification(db: Db, taskId: number): Promise<string> {
  const row = await db
    .prepare("SELECT question FROM questions WHERE task_id=? AND asked_by='mediator' ORDER BY id DESC LIMIT 1")
    .get<{ question: string }>(taskId);
  return row?.question ?? "";
}

let active: MediatorWorker | undefined;
afterEach(async () => {
  delete process.env.MEMRACER_GROOM_FIDELITY_ENABLED;
  const worker = active;
  active = undefined;
  if (worker) await worker.stopAndWait(2_000);
});

describe("groom eligibility gate", () => {
  it("blocks a drifted brief as needs-you instead of queueing it", async () => {
    process.env.MEMRACER_GROOM_FIDELITY_ENABLED = "1";
    const { db, queue, taskId } = await harnessWithGroom({
      submission: { title: "normalize Hyperliquid orders", body: "round order size to the nearest valid lot" },
      groomResult: {
        action: "accept",
        title: "Add color customization",
        body: "ColorPicker per card",
        priority: 2,
        rationale: "r",
        extraction: {
          subject: "card colors",
          current_behavior: "",
          desired_behavior: "",
          in_scope: [],
          out_of_scope: [],
        },
      },
      eligibility: { serves_request: false, reason: "different subject" },
    });
    const t = await queue.brief(taskId);
    expect(t.state).not.toBe("QUEUED");
    expect(await lastMediatorClarification(db, taskId)).toMatch(/could not faithfully|different subject|serves/i);
  });

  it("holds an accept that is missing its grounded extraction", async () => {
    process.env.MEMRACER_GROOM_FIDELITY_ENABLED = "1";
    const { db, queue, taskId } = await harnessWithGroom({
      submission: { title: "normalize orders", body: "nearest lot" },
      groomResult: {
        action: "accept",
        title: "Normalize orders to nearest lot",
        body: "round to szDecimals lot",
        priority: 0,
        rationale: "r",
      },
      eligibility: { serves_request: true, reason: "same subject" },
    });
    const t = await queue.brief(taskId);
    expect(t.state).not.toBe("QUEUED");
    expect(await lastMediatorClarification(db, taskId)).toMatch(/extraction|restate/i);
  });

  it("queues a faithful brief normally", async () => {
    process.env.MEMRACER_GROOM_FIDELITY_ENABLED = "1";
    const { queue, taskId } = await harnessWithGroom({
      submission: { title: "normalize orders", body: "nearest lot" },
      groomResult: {
        action: "accept",
        title: "Normalize orders to nearest lot",
        body: "round to szDecimals lot",
        priority: 0,
        rationale: "r",
        extraction: {
          subject: "order normalization",
          current_behavior: "",
          desired_behavior: "",
          in_scope: [],
          out_of_scope: [],
        },
      },
      eligibility: { serves_request: true, reason: "same subject" },
    });
    expect((await queue.brief(taskId)).state).toBe("QUEUED");
  });
});
