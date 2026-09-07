// tests/mediator-pipelines.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db.js";
import { Queue, DEFAULT_LEASE_TTL_MS, unsatisfiedDeps } from "../src/queue.js";
import { MediatorWorker } from "../src/mediator/worker.js";
import { registerPipelines, blankUncitedIds, markPolicyQuality } from "../src/mediator/pipelines.js";
import { FakeDriver } from "../src/mediator/fake.js";
import { MemoryStore } from "../src/mediator/memory.js";
import type { MediatorContext, MediatorDriver, Submission } from "../src/mediator/driver.js";
import { openTestDb } from "./helpers/db.js";
import { ProjectKnowledgeState } from "../src/mediator/project-knowledge.js";

async function setup(driver: MediatorDriver = new FakeDriver()) {
  const db = await openTestDb();
  await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
  const queue = new Queue(db);
  const worker = new MediatorWorker(db, { tickMs: 20, jobTimeoutMs: 2000 });
  registerPipelines({ db, queue, worker, driverFor: () => driver });
  worker.start();
  return { db, queue, worker };
}

let active: MediatorWorker | undefined;
afterEach(async () => {
  const worker = active;
  active = undefined;
  if (!worker) return;
  await worker.stopAndWait(2_000);
});

describe("mediator pipelines", () => {
  it("periodically repairs eligible dependency-backed HELD tasks without reopening intentional holds", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
    const queue = new Queue(db);
    const worker = new MediatorWorker(db, { tickMs: 20, jobTimeoutMs: 2_000 });
    registerPipelines({ db, queue, worker, driverFor: () => new FakeDriver() });
    const predecessor = await queue.submit("p", "dana", { title: "done", body: "b", evidence: [] });
    const recoverable = await queue.submit("p", "dana", { title: "recoverable", body: "b", evidence: [] });
    const intentional = await queue.submit("p", "dana", { title: "intentional", body: "b", evidence: [] });
    await queue.addDependency("p", recoverable, predecessor);
    await queue.addDependency("p", intentional, predecessor);
    await db.prepare("UPDATE tasks SET state='DONE' WHERE id=?").run(predecessor);
    await db.prepare("UPDATE tasks SET state='HELD' WHERE id=?").run(recoverable);
    await db.prepare("UPDATE tasks SET state='HELD', hold_cause='explicit' WHERE id=?").run(intentional);

    worker.start();
    active = worker;
    await vi.waitFor(async () => expect((await queue.brief(recoverable)).state).toBe("QUEUED"));
    expect((await queue.brief(intentional)).state).toBe("HELD");
  });

  it("does not fail completed semantic work when optional quality telemetry fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = {
      prepare() {
        throw new Error("telemetry unavailable");
      },
    } as unknown as Db;

    await expect(markPolicyQuality(db, 42, "rejected", 100)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("job-policy-quality-failure"));
    error.mockRestore();
  });

  it("completes a no-write refresh as a checked-only no-op", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
    const queue = new Queue(db);
    const worker = new MediatorWorker(db, { tickMs: 20, jobTimeoutMs: 2_000 });
    class NoWriteDriver extends FakeDriver {
      override async refreshProjectKnowledge(_ctx: MediatorContext, input: Parameters<FakeDriver["refreshProjectKnowledge"]>[1]) {
        return { checked_domains: [input.candidates[0].domain], questions: [], rationale: "nothing durable changed" };
      }
    }
    registerPipelines({ db, queue, worker, driverFor: () => new NoWriteDriver() });
    worker.start(); active = worker;
    const job = await worker.waitForJob(
      await worker.enqueue("p", "refresh", { mode: "refresh" }),
      3_000,
    );
    expect(job.status).toBe("done");
    expect(JSON.parse(job.result!)).toMatchObject({ action: "checked", refreshed_domains: [] });
    expect(await db.prepare(
      `SELECT COUNT(*) AS checked,
              SUM(CASE WHEN last_refreshed_at IS NOT NULL THEN 1 ELSE 0 END) AS refreshed
         FROM project_context_domains WHERE last_checked_at IS NOT NULL`,
    ).get()).toEqual({ checked: 1, refreshed: 0 });
  });

  it("clips checked non-candidates and records a soft diagnostic", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
    const queue = new Queue(db);
    const worker = new MediatorWorker(db, { tickMs: 20, jobTimeoutMs: 2_000 });
    const state = new ProjectKnowledgeState(db);
    await state.ensure("p");
    await db.prepare(
      "UPDATE project_context_domains SET last_checked_at=?, last_refreshed_at=? WHERE project_id='p'",
    ).run(Date.now(), Date.now());
    await state.markEvent("p", ["architecture-tech"], "architecture changed");
    class ExtraDomainDriver extends FakeDriver {
      override async refreshProjectKnowledge() {
        return {
          checked_domains: ["architecture-tech", "product-bounds"] as const,
          questions: [],
          rationale: "also inspected an unrelated domain",
        };
      }
    }
    registerPipelines({ db, queue, worker, driverFor: () => new ExtraDomainDriver() });
    worker.start(); active = worker;
    const job = await worker.waitForJob(
      await worker.enqueue("p", "refresh", { mode: "refresh" }),
      3_000,
    );
    expect(job.status).toBe("done");
    expect(JSON.parse(job.result!)).toMatchObject({
      action: "checked",
      checked_domains: ["architecture-tech"],
      diagnostics: ["ignored non-candidate checked domain product-bounds"],
    });
  });

  it("soft-completes a no-write answer and marks its audit row curated", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
    const queue = new Queue(db);
    const worker = new MediatorWorker(db, { tickMs: 20, jobTimeoutMs: 2_000 });
    class NoWriteAnswerDriver extends FakeDriver {
      override async refreshProjectKnowledge(_ctx: MediatorContext, input: Parameters<FakeDriver["refreshProjectKnowledge"]>[1]) {
        return { checked_domains: [input.answer!.domain!], questions: [], rationale: "answer adds nothing durable" };
      }
    }
    registerPipelines({ db, queue, worker, driverFor: () => new NoWriteAnswerDriver() });
    const [questionId] = await queue.addQuestions("p", null, "mediator", {
      question: "Did the product boundary change?",
      domain: "product-bounds",
      trigger: "TIME",
    });
    await queue.answerQuestion(questionId, "No change.", "dana");
    worker.start(); active = worker;
    const job = await worker.waitForJob(
      await worker.enqueue("p", "refresh", {
        mode: "answer",
        answer: {
          question_id: questionId,
          question: "Did the product boundary change?",
          answer: "No change.",
          domain: "product-bounds",
        },
      }),
      3_000,
    );
    expect(job.status).toBe("done");
    expect(JSON.parse(job.result!)).toMatchObject({
      action: "checked",
      diagnostics: ["answer cycle did not write a concept tagged domain:product-bounds"],
    });
    expect(await db.prepare(
      "SELECT curated_at IS NOT NULL AS curated FROM questions WHERE id=?",
    ).get(questionId)).toEqual({ curated: db.dialect === "postgres" ? true : 1 });
    expect(await db.prepare(
      `SELECT last_checked_at IS NOT NULL AS checked, last_refreshed_at
         FROM project_context_domains WHERE project_id='p' AND domain='product-bounds'`,
    ).get()).toEqual({ checked: db.dialect === "postgres" ? true : 1, last_refreshed_at: null });
  });

  it("rejects an empty custom-driver refresh before questions or cooldown state mutate", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
    const queue = new Queue(db);
    const worker = new MediatorWorker(db, { tickMs: 20, jobTimeoutMs: 2_000 });
    class EmptyCheckedDriver extends FakeDriver {
      override async refreshProjectKnowledge() {
        return { checked_domains: [], questions: [], rationale: "nothing" };
      }
    }
    registerPipelines({ db, queue, worker, driverFor: () => new EmptyCheckedDriver() });
    worker.start(); active = worker;
    const job = await worker.waitForJob(
      await worker.enqueue("p", "refresh", { mode: "refresh" }),
      3_000,
    );
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/invalid project knowledge refresh result/i);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM questions").get()).toEqual({ n: 0 });
    expect(await db.prepare(
      "SELECT COUNT(*) AS n FROM project_context_domains WHERE last_checked_at IS NOT NULL",
    ).get()).toEqual({ n: 0 });
  });

  it("forces an answered domain through after an older refresh consumed its generation", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
    const queue = new Queue(db);
    const worker = new MediatorWorker(db, { tickMs: 20, jobTimeoutMs: 2_000, concurrency: 1 });
    class AnswerRaceDriver extends FakeDriver {
      answerCalls = 0;
      override async refreshProjectKnowledge(ctx: MediatorContext, input: Parameters<FakeDriver["refreshProjectKnowledge"]>[1]) {
        if (input.answer) {
          this.answerCalls += 1;
          await ctx.tools?.dispatch("okf_grep", { query: input.answer.domain });
          await ctx.tools?.dispatch("okf_write", {
            path: `context/${input.answer.domain}.md`,
            type: "Project context",
            title: input.answer.domain,
            description: "Answered project context",
            tags: [`domain:${input.answer.domain}`],
            body: `# Context\n\n${input.answer.answer}`,
          });
          return { checked_domains: [input.answer.domain], questions: [], rationale: "curated answer" };
        }
        return {
          checked_domains: [input.candidates[0].domain],
          questions: [],
          rationale: "older refresh consumed the event",
        };
      }
    }
    const driver = new AnswerRaceDriver();
    registerPipelines({ db, queue, worker, driverFor: () => driver });
    const [questionId] = await queue.addQuestions("p", null, "mediator", {
      question: "Is the product boundary still accurate?",
      domain: "product-bounds",
      trigger: "TIME",
    });
    const answered = await queue.answerQuestion(questionId, "Yes, with one new non-goal.", "dana");
    let genericId = 0;
    let answerId = 0;
    await db.transaction(async () => {
      genericId = await worker.enqueue("p", "refresh", { mode: "refresh" });
      answerId = await worker.enqueue("p", "refresh", {
        mode: "answer",
        event_generations: answered.event_generations,
        answer: {
          question_id: questionId,
          question: "Is the product boundary still accurate?",
          answer: "Yes, with one new non-goal.",
          domain: "product-bounds",
        },
      });
    });
    worker.start(); active = worker;
    expect((await worker.waitForJob(genericId, 3_000)).status).toBe("done");
    expect((await worker.waitForJob(answerId, 3_000)).status).toBe("done");
    expect(driver.answerCalls).toBe(1);
    expect((await new MemoryStore(db).get("p", "context/product-bounds.md"))?.body)
      .toContain("Yes, with one new non-goal.");
    expect(await db.prepare(
      `SELECT requested_generation, applied_generation, last_refreshed_at
         FROM project_context_domains WHERE project_id='p' AND domain='product-bounds'`,
    ).get()).toEqual({
      requested_generation: 1,
      applied_generation: 1,
      last_refreshed_at: expect.any(Number),
    });
  });

  it("recovers an uncurated answer from the audit row after its answer job exhausts retries", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
    const queue = new Queue(db);
    const worker = new MediatorWorker(db, { tickMs: 20, jobTimeoutMs: 2_000, concurrency: 2 });
    class RecoveryDriver extends FakeDriver {
      answerAttempts = 0;
      override async refreshProjectKnowledge(ctx: MediatorContext, input: Parameters<FakeDriver["refreshProjectKnowledge"]>[1]) {
        if (!input.answer) return super.refreshProjectKnowledge(ctx, input);
        this.answerAttempts += 1;
        if (this.answerAttempts <= 2) throw new Error("simulated curation outage");
        const domain = input.answer.domain ?? input.candidates[0].domain;
        await ctx.tools?.dispatch("okf_grep", { query: domain });
        await ctx.tools?.dispatch("okf_write", {
          path: `context/${domain}.md`, type: "Project context", title: domain,
          description: "Recovered answer", tags: [`domain:${domain}`],
          body: `# Context\n\n${input.answer.answer}`,
        });
        return { checked_domains: [domain], questions: [], rationale: "recovered durable answer" };
      }
    }
    const driver = new RecoveryDriver();
    registerPipelines({ db, queue, worker, driverFor: () => driver });
    const [questionId] = await queue.addQuestions("p", null, "mediator", {
      question: "Is the product boundary still accurate?", domain: "product-bounds", trigger: "TIME",
    });
    const answered = await queue.answerQuestion(questionId, "Yes, preserve the explicit non-goal.", "dana");
    const failedId = await worker.enqueue("p", "refresh", {
      mode: "answer", event_generations: answered.event_generations,
      answer: { question_id: questionId, question: "stale payload is ignored", answer: "stale", domain: "product-bounds" },
    });
    worker.start(); active = worker;
    expect((await worker.waitForJob(failedId, 3_000)).status).toBe("failed");
    const recoveryId = await worker.findOrEnqueue("p", "refresh", { mode: "refresh" });
    expect((await worker.waitForJob(recoveryId, 3_000)).status).toBe("done");
    expect(driver.answerAttempts).toBe(3);
    expect((await new MemoryStore(db).get("p", "context/product-bounds.md"))?.body)
      .toContain("Yes, preserve the explicit non-goal.");
    expect(await db.prepare("SELECT curated_at IS NOT NULL AS curated FROM questions WHERE id=?").get(questionId))
      .toEqual({ curated: db.dialect === "postgres" ? true : 1 });
  });

  it("curates a durable groom conclusion inline without a refresh job", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
    const queue = new Queue(db);
    const worker = new MediatorWorker(db, { tickMs: 20, jobTimeoutMs: 2_000 });
    class InlineGroomDriver extends FakeDriver {
      override async groom(ctx: MediatorContext, submission: Submission) {
        await ctx.tools!.dispatch("okf_grep", { query: "stateless worker architecture" });
        await ctx.tools!.dispatch("okf_write", {
          path: "tech/worker-runtime.md",
          type: "Architecture",
          title: "Worker runtime",
          description: "Durable worker execution model",
          tags: [],
          body: "# Overview\n\nThe worker is stateless; durable state lives in the database.",
        });
        return {
          action: "accept" as const,
          title: submission.title,
          body: submission.body,
          priority: submission.priority,
          rationale: "accepted and curated inline",
        };
      }
    }
    registerPipelines({ db, queue, worker, driverFor: () => new InlineGroomDriver() });
    const state = new ProjectKnowledgeState(db);
    await state.ensure("p");
    await db.prepare(
      "UPDATE project_context_domains SET last_checked_at=?, last_refreshed_at=? WHERE project_id='p'",
    ).run(Date.now(), Date.now());
    const taskId = await queue.submit("p", "dana", { title: "record architecture", body: "use the evidence", evidence: [] });
    worker.start(); active = worker;
    expect((await worker.waitForJob(
      await worker.enqueue("p", "groom", { taskId, submittedBy: "dana" }), 3_000,
    )).status).toBe("done");
    expect((await new MemoryStore(db).get("p", "tech/worker-runtime.md"))?.body)
      .toContain("durable state lives in the database");
    expect(await db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind='refresh'").get()).toEqual({ n: 0 });
  });

  it("records an unresolved groom contradiction for the later consolidation sweep", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
    const queue = new Queue(db);
    const worker = new MediatorWorker(db, { tickMs: 20, jobTimeoutMs: 2_000 });
    const driver = {
      async groom(_ctx: MediatorContext, s: Submission) {
        return {
          action: "accept" as const, title: s.title, body: s.body, priority: s.priority,
          rationale: "accepted with observed contradiction",
          knowledge_events: [{ domain: "architecture-tech" as const, reason: "evidence shows the worker is now stateless" }],
        };
      },
      async review() { throw new Error("unused"); },
      async answer() { throw new Error("unused"); },
      async discuss() { throw new Error("unused"); },
      async enhance() { throw new Error("unused"); },
      async conciliate() { throw new Error("unused"); },
    };
    registerPipelines({ db, queue, worker, driverFor: () => driver as never });
    const state = new ProjectKnowledgeState(db);
    await state.ensure("p");
    await db.prepare(
      "UPDATE project_context_domains SET last_checked_at=?, last_refreshed_at=? WHERE project_id='p'",
    ).run(Date.now(), Date.now());
    const taskId = await queue.submit("p", "dana", { title: "refresh architecture", body: "use the evidence", evidence: [] });
    worker.start(); active = worker;
    expect((await worker.waitForJob(
      await worker.enqueue("p", "groom", { taskId, submittedBy: "dana" }), 3_000,
    )).status).toBe("done");
    expect(await db.prepare(
      `SELECT requested_generation, applied_generation, dirty_reason
         FROM project_context_domains WHERE project_id='p' AND domain='architecture-tech'`,
    ).get()).toEqual({
      requested_generation: 1,
      applied_generation: 0,
      dirty_reason: "groom contradiction: evidence shows the worker is now stateless",
    });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind='refresh'").get()).toEqual({ n: 0 });
  });

  it("coalesces a burst of dirty events into one periodic consolidation", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
    const queue = new Queue(db);
    const worker = new MediatorWorker(db, { tickMs: 20, jobTimeoutMs: 2_000 });
    registerPipelines({ db, queue, worker, driverFor: () => new FakeDriver() });
    const state = new ProjectKnowledgeState(db);
    await state.ensure("p");
    await db.prepare(
      "UPDATE project_context_domains SET last_checked_at=?, last_refreshed_at=? WHERE project_id='p'",
    ).run(Date.now(), Date.now());
    await state.markEvent("p", ["architecture-tech"], "first change");
    await state.markEvent("p", ["architecture-tech"], "second change");
    await state.markEvent("p", ["architecture-tech"], "third change");

    worker.start(); active = worker;
    let job = null;
    for (let attempt = 0; attempt < 20 && !job; attempt += 1) {
      job = await worker.findLatestJob("p", "refresh", { mode: "refresh" });
      if (!job) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(job).not.toBeNull();
    expect((await worker.waitForJob(job!.id, 3_000)).status).toBe("done");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(await db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind='refresh'").get()).toEqual({ n: 1 });
  });


  it("persists grounded groom citations and remaps evidence across valid and invalid merges", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
    const queue = new Queue(db);
    const worker = new MediatorWorker(db, { tickMs: 20, jobTimeoutMs: 2000 });
    const proposedTargets = new Map<number, number>();
    const driver = {
      async groom(_ctx: MediatorContext, s: Submission) {
        const evidenceId = s.evidence[0]?.id;
        return {
          action: "merge" as const,
          into_task_id: proposedTargets.get(s.taskId)!,
          rationale: `Grounded by EVID-${evidenceId}; not EVID-999999, PR #999999, DEC-999999, or task #999999.`,
        };
      },
      async review() { throw new Error("unused"); }, async answer() { throw new Error("unused"); },
    };
    registerPipelines({ db, queue, worker, driverFor: () => driver as never, publicUrl: "https://memracer.test" });
    worker.start(); active = worker;

    const mergeTitle = "Persist grounded groom citations";
    const mergeBody = "Remap grounded evidence citations to the surviving task.";
    const target = await queue.submit("p", "dana", { title: mergeTitle, body: mergeBody, evidence: [] });
    const merged = await queue.submit("p", "rui", {
      title: mergeTitle,
      body: `Outcome: ${mergeBody}`,
      evidence: [{ kind: "log", note: "proof" }],
    });
    proposedTargets.set(merged, target);
    const mergedEvidence = (await queue.brief(merged)).evidence[0].id;
    await worker.waitForJob(await worker.enqueue("p", "groom", { taskId: merged, submittedBy: "rui" }), 3000);
    const first = await db.prepare("SELECT citations FROM decision_log ORDER BY id LIMIT 1").get<{ citations: string }>();
    expect(JSON.parse(first!.citations)).toEqual([{ type: "evidence", id: mergedEvidence, url: `https://memracer.test/dashboard?project=p&task=${target}#evidence-${mergedEvidence}`, label: `EVID-${mergedEvidence}` }]);
    const persisted = await db.prepare("SELECT rationale FROM decision_log ORDER BY id LIMIT 1").get<{ rationale: string }>();
    expect(persisted!.rationale).toContain(`EVID-${mergedEvidence}`);
    expect(persisted!.rationale).toContain("EVID-?");
    expect(persisted!.rationale).toContain("PR #?");
    expect(persisted!.rationale).toContain("DEC-?");
    expect(persisted!.rationale).toContain("task #?");
    expect(persisted!.rationale).not.toContain("999999");
    const verdict = await db.prepare("SELECT content FROM session_events WHERE type='verdict' ORDER BY id LIMIT 1").get<{ content: string }>();
    expect(verdict!.content).not.toContain("999999");

    const invalid = await queue.submit("p", "rui", { title: "invalid", body: "invalid target", evidence: [{ kind: "code", path: "x.ts" }] });
    proposedTargets.set(invalid, 99_999);
    const invalidEvidence = (await queue.brief(invalid)).evidence[0].id;
    await worker.waitForJob(await worker.enqueue("p", "groom", { taskId: invalid, submittedBy: "rui" }), 3000);
    const second = await db.prepare("SELECT citations FROM decision_log ORDER BY id DESC LIMIT 1").get<{ citations: string }>();
    expect(JSON.parse(second!.citations)[0].url).toBe(`https://memracer.test/dashboard?project=p&task=${invalid}#evidence-${invalidEvidence}`);
  });

  it("groom accept: task groomed, decision logged, thread recorded", async () => {
    const { db, queue, worker } = await setup();
    active = worker;
    const id = await queue.submit("p", "dana", { title: "raw", body: "plain body", evidence: [] });
    const jobId = await worker.enqueue("p", "groom", { taskId: id, submittedBy: "dana" });
    const job = await worker.waitForJob(jobId, 3000);
    expect(job.status).toBe("done");
    expect(JSON.parse(job.result!)).toMatchObject({ action: "accept", task_id: id });
    expect((await queue.brief(id)).grooming_rationale).toBe("accepted as submitted");
    const dec = await db.prepare("SELECT kind, task_id FROM decision_log").all();
    expect(dec).toEqual([{ kind: "create", task_id: id }]);
    // first human message is the submission root prompt; the groom thread follows
    const msgs = await db.prepare("SELECT role FROM thread_messages ORDER BY id").all();
    expect(msgs).toEqual([{ role: "human" }, { role: "human" }, { role: "mediator" }]);
    // the groom thread is anchored to the task's root submission thread
    const root = (await db
      .prepare("SELECT root_thread_id FROM tasks WHERE id=?")
      .get<{ root_thread_id: number }>(id)) as { root_thread_id: number };
    expect(await db.prepare("SELECT root_id FROM threads WHERE kind='groom'").get()).toEqual({
      root_id: root.root_thread_id,
    });
  });

  it("groom merge: duplicate collapses into target, decision logged", async () => {
    const { db, queue, worker } = await setup();
    active = worker;
    const title = "Rate limit public API requests";
    const body = "Add a limiter for public API requests with a shared quota.";
    const target = await queue.submit("p", "dana", { title, body, evidence: [] });
    const dup = await queue.submit("p", "rui", { title, body: `Outcome: ${body}`, evidence: [] });
    const jobId = await worker.enqueue("p", "groom", { taskId: dup, submittedBy: "rui" });
    const job = await worker.waitForJob(jobId, 3000);
    expect(JSON.parse(job.result!)).toMatchObject({ action: "merge", into_task_id: target });
    expect((await queue.status("p")).tasks.map((t) => t.id)).toEqual([target]);
    expect(await db.prepare("SELECT kind FROM decision_log").all()).toEqual([{ kind: "merge" }]);
    const decision = await db.prepare("SELECT task_id, rationale FROM decision_log WHERE kind='merge'")
      .get<{ task_id: number; rationale: string }>();
    expect(decision?.task_id).toBe(target);
    // Provenance is a REFERENCE, not the merged task's full body: inlining the
    // body poisons every groom prompt (context-misattribution bug). task_id+title only.
    expect(decision!.rationale.split("\n").at(-1)).toBe(JSON.stringify({
      merged_from: { task_id: dup, title },
    }));
  });

  it("does not rewrite a merge source claimed or completed while the model runs", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
    const queue = new Queue(db);
    const worker = new MediatorWorker(db, { tickMs: 20, jobTimeoutMs: 2000 });
    const targets = new Map<number, number>();
    const driver = {
      async groom(_ctx: MediatorContext, submission: Submission) {
        const terminal = submission.title.includes("completed");
        if (terminal) {
          await db.prepare(
            "UPDATE tasks SET state='DONE', lease_agent=NULL, lease_expires_at=NULL WHERE id=?",
          ).run(submission.taskId);
        } else {
          await db.prepare(
            "UPDATE tasks SET state='CLAIMED', lease_agent='race-coder', lease_expires_at=? WHERE id=?",
          ).run(Date.now() + 60_000, submission.taskId);
        }
        return {
          action: "merge" as const,
          into_task_id: targets.get(submission.taskId)!,
          rationale: "same deliverable",
        };
      },
      async review() { throw new Error("unused"); },
      async answer() { throw new Error("unused"); },
    };
    registerPipelines({ db, queue, worker, driverFor: () => driver as never });
    worker.start(); active = worker;

    for (const state of ["claimed", "completed"] as const) {
      const title = `Preserve ${state} source during merge refusal`;
      const body = "Do not rewrite source metadata after concurrent lifecycle progress.";
      const target = await queue.submit("p", "dana", { title, body, evidence: [] });
      const source = await queue.submit("p", "dana", { title, body, evidence: [] });
      targets.set(source, target);
      const job = await worker.waitForJob(
        await worker.enqueue("p", "groom", { taskId: source, submittedBy: "dana" }),
        3_000,
      );

      expect(job.status).toBe("done");
      expect(JSON.parse(job.result!)).toMatchObject({
        action: "merge_refused",
        task_id: source,
        reason: "source_not_mergeable",
      });
      expect(await db.prepare(
        "SELECT title, body, grooming_rationale, state, lease_agent FROM tasks WHERE id=?",
      ).get(source)).toEqual({
        title,
        body,
        grooming_rationale: null,
        state: state === "claimed" ? "CLAIMED" : "DONE",
        lease_agent: state === "claimed" ? "race-coder" : null,
      });
    }
    expect(await db.prepare("SELECT kind FROM decision_log").all()).toEqual([]);
  });

  it("keeps MCP clarification delivery when the model proposes an OKF architecture merge", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
    const queue = new Queue(db);
    const worker = new MediatorWorker(db, { tickMs: 20, jobTimeoutMs: 2000 });
    let target = 0;
    let calls = 0;
    const driver = {
      async groom() {
        calls += 1;
        return { action: "merge" as const, into_task_id: target, rationale: "both mention mediator memory" };
      },
      async review() { throw new Error("unused"); },
      async answer() { throw new Error("unused"); },
    };
    registerPipelines({ db, queue, worker, driverFor: () => driver as never });
    worker.start(); active = worker;
    target = await queue.submit("p", "dana", {
      title: "Document mediator memory architecture",
      body: "Capture the OKF memory model in .okf/tech/mediator-memory.md.",
      evidence: [{ kind: "code", path: ".okf/tech/mediator-memory.md" }],
    });
    const source = await queue.submit("p", "rui", {
      title: "Piggyback MCP clarification delivery on human responses",
      body: "Deliver answered Frigg clarifications through src/mediator/pipelines.ts.",
      evidence: [{ kind: "code", path: "src/mediator/pipelines.ts" }],
    });

    const job = await worker.waitForJob(await worker.enqueue("p", "groom", { taskId: source, submittedBy: "rui" }), 3000);

    expect(job.status).toBe("done");
    expect(JSON.parse(job.result!)).toMatchObject({ action: "accept", task_id: source });
    expect(calls).toBe(1);
    expect((await queue.brief(source)).grooming_rationale).toContain("scope_mismatch");
    expect((await queue.status("p")).tasks.map((task) => task.id)).toEqual([target, source]);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM decision_log WHERE kind='merge'").get()).toEqual({ n: 0 });
  });

  it("consolidation merges exact duplicates without mediator inference or model cost", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
    const queue = new Queue(db);
    const worker = new MediatorWorker(db, { tickMs: 20, jobTimeoutMs: 2000 });
    const driver = {
      async groom() { throw new Error("consolidation must not invoke the mediator"); },
      async review() { throw new Error("unused"); }, async answer() { throw new Error("unused"); },
    };
    registerPipelines({ db, queue, worker, driverFor: () => driver as never });

    const title = "Consolidate duplicate queue safety work";
    const body = "Guard duplicate deletion with one deterministic queue classifier.";
    const target = await queue.submit("p", "dana", { title, body, evidence: [] });
    const duplicate = await queue.submit("p", "rui", { title, body: `Outcome: ${body}`, evidence: [] });
    const untouched = await queue.submit("p", "rui", { title: "unrelated", body: "original", evidence: [] });
    const leased = await queue.submit("p", "rui", { title: "leased", body: "b", evidence: [] });
    await db
      .prepare("UPDATE tasks SET grooming_rationale='already groomed' WHERE id IN (?, ?, ?, ?)")
      .run(target, duplicate, untouched, leased);
    await db.prepare("UPDATE tasks SET state='EXECUTING', lease_agent='coder', lease_expires_at=? WHERE id=?").run(Date.now() + 60_000, leased);

    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const sweepId = await worker.enqueue("p", "consolidate", { watermark: "manual" });
    worker.start(); active = worker;
    const sweep = await worker.waitForJob(sweepId, 3000);

    expect(JSON.parse(sweep.result!)).toEqual({
      calls: 0,
      merges: 1,
      prompt_tokens: 0,
      completion_tokens: 0,
      cost_usd: 0,
      watermark: expect.any(String),
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('\"calls\":0,\"merges\":1'));
    log.mockRestore();
    expect((await queue.status("p")).tasks.map((task) => task.id)).not.toContain(duplicate);
    expect((await queue.brief(untouched)).body).toBe("original");
    expect((await queue.brief(leased)).state).toBe("EXECUTING");
    expect(await db.prepare(
      "SELECT kind, prompt_tokens, completion_tokens, cost_usd, completion_count FROM mediator_usage WHERE job_id=?",
    ).get(sweepId)).toEqual({
      kind: "consolidate",
      prompt_tokens: 0,
      completion_tokens: 0,
      cost_usd: 0,
      completion_count: 0,
    });
  });

  it("consolidation preserves the lower-priority duplicate across priority tiers", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
    const queue = new Queue(db);
    const worker = new MediatorWorker(db, { tickMs: 20, jobTimeoutMs: 2000 });
    const driver = {
      async groom() { throw new Error("consolidation must not invoke the mediator"); },
      async review() { throw new Error("unused"); }, async answer() { throw new Error("unused"); },
    };
    registerPipelines({ db, queue, worker, driverFor: () => driver as never });
    const title = "Keep conservative consolidation priority";
    const body = "Retain the lower-priority task when exact duplicates have different queue priorities.";
    const urgent = await queue.submit("p", "dana", { title, body, priority: 0, evidence: [] });
    const lowerPriority = await queue.submit("p", "rui", { title, body, priority: 3, evidence: [] });
    const reverseTitle = "Keep lower priority when it is older";
    const reverseBody = "Age must only break ties after queue priority.";
    const olderLowerPriority = await queue.submit("p", "rui", {
      title: reverseTitle, body: reverseBody, priority: 3, evidence: [],
    });
    const newerUrgent = await queue.submit("p", "dana", {
      title: reverseTitle, body: reverseBody, priority: 0, evidence: [],
    });
    await db.prepare("UPDATE tasks SET grooming_rationale='groomed'").run();
    worker.start(); active = worker;

    const sweep = await worker.waitForJob(await worker.enqueue("p", "consolidate", { watermark: "manual" }), 3000);

    expect(JSON.parse(sweep.result!)).toMatchObject({ calls: 0, merges: 2 });
    expect(await db.prepare("SELECT id, priority FROM tasks WHERE project_id='p' ORDER BY id").all()).toEqual([
      { id: lowerPriority, priority: 3 },
      { id: olderLowerPriority, priority: 3 },
    ]);
    expect(await db.prepare("SELECT id FROM tasks WHERE id=?").get(urgent)).toBeUndefined();
    expect(await db.prepare("SELECT id FROM tasks WHERE id=?").get(newerUrgent)).toBeUndefined();
  });

  it("keeps a task's own submission when the model regurgitates a DIFFERENT live task's content", async () => {
    // Reproduces the content-misattribution bug: grooming task B, the model
    // emits task A's verbatim content. The guard must keep B's own submission.
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
    const queue = new Queue(db);
    const worker = new MediatorWorker(db, { tickMs: 20, jobTimeoutMs: 2000 });
    let victim = 0;
    const neighborTitle = "Delete the causal SVG trace from the session view";
    const neighborBody = "Remove the CausalTrace SVG component; keep the transcript.";
    registerPipelines({
      db,
      queue,
      worker,
      driverFor: (_projectId, _job) => ({
        async groom(_ctx: MediatorContext, submission: Submission) {
          // The victim gets the neighbor's content (the misattribution); everyone else grooms to self.
          if (submission.taskId === victim) {
            return { action: "accept" as const, title: neighborTitle, body: neighborBody, priority: submission.priority, rationale: "poisoned" };
          }
          return { action: "accept" as const, title: submission.title, body: submission.body, priority: submission.priority, rationale: "ok" };
        },
        async review() { throw new Error("unused"); },
        async answer() { throw new Error("unused"); },
      }),
    });
    worker.start(); active = worker;
    const neighbor = await queue.submit("p", "dana", { title: neighborTitle, body: neighborBody, evidence: [] });
    victim = await queue.submit("p", "rui", { title: "Team analytics view", body: "Build the contributor leaderboard and Frigg panels.", evidence: [] });
    for (const [taskId, submittedBy] of [[neighbor, "dana"], [victim, "rui"]] as const) {
      const groom = await worker.waitForJob(await worker.enqueue("p", "groom", { taskId, submittedBy }), 3000);
      expect(groom.status).toBe("done");
    }
    const row = await db.prepare("SELECT title, body FROM tasks WHERE id=?").get<{ title: string; body: string }>(victim);
    expect(row!.title).toBe("Team analytics view");
    expect(row!.body).toBe("Build the contributor leaderboard and Frigg panels.");
    expect(row!.body).not.toBe(neighborBody);
  });

  it("consolidates fully groomed tasks without leaving FK-owned history behind", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
    const queue = new Queue(db);
    const worker = new MediatorWorker(db, { tickMs: 20, jobTimeoutMs: 2000 });
    let target = 0;
    let duplicate = 0;
    let mergeEnabled = false;
    registerPipelines({
      db,
      queue,
      worker,
      driverFor: (_projectId, job) => ({
        async groom(_ctx: MediatorContext, submission: Submission) {
          if (job.kind === "consolidate" && mergeEnabled && submission.taskId === duplicate) {
            return { action: "merge" as const, into_task_id: target, rationale: "same accepted work" };
          }
          return {
            action: "accept" as const,
            title: submission.title,
            body: submission.body,
            priority: submission.priority,
            rationale: "accepted before consolidation",
          };
        },
        async review() { throw new Error("unused"); },
        async answer() { throw new Error("unused"); },
      }),
    });
    worker.start(); active = worker;
    const title = "Consolidate fully groomed duplicate tasks";
    const body = "Retarget every durable task history row before deleting the duplicate.";
    target = await queue.submit("p", "dana", { title, body, evidence: [] });
    duplicate = await queue.submit("p", "rui", { title, body: `Outcome: ${body}`, evidence: [] });
    for (const [taskId, submittedBy] of [[target, "dana"], [duplicate, "rui"]] as const) {
      const groom = await worker.waitForJob(await worker.enqueue("p", "groom", { taskId, submittedBy }), 3000);
      expect(groom.status).toBe("done");
    }
    await db.prepare(
      "INSERT INTO attempts (task_id, agent, outcome, notes, created_at) VALUES (?, 'old-coder', 'released', 'history', ?)",
    ).run(duplicate, Date.now());
    await db.prepare(
      "INSERT INTO task_notes (task_id, agent, note, created_at) VALUES (?, 'old-coder', 'keep this note', ?)",
    ).run(duplicate, Date.now());

    mergeEnabled = true;
    const sweep = await worker.waitForJob(await worker.enqueue("p", "consolidate", { watermark: "manual" }), 3000);

    expect(sweep.status).toBe("done");
    expect(JSON.parse(sweep.result!)).toMatchObject({ merges: 1 });
    expect(await db.prepare("SELECT id FROM tasks WHERE id=?").get(duplicate)).toBeUndefined();
    for (const table of ["attempts", "task_notes", "decision_log", "threads", "session_events"]) {
      expect(await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE task_id=?`).get(duplicate)).toEqual({ n: 0 });
    }
    expect(await db.prepare("SELECT COUNT(*) AS n FROM decision_log WHERE task_id=?").get(target)).toEqual({ n: 3 });
    const mergeDecision = await db.prepare("SELECT rationale FROM decision_log WHERE task_id=? AND kind='merge'")
      .get<{ rationale: string }>(target);
    expect(mergeDecision!.rationale.split("\n").at(-1)).toBe(JSON.stringify({
      merged_from: { task_id: duplicate, title },
    }));
    expect(await db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE task_id=?").get(target)).toEqual({ n: 1 });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM task_notes WHERE task_id=?").get(target)).toEqual({ n: 1 });
  });

  it("logs a deleted consolidation target, retries its duplicate group, and continues", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
    const queue = new Queue(db);
    const worker = new MediatorWorker(db, { tickMs: 20, jobTimeoutMs: 2000 });
    const targetA = await queue.submit("p", "dana", { title: "target-a", body: "same", evidence: [] });
    const staleCandidate = await queue.submit("p", "rui", { title: "target-a", body: "same", evidence: [] });
    const laterSameCandidate = await queue.submit("p", "rui", { title: "target-a", body: "same", evidence: [] });
    const duplicateTitle = "Consolidate safe duplicate queue tasks";
    const duplicateBody = "Retain one copy of the same fully groomed queue deliverable.";
    const targetB = await queue.submit("p", "dana", { title: duplicateTitle, body: duplicateBody, evidence: [] });
    const mergeCandidate = await queue.submit("p", "rui", { title: duplicateTitle, body: duplicateBody, evidence: [] });
    await db.prepare("UPDATE tasks SET grooming_rationale='groomed'").run();
    const applyQueuedGroomMerge = queue.applyQueuedGroomMerge.bind(queue);
    queue.applyQueuedGroomMerge = async (sourceId, targetId, projectId, audit) => {
      if (sourceId === staleCandidate) await queue.applyGroomRefuse(targetA, "p");
      return applyQueuedGroomMerge(sourceId, targetId, projectId, audit);
    };
    const driver = {
      async groom() { throw new Error("consolidation must not invoke the mediator"); },
      async review() { throw new Error("unused"); }, async answer() { throw new Error("unused"); },
    };
    registerPipelines({ db, queue, worker, driverFor: () => driver as never });
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    worker.start(); active = worker;

    const sweep = await worker.waitForJob(await worker.enqueue("p", "consolidate", { watermark: "manual" }), 3000);

    expect(sweep.status).toBe("done");
    expect(JSON.parse(sweep.result!)).toMatchObject({ merges: 2 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`[queue-dedup-skip] {"project_id":"p","candidate_id":${staleCandidate},"target_id":${targetA},"reason":"target_not_mergeable"}`));
    expect(await db.prepare("SELECT id FROM tasks WHERE id=?").get(staleCandidate)).toEqual({ id: staleCandidate });
    expect(await db.prepare("SELECT id FROM tasks WHERE id=?").get(laterSameCandidate)).toBeUndefined();
    expect(await db.prepare("SELECT id FROM tasks WHERE id=?").get(mergeCandidate)).toBeUndefined();
    log.mockRestore();
  });

  it("logs a deterministic consolidation refusal and continues to a later duplicate", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
    const queue = new Queue(db);
    const worker = new MediatorWorker(db, { tickMs: 20, jobTimeoutMs: 2000 });
    const refusedTitle = "Record mediator delivery architecture";
    const refusedBody = "Record the mediator delivery architecture for operators.";
    const refusedTarget = await queue.submit("p", "dana", {
      title: refusedTitle,
      body: refusedBody,
      evidence: [{ kind: "code", path: ".okf/tech/mediator-sessions.md" }],
    });
    const refusedCandidate = await queue.submit("p", "rui", {
      title: refusedTitle,
      body: refusedBody,
      evidence: [{ kind: "code", path: ".okf/tech/mediator-sessions.md" }],
    });
    const duplicateTitle = "Consolidate safe duplicate queue tasks";
    const duplicateBody = "Retain one copy of the same fully groomed queue deliverable.";
    const duplicateTarget = await queue.submit("p", "dana", { title: duplicateTitle, body: duplicateBody, evidence: [] });
    const duplicateCandidate = await queue.submit("p", "rui", { title: duplicateTitle, body: duplicateBody, evidence: [] });
    await db.prepare("UPDATE tasks SET grooming_rationale='groomed'").run();
    const applyQueuedGroomMerge = queue.applyQueuedGroomMerge.bind(queue);
    queue.applyQueuedGroomMerge = async (sourceId, targetId, projectId, audit) => {
      if (sourceId === refusedCandidate) {
        await db.prepare(
          "INSERT INTO evidence (task_id, kind, path) VALUES (?, 'code', 'src/mediator/pipelines.ts')",
        ).run(refusedCandidate);
      }
      return applyQueuedGroomMerge(sourceId, targetId, projectId, audit);
    };
    const driver = {
      async groom() { throw new Error("consolidation must not invoke the mediator"); },
      async review() { throw new Error("unused"); },
      async answer() { throw new Error("unused"); },
    };
    registerPipelines({ db, queue, worker, driverFor: () => driver as never });
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    worker.start(); active = worker;

    const sweep = await worker.waitForJob(await worker.enqueue("p", "consolidate", { watermark: "manual" }), 3000);

    expect(JSON.parse(sweep.result!)).toMatchObject({ merges: 1 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining(
      `[queue-dedup-skip] {"project_id":"p","candidate_id":${refusedCandidate},"target_id":${refusedTarget},"reason":"scope_mismatch"}`,
    ));
    expect(await db.prepare("SELECT id FROM tasks WHERE id=?").get(refusedCandidate)).toEqual({ id: refusedCandidate });
    expect(await db.prepare("SELECT id FROM tasks WHERE id=?").get(duplicateCandidate)).toBeUndefined();
    expect(await db.prepare("SELECT COUNT(*) AS n FROM decision_log WHERE kind='merge'").get()).toEqual({ n: 1 });
    log.mockRestore();
  });

  it("change-gates project consolidation durably and never schedules it more than hourly", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
    const queue = new Queue(db);
    const old = Date.now() - 2 * 60 * 60 * 1000;
    await db.prepare(
      "INSERT INTO jobs (project_id, kind, payload, status, result, created_at, updated_at) VALUES ('p','consolidate','{}','done','{}',?,?)",
    ).run(old, old);

    const firstWorker = new MediatorWorker(db, { tickMs: 10, jobTimeoutMs: 2000 });
    registerPipelines({ db, queue, worker: firstWorker, driverFor: () => new FakeDriver() });
    firstWorker.start(); active = firstWorker;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(await db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind='consolidate'").get()).toEqual({ n: 1 });

    const target = await queue.submit("p", "dana", { title: "target", body: "b", evidence: [] });
    await db.prepare("UPDATE tasks SET grooming_rationale='groomed', updated_at=? WHERE id=?").run(Date.now(), target);
    let scheduled: { id: number; payload: string } | undefined;
    for (let i = 0; i < 100 && !scheduled; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      scheduled = await db.prepare("SELECT id, payload FROM jobs WHERE kind='consolidate' ORDER BY id DESC LIMIT 1").get<{ id: number; payload: string }>();
      if (scheduled?.id === 1) scheduled = undefined;
    }
    expect(scheduled).toBeDefined();
    expect(JSON.parse(scheduled!.payload)).toEqual({ watermark: expect.stringContaining(`\"id\":${target}`) });

    const another = await queue.submit("p", "rui", { title: "another", body: "b", evidence: [] });
    await db.prepare("UPDATE tasks SET grooming_rationale='groomed', updated_at=? WHERE id=?").run(Date.now(), another);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind='consolidate'").get()).toEqual({ n: 2 });

    firstWorker.stop();
    const latest = await db.prepare("SELECT id, result FROM jobs WHERE kind='consolidate' ORDER BY id DESC LIMIT 1").get<{ id: number; result: string }>();
    await db.prepare("UPDATE jobs SET created_at=? WHERE id=?").run(Date.now() - 2 * 60 * 60 * 1000, latest!.id);
    await db.prepare("UPDATE tasks SET state='DONE' WHERE id=?").run(another);
    const restarted = new MediatorWorker(db, { tickMs: 10, jobTimeoutMs: 2000 });
    registerPipelines({ db, queue, worker: restarted, driverFor: () => new FakeDriver() });
    restarted.start(); active = restarted;
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Removing an entry from the prior fingerprint is not new queued work.
    expect(await db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind='consolidate'").get()).toEqual({ n: 2 });
  });

  it("groom context excludes the task being groomed (no self-merge invitation)", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
    const queue = new Queue(db);
    const worker = new MediatorWorker(db, { tickMs: 20, jobTimeoutMs: 2000 });
    const seenQueues: number[][] = [];
    const spyDriver = {
      async groom(ctx: MediatorContext, s: Submission) {
        seenQueues.push(ctx.queue.map((t) => t.id));
        return { action: "accept" as const, title: s.title, body: s.body, priority: s.priority, rationale: "ok" };
      },
      async review() { throw new Error("unused"); },
      async answer() { throw new Error("unused"); },
    };
    registerPipelines({ db, queue, worker, driverFor: () => spyDriver as never });
    worker.start();
    active = worker;
    const other = await queue.submit("p", "dana", { title: "other", body: "b", evidence: [] });
    const id = await queue.submit("p", "dana", { title: "mine", body: "b", evidence: [] });
    await worker.waitForJob(await worker.enqueue("p", "groom", { taskId: id, submittedBy: "dana" }), 3000);
    expect(seenQueues[0]).toContain(other);
    expect(seenQueues[0]).not.toContain(id);
  });

  it("groom merge into itself falls back to accept (mediator hallucination guard)", async () => {
    const { db, queue, worker } = await setup();
    active = worker;
    const id = await queue.submit("p", "dana", {
      title: "solo", body: "", evidence: [{ kind: "code", path: "x.ts", snippet: "s" }],
    });
    await db.prepare("UPDATE tasks SET body = ? WHERE id = ?").run(`MERGE:${id} itself`, id);
    const jobId = await worker.enqueue("p", "groom", { taskId: id, submittedBy: "dana" });
    const job = await worker.waitForJob(jobId, 3000);
    expect(job.status).toBe("done");
    expect(JSON.parse(job.result!)).toMatchObject({ action: "accept", task_id: id });
    const brief = await queue.brief(id);
    expect(brief.state).toBe("QUEUED");
    expect(brief.grooming_rationale).toMatch(/refused 1 \(same_task\)/);
    expect(await db.prepare("SELECT kind FROM decision_log").all()).toEqual([{ kind: "create" }]);
  });

  it("groom merge into a nonexistent task falls back to accept", async () => {
    const { queue, worker } = await setup();
    active = worker;
    const id = await queue.submit("p", "dana", { title: "t", body: "MERGE:9999 ghost", evidence: [] });
    const jobId = await worker.enqueue("p", "groom", { taskId: id, submittedBy: "dana" });
    const job = await worker.waitForJob(jobId, 3000);
    expect(job.status).toBe("done");
    expect(JSON.parse(job.result!)).toMatchObject({ action: "accept", task_id: id });
    expect((await queue.brief(id)).grooming_rationale).toMatch(/refused 9999 \(target_not_mergeable\)/);
  });

  it("groom clarify: question recorded against the submitter", async () => {
    const { db, queue, worker } = await setup();
    active = worker;
    const id = await queue.submit("p", "dana", {
      title: "t",
      body: "CLARIFY: Which region should host it? Recommended: eu-west-1 — it matches the current deployment.",
      evidence: [],
    });
    const jobId = await worker.enqueue("p", "groom", { taskId: id, submittedBy: "dana" });
    const job = await worker.waitForJob(jobId, 3000);
    const question = "Which region should host it? Recommended: eu-west-1 — it matches the current deployment.";
    expect(JSON.parse(job.result!)).toMatchObject({ action: "clarify", question });
    expect(await db.prepare("SELECT question, status FROM questions").all()).toEqual([
      { question, status: "open" },
    ]);
  });

  it("groom CLARIFY-OWNED e2e: person_owned true → negotiation awaiting_person + linked question_id", async () => {
    const { db, queue, worker } = await setup();
    active = worker;
    const id = await queue.submit("p", "dana", {
      title: "t",
      body: "CLARIFY-OWNED: Ship v1 now or wait for the broader v2 scope? Recommended: ship v1 — keeps the release train moving.",
      evidence: [],
    });
    const jobId = await worker.enqueue("p", "groom", { taskId: id, submittedBy: "dana" });
    const job = await worker.waitForJob(jobId, 3000);
    const question =
      "Ship v1 now or wait for the broader v2 scope? Recommended: ship v1 — keeps the release train moving.";
    expect(job.status).toBe("done");
    const result = JSON.parse(job.result!);
    expect(result).toMatchObject({
      action: "clarify",
      question,
      question_id: expect.any(Number),
      negotiation_id: expect.any(String),
    });
    expect(await db.prepare("SELECT question, status FROM questions WHERE id=?").get(result.question_id)).toEqual({
      question,
      status: "open",
    });
    const neg = await db
      .prepare(
        `SELECT state, current_prompt, question_id, party_identity
         FROM negotiations WHERE id = ?`,
      )
      .get<{
        state: string;
        current_prompt: string;
        question_id: number;
        party_identity: string;
      }>(result.negotiation_id);
    expect(neg).toEqual({
      state: "awaiting_person",
      current_prompt: question,
      question_id: result.question_id,
      party_identity: "dana",
    });
  });

  it("rejects malformed custom-driver clarification before persistence", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
    const queue = new Queue(db);
    const worker = new MediatorWorker(db, { tickMs: 10, jobTimeoutMs: 500 });
    const invalidDriver = {
      async groom() {
        return { action: "clarify", question: "Which region? Which database?", rationale: "bundled" };
      },
    };
    registerPipelines({ db, queue, worker, driverFor: () => invalidDriver as never });
    worker.start();
    active = worker;
    const id = await queue.submit("p", "dana", { title: "t", body: "ambiguous", evidence: [] });
    const job = await worker.waitForJob(
      await worker.enqueue("p", "groom", { taskId: id, submittedBy: "dana" }),
      3_000,
    );
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/exactly one question mark|Recommended:/i);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM questions WHERE task_id=?").get(id)).toEqual({ n: 0 });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM decision_log WHERE task_id=?").get(id)).toEqual({ n: 0 });
  });

  it("groom routes a decision and its answered-question reconciliation into the ledger and generated index", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
    const queue = new Queue(db);
    const worker = new MediatorWorker(db, { tickMs: 20, jobTimeoutMs: 2000 });
    // A driver that curates agentically DURING groom, the way the live
    // OpenRouter tool loop does — no pushed digest, no batched curate.
    const agenticDriver = {
      async groom(ctx: MediatorContext, s: Submission) {
        expect(ctx.memory).toBe(""); // no forced digest injection
        expect(ctx.tools).toBeDefined();
        const before = (await ctx.tools!.dispatch("okf_read", {})) as { content: string };
        expect(before.content).toContain('okf_version'); // reads its own (empty) index
        const decision = (await ctx.tools!.dispatch("okf_write", {
          path: "decisions/retention.md",
          type: "Decision",
          title: "Retention decision",
          description: "Keep records for one week",
          tags: ["storage"],
          body: `# Context\n\nTask ${s.taskId} needed a retention choice.\n\n# Rationale\n\nBounded storage.\n\n# Status\n\nAccepted.\n\n# Consequences\n\nSee [Open questions ledger](questions/open-questions.md).\n\n# Citations`,
        })) as { ok?: boolean };
        expect(decision.ok).toBe(true);
        const ledger = (await ctx.tools!.dispatch("okf_write", {
          path: "questions/open-questions.md",
          type: "Reference",
          title: "Open questions ledger",
          description: "Questions and their resolved state",
          tags: ["questions"],
          body: `# Summary\n\nRetention is answered: keep records for one week. See [Retention decision](decisions/retention.md).\n\n# Details\n\n# Citations`,
        })) as { ok?: boolean };
        expect(ledger.ok).toBe(true);
        const validated = (await ctx.tools!.dispatch("okf_validate", {})) as { ok?: boolean; graph_consistent?: boolean };
        expect(validated).toMatchObject({ ok: true, graph_consistent: true });
        const after = (await ctx.tools!.dispatch("okf_read", {})) as { content: string };
        expect(after.content).toContain("[decisions](decisions/)");
        expect(after.content).toContain("[questions](questions/)");
        const decisions = (await ctx.tools!.dispatch("okf_read", { path: "decisions/" })) as { content: string };
        const questions = (await ctx.tools!.dispatch("okf_read", { path: "questions/" })) as { content: string };
        expect(decisions.content).toContain("Retention decision");
        expect(questions.content).toContain("Open questions ledger");
        return { action: "accept" as const, title: s.title, body: s.body, priority: s.priority, rationale: "ok" };
      },
      async review() { throw new Error("unused"); },
      async answer() { throw new Error("unused"); },
    };
    registerPipelines({ db, queue, worker, driverFor: () => agenticDriver as never });
    worker.start();
    active = worker;
    const id = await queue.submit("p", "dana", { title: "t", body: "plain body", evidence: [] });
    const job = await worker.waitForJob(await worker.enqueue("p", "groom", { taskId: id, submittedBy: "dana" }), 3000);
    expect(job.status).toBe("done");
    const docs = await db.prepare("SELECT path FROM memory_docs WHERE project_id='p' ORDER BY path").all<{ path: string }>();
    expect(docs).toEqual([{ path: "decisions/retention.md" }, { path: "questions/open-questions.md" }]);
    const indexes = await new MemoryStore(db).renderIndexes("p");
    expect(indexes.get("decisions/index.md")).toContain("Retention decision");
    expect(indexes.get("questions/index.md")).toContain("Open questions ledger");
    // and no queued curate job was needed to make those writes happen
    expect(await db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind='curate'").get()).toEqual({ n: 0 });
  });

  it("review approve moves the task to PLANNED; revise leaves it and returns feedback", async () => {
    const { queue, worker } = await setup();
    active = worker;
    const id = await queue.submit("p", "dana", { title: "t", body: "b", evidence: [] });
    await queue.claimNext("p", "cc-1", DEFAULT_LEASE_TTL_MS);

    const bad = await worker.enqueue("p", "review", { taskId: id, plan: "a bad plan", agent: "cc-1" });
    expect(JSON.parse((await worker.waitForJob(bad, 3000)).result!)).toMatchObject({
      verdict: "revise", feedback: "plan flagged as bad",
    });
    expect((await queue.brief(id)).state).toBe("CLAIMED");

    const good = await worker.enqueue("p", "review", { taskId: id, plan: "solid", agent: "cc-1" });
    expect(JSON.parse((await worker.waitForJob(good, 3000)).result!)).toMatchObject({ verdict: "approved" });
    const planned = await queue.brief(id);
    expect(planned.state).toBe("PLANNED");
    // approval stores the coder's plan text and closes the plan window
    expect(planned.plan).toBe("solid");
    expect(planned.plan_deadline).toBeNull();
    expect(planned.plan_approved_at).toBeGreaterThan(0);
  });

  it("pipelines fire the queue change signal even when only decision_log/threads are written", async () => {
    const { queue, worker } = await setup();
    active = worker;
    const id = await queue.submit("p", "dana", {
      title: "t",
      body: "CLARIFY: Which region should host it? Recommended: eu-west-1 — it matches the current deployment.",
      evidence: [],
    });
    const changed: string[] = [];
    queue.onChanged((pid) => changed.push(pid));

    // groom clarify writes questions + decision_log + thread, no task mutation
    await worker.waitForJob(await worker.enqueue("p", "groom", { taskId: id, submittedBy: "dana" }), 3000);
    expect(changed).toContain("p");

    // review revise writes decision_log + thread only
    await queue.claimNext("p", "cc-1", DEFAULT_LEASE_TTL_MS);
    changed.length = 0;
    await worker.waitForJob(await worker.enqueue("p", "review", { taskId: id, plan: "a bad plan", agent: "cc-1" }), 3000);
    expect(changed).toContain("p");

    // answer without escalation writes decision_log + thread only
    changed.length = 0;
    await worker.waitForJob(await worker.enqueue("p", "answer", { taskId: id, question: "life?", agent: "cc-1" }), 3000);
    expect(changed).toContain("p");
  });

  it("project-level discuss (taskId 0) answers without FK violations", async () => {
    const { db, queue, worker } = await setup();
    active = worker;
    void queue;
    const direct = await worker.enqueue("p", "answer", { taskId: 0, question: "queue health?", agent: "dana" });
    const done = await worker.waitForJob(direct, 3000);
    expect(done.status).toBe("done");
    expect(JSON.parse(done.result!)).toMatchObject({ escalated: false, answer: "42" });
    expect(await db.prepare("SELECT task_id FROM threads WHERE kind='answer'").get()).toEqual({ task_id: null });

    const esc = await worker.enqueue("p", "answer", { taskId: 0, question: "please escalate this", agent: "dana" });
    const escDone = await worker.waitForJob(esc, 3000);
    expect(escDone.status).toBe("done");
    expect(JSON.parse(escDone.result!)).toMatchObject({ escalated: true });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM questions").get()).toEqual({ n: 0 });
  });

  it("closing a task resolves its open questions (no zombie asks)", async () => {
    const { db, queue, worker } = await setup();
    active = worker;
    const id = await queue.submit("p", "dana", { title: "doomed", body: "b", evidence: [] });
    await db.prepare(
      "INSERT INTO questions (project_id, task_id, asked_by, question, created_at) VALUES ('p', ?, 'cc-1', 'blocked: why?', 1)",
    ).run(id);
    await worker.waitForJob(
      await worker.enqueue("p", "discuss", { message: `close task ${id}: obsolete`, from: "dana" }),
      3000,
    );
    expect(await db.prepare("SELECT status, answer FROM questions WHERE task_id=?").get(id)).toEqual({
      status: "answered",
      answer: "resolved: task closed (obsolete)",
    });
  });

  it("discuss: close via conversation — task DONE, decision 'close', thread recorded", async () => {
    const { db, queue, worker } = await setup();
    active = worker;
    const id = await queue.submit("p", "dana", { title: "stale idea", body: "b", evidence: [] });
    const jobId = await worker.enqueue("p", "discuss", { message: `close task ${id}: shipped in PR #12`, from: "dana" });
    const job = await worker.waitForJob(jobId, 3000);
    expect(job.status).toBe("done");
    const result = JSON.parse(job.result!);
    expect(result.reply).toBe("done: 1 action(s)");
    expect(result.applied).toEqual([{ action: "close_task", task_id: id, reason: "shipped in PR #12" }]);
    expect(result.refused).toEqual([]);
    const brief = await queue.brief(id);
    expect(brief.state).toBe("DONE");
    // Attribution reflects the actual trigger: a human operator directed this close.
    expect(brief.result_summary).toBe("closed (operator:dana): shipped in PR #12");
    expect(await db.prepare("SELECT kind, task_id, rationale FROM decision_log").all()).toEqual([
      { kind: "close", task_id: id, rationale: "shipped in PR #12" },
    ]);
    const discussThread = (await db
      .prepare("SELECT id, kind, task_id FROM threads WHERE kind='discuss'")
      .get<{ id: number; kind: string; task_id: number | null }>()) as {
      id: number; kind: string; task_id: number | null;
    };
    expect(discussThread).toMatchObject({ kind: "discuss", task_id: null });
    const msgs = (await db.prepare(
      "SELECT role, author, content FROM thread_messages WHERE thread_id=? ORDER BY id",
    ).all<{ role: string; author: string; content: string }>(discussThread.id));
    expect(msgs[0]).toEqual({ role: "human", author: "dana", content: `close task ${id}: shipped in PR #12` });
    expect(msgs[1].role).toBe("mediator");
    expect(JSON.parse(msgs[1].content).actions).toHaveLength(1);
  });

  it("discuss: refuses to close an EXECUTING task", async () => {
    const { db, queue, worker } = await setup();
    active = worker;
    const id = await queue.submit("p", "dana", { title: "in flight", body: "b", evidence: [] });
    await queue.claimNext("p", "cc-1", DEFAULT_LEASE_TTL_MS);
    await queue.progress(id, "cc-1", "working", DEFAULT_LEASE_TTL_MS);
    const jobId = await worker.enqueue("p", "discuss", { message: `close task ${id}: never mind`, from: "dana" });
    const result = JSON.parse((await worker.waitForJob(jobId, 3000)).result!);
    expect(result.applied).toEqual([]);
    expect(result.refused).toEqual([
      { action: "close_task", task_id: id, reason: `task ${id} is EXECUTING` },
    ]);
    expect((await queue.brief(id)).state).toBe("EXECUTING");
    expect(await db.prepare("SELECT COUNT(*) AS n FROM decision_log").get()).toEqual({ n: 0 });
  });

  it("discuss: set_priority reprioritizes and logs a 'priority' decision", async () => {
    const { db, queue, worker } = await setup();
    active = worker;
    const id = await queue.submit("p", "dana", { title: "t", body: "b", evidence: [] });
    const jobId = await worker.enqueue("p", "discuss", { message: `set task ${id} to P0`, from: "dana" });
    const result = JSON.parse((await worker.waitForJob(jobId, 3000)).result!);
    expect(result.applied).toEqual([
      { action: "set_priority", task_id: id, priority: 0, reason: "member request" },
    ]);
    expect((await queue.brief(id)).priority).toBe(0);
    expect(await db.prepare("SELECT kind FROM decision_log").all()).toEqual([{ kind: "priority" }]);
  });

  it("discuss: an action against a nonexistent task is refused, others still apply", async () => {
    const { queue, worker } = await setup();
    active = worker;
    const id = await queue.submit("p", "dana", { title: "t", body: "b", evidence: [] });
    const jobId = await worker.enqueue("p", "discuss", {
      message: `close task 9999: ghost\nset task ${id} to P1`, from: "dana",
    });
    const result = JSON.parse((await worker.waitForJob(jobId, 3000)).result!);
    expect(result.refused).toEqual([
      { action: "close_task", task_id: 9999, reason: "task 9999 not found in project" },
    ]);
    expect(result.applied).toEqual([
      { action: "set_priority", task_id: id, priority: 1, reason: "member request" },
    ]);
    expect((await queue.brief(id)).priority).toBe(1);
  });

  it("discuss: a pure question yields a reply, no actions, no decisions — thread still recorded", async () => {
    const { db, queue, worker } = await setup();
    active = worker;
    void queue;
    const changed: string[] = [];
    queue.onChanged((pid) => changed.push(pid));
    const jobId = await worker.enqueue("p", "discuss", { message: "what should we tackle next?", from: "dana" });
    const result = JSON.parse((await worker.waitForJob(jobId, 3000)).result!);
    // references is a server-minted, additive field; empty here (no publicUrl configured).
    expect(result).toEqual({ reply: "noted", applied: [], refused: [], references: [] });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM decision_log").get()).toEqual({ n: 0 });
    expect(await db.prepare("SELECT kind FROM threads").get()).toEqual({ kind: "discuss" });
    expect(changed).toContain("p");
  });

  it("discuss escape hatch: pack-miss triggers ONE bounded query, reply grounded in a returned id", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
    const queue = new Queue(db);
    const worker = new MediatorWorker(db, { tickMs: 20, jobTimeoutMs: 2000 });
    let discussCalls = 0;
    const spyDriver = new FakeDriver();
    const origDiscuss = spyDriver.discuss.bind(spyDriver);
    spyDriver.discuss = async (ctx, input) => {
      discussCalls++;
      return origDiscuss(ctx, input);
    };
    registerPipelines({ db, queue, worker, driverFor: () => spyDriver });
    worker.start();
    active = worker;
    const done = await queue.submit("p", "dana", { title: "shipped long ago", body: "b", evidence: [] });
    await db.prepare("UPDATE tasks SET state='DONE' WHERE id=?").run(done);
    const jobId = await worker.enqueue("p", "discuss", { message: "QUERY:tasks kind=DONE", from: "dana" });
    const result = JSON.parse((await worker.waitForJob(jobId, 3000)).result!);
    // Exactly one bounded round: first pass asked for the query, second grounded the reply.
    expect(discussCalls).toBe(2);
    // The real id survives id post-validation; the fabricated #999999 is blanked.
    expect(result.reply).toBe(`found #${done} (and phantom #?)`);
    expect(result.applied).toEqual([]);
    // The grounded task id mints a reference only when publicUrl is set (none here).
    expect(result.references).toEqual([]);
  });

  it("discuss escape hatch: packs suffice → no query, single discuss call", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
    const queue = new Queue(db);
    const worker = new MediatorWorker(db, { tickMs: 20, jobTimeoutMs: 2000 });
    let discussCalls = 0;
    const spyDriver = new FakeDriver();
    const origDiscuss = spyDriver.discuss.bind(spyDriver);
    spyDriver.discuss = async (ctx, input) => {
      discussCalls++;
      return origDiscuss(ctx, input);
    };
    registerPipelines({ db, queue, worker, driverFor: () => spyDriver });
    worker.start();
    active = worker;
    const jobId = await worker.enqueue("p", "discuss", { message: "what's next?", from: "dana" });
    const result = JSON.parse((await worker.waitForJob(jobId, 3000)).result!);
    expect(discussCalls).toBe(1);
    expect(result.reply).toBe("noted");
  });

  it("discuss: update_task rewrites title/body and logs an 'update' decision", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
    const queue = new Queue(db);
    const worker = new MediatorWorker(db, { tickMs: 20, jobTimeoutMs: 2000 });
    const stubDriver = {
      async discuss() {
        return {
          reply: "tightened it",
          actions: [{ action: "update_task" as const, task_id: 1, title: "sharper title", reason: "member asked for a rename" }],
          rationale: "r",
        };
      },
    };
    registerPipelines({ db, queue, worker, driverFor: () => stubDriver as never });
    worker.start();
    active = worker;
    const id = await queue.submit("p", "dana", { title: "vague", body: "original body", evidence: [] });
    const result = JSON.parse(
      (await worker.waitForJob(await worker.enqueue("p", "discuss", { message: "rename task 1", from: "dana" }), 3000)).result!,
    );
    expect(result.applied).toHaveLength(1);
    const brief = await queue.brief(id);
    expect(brief.title).toBe("sharper title");
    expect(brief.body).toBe("original body"); // untouched when the action omits body
    expect(await db.prepare("SELECT kind, rationale FROM decision_log").all()).toEqual([
      { kind: "update", rationale: "member asked for a rename" },
    ]);
  });

  it("reconcile: a completion whose PR text closes a now-redundant task", async () => {
    const { db, queue, worker } = await setup();
    active = worker;
    const done = await queue.submit("p", "dana", { title: "add limiter", body: "b", evidence: [] });
    const redundant = await queue.submit("p", "rui", { title: "throttle api", body: "b", evidence: [] });
    await queue.claimNext("p", "cc-1", DEFAULT_LEASE_TTL_MS);
    await queue.approvePlan(done, "plan");
    await queue.complete(done, "cc-1", "shipped", "https://github.com/x/y/pull/9");

    const jobId = await worker.enqueue("p", "reconcile", {
      taskId: done, agent: "cc-1",
      prUrl: "https://github.com/x/y/pull/9",
      prDescription: `Adds the limiter. close task ${redundant}: absorbed by this PR`,
    });
    const job = await worker.waitForJob(jobId, 3000);
    expect(job.status).toBe("done");
    const result = JSON.parse(job.result!);
    expect(result.applied).toEqual([
      { action: "close_task", task_id: redundant, reason: "absorbed by this PR" },
    ]);
    expect(result.refused).toEqual([]);
    const brief = await queue.brief(redundant);
    expect(brief.state).toBe("DONE");
    // Reconcile is autonomous mediator review — attribute to the mediator, not the coder or operator.
    expect(brief.result_summary).toBe("closed (mediator): absorbed by this PR");
    // same validation/apply path as discuss: decision logged, discuss thread recorded
    expect(await db.prepare("SELECT kind, task_id FROM decision_log").all()).toEqual([
      { kind: "close", task_id: redundant },
    ]);
    const discussThread = (await db
      .prepare("SELECT id, kind, task_id FROM threads WHERE kind='discuss'")
      .get<{ id: number; kind: string; task_id: number | null }>()) as {
      id: number; kind: string; task_id: number | null;
    };
    expect(discussThread).toMatchObject({ kind: "discuss", task_id: done });
    const msgs = (await db.prepare(
      "SELECT role, author, content FROM thread_messages WHERE thread_id=? ORDER BY id",
    ).all<{ role: string; author: string; content: string }>(discussThread.id));
    expect(msgs[0].role).toBe("coder");
    expect(msgs[0].author).toBe("cc-1");
    expect(msgs[0].content).toContain(`Coder cc-1 completed task #${done} 'add limiter'`);
    expect(msgs[0].content).toContain("https://github.com/x/y/pull/9");
    expect(msgs[0].content).toContain("Only act where the PR text clearly justifies it");
  });

  it("reconcile: validation refuses closing the just-completed (DONE) task itself", async () => {
    const { queue, worker } = await setup();
    active = worker;
    const done = await queue.submit("p", "dana", { title: "t", body: "b", evidence: [] });
    await queue.claimNext("p", "cc-1", DEFAULT_LEASE_TTL_MS);
    await queue.complete(done, "cc-1", "shipped", "https://github.com/x/y/pull/9");
    const jobId = await worker.enqueue("p", "reconcile", {
      taskId: done, agent: "cc-1",
      prUrl: "https://github.com/x/y/pull/9",
      prDescription: `close task ${done}: self-referential nonsense`,
    });
    const result = JSON.parse((await worker.waitForJob(jobId, 3000)).result!);
    expect(result.applied).toEqual([]);
    expect(result.refused).toEqual([
      { action: "close_task", task_id: done, reason: `task ${done} is DONE` },
    ]);
  });

  it("answer: wrong-premise ask lets the mediator close the asking CLAIMED task and release its lease", async () => {
    const { db, queue, worker } = await setup();
    active = worker;
    const id = await queue.submit("p", "dana", { title: "remove old endpoint", body: "b", evidence: [] });
    await queue.claimNext("p", "cc-1", DEFAULT_LEASE_TTL_MS);
    expect((await queue.brief(id)).state).toBe("CLAIMED");

    const jobId = await worker.enqueue("p", "answer", {
      taskId: id, question: `close task ${id}: endpoint was removed upstream`, agent: "cc-1",
    });
    const job = await worker.waitForJob(jobId, 3000);
    expect(job.status).toBe("done");
    const result = JSON.parse(job.result!);
    expect(result.escalated).toBe(false);
    expect(result.answer).toContain(`closed task ${id}`);
    expect(result.applied).toEqual([
      { action: "close_task", task_id: id, reason: "endpoint was removed upstream" },
    ]);
    expect(result.refused).toEqual([]);
    const brief = await queue.brief(id);
    expect(brief.state).toBe("DONE");
    expect(brief.lease_agent).toBeNull();
    expect(brief.lease_expires_at).toBeNull();
    expect(await db.prepare("SELECT kind FROM decision_log ORDER BY id").all()).toEqual([
      { kind: "close" }, { kind: "answer" },
    ]);
  });

  it("answer: ask-context actions on OTHER active tasks are still refused", async () => {
    const { queue, worker } = await setup();
    active = worker;
    const other = await queue.submit("p", "dana", { title: "other work", body: "b", evidence: [] });
    await queue.claimNext("p", "cc-2", DEFAULT_LEASE_TTL_MS); // cc-2 holds `other`
    const mine = await queue.submit("p", "dana", { title: "my task", body: "b", evidence: [] });
    await queue.claimNext("p", "cc-1", DEFAULT_LEASE_TTL_MS); // cc-1 holds `mine`

    const jobId = await worker.enqueue("p", "answer", {
      taskId: mine, question: `close task ${other}: seems redundant`, agent: "cc-1",
    });
    const result = JSON.parse((await worker.waitForJob(jobId, 3000)).result!);
    expect(result.applied).toEqual([]);
    expect(result.refused).toEqual([
      { action: "close_task", task_id: other, reason: `task ${other} is CLAIMED` },
    ]);
    expect((await queue.brief(other)).state).toBe("CLAIMED");
    expect((await queue.brief(other)).lease_agent).toBe("cc-2");
  });

  it("answer: direct answer vs escalation to a question row", async () => {
    const { db, queue, worker } = await setup();
    active = worker;
    const id = await queue.submit("p", "dana", { title: "t", body: "b", evidence: [] });
    await queue.claimNext("p", "cc-1", DEFAULT_LEASE_TTL_MS);

    const direct = await worker.enqueue("p", "answer", { taskId: id, question: "life?", agent: "cc-1" });
    expect(JSON.parse((await worker.waitForJob(direct, 3000)).result!)).toMatchObject({
      escalated: false, answer: "42",
    });

    const esc = await worker.enqueue("p", "answer", { taskId: id, question: "please escalate", agent: "cc-1" });
    expect(JSON.parse((await worker.waitForJob(esc, 3000)).result!)).toMatchObject({ escalated: true });
    expect(await db.prepare("SELECT question, asked_by, status FROM questions").all()).toEqual([
      { question: "please escalate", asked_by: "cc-1", status: "open" },
    ]);
    expect(await db.prepare("SELECT kind FROM decision_log ORDER BY id").all()).toEqual([
      { kind: "answer" }, { kind: "escalate" },
    ]);
  });
});

class SpyReviewDriver extends FakeDriver {
  contexts: MediatorContext[] = [];
  inputs: Parameters<FakeDriver["review"]>[1][] = [];
  override async review(ctx: MediatorContext, input: Parameters<FakeDriver["review"]>[1]) {
    this.contexts.push(ctx);
    this.inputs.push(input);
    return super.review(ctx, input);
  }
}

async function spySetup() {
  const db = await openTestDb();
  await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
  const queue = new Queue(db);
  const worker = new MediatorWorker(db, { tickMs: 20, jobTimeoutMs: 2000 });
  const spy = new SpyReviewDriver();
  registerPipelines({ db, queue, worker, driverFor: () => spy });
  worker.start();
  return { db, queue, worker, spy };
}

describe("session topology: context provenance", () => {
  it("a review job sees pull handles for the root and prior task conversations", async () => {
    const { queue, worker, spy } = await spySetup();
    active = worker;
    const id = await queue.submit("p", "dana", { title: "add cache", body: "cache hot paths", evidence: [] });
    await worker.waitForJob(await worker.enqueue("p", "groom", { taskId: id, submittedBy: "dana" }), 3000);
    await queue.claimNext("p", "cc-1", DEFAULT_LEASE_TTL_MS);
    await worker.waitForJob(await worker.enqueue("p", "answer", { taskId: id, question: "life?", agent: "cc-1" }), 3000);
    await worker.waitForJob(await worker.enqueue("p", "review", { taskId: id, plan: "solid", agent: "cc-1" }), 3000);

    expect(spy.contexts).toHaveLength(1);
    const lineage = spy.contexts[0].lineage!;
    expect(lineage.rootThreadId).toBeTypeOf("number");
    expect(lineage.ownThreadIds.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(lineage)).not.toContain("accepted as submitted");
    expect(JSON.stringify(lineage)).not.toContain("life?");
    expect(lineage.ancestors).toEqual([]);
    expect(lineage.siblings).toEqual([]);
    expect(spy.inputs).toHaveLength(1);
    expect(spy.inputs[0].task).toEqual({
      title: "add cache",
      body: "cache hot paths",
      groomingRationale: "accepted as submitted",
    });
  });

  it("fan-out: two tasks sharing one root see pull handles and sibling one-liners", async () => {
    const { db, queue, worker, spy } = await spySetup();
    active = worker;
    const parent = await queue.submit("p", "dana", { title: "split the work", body: "shared intent here", evidence: [] });
    const c1 = await queue.submit("p", "dana", { title: "child one", body: "do half", evidence: [], parentId: parent });
    const c2 = await queue.submit("p", "dana", {
      title: "child two", body: "SIBLING-SECRET-XYZ transcript text", evidence: [], parentId: parent,
    });
    await worker.waitForJob(await worker.enqueue("p", "groom", { taskId: c1, submittedBy: "dana" }), 3000);
    await worker.waitForJob(await worker.enqueue("p", "groom", { taskId: c2, submittedBy: "dana" }), 3000);
    await queue.claimNext("p", "cc-1", DEFAULT_LEASE_TTL_MS); // claims parent (lowest id)
    await worker.waitForJob(await worker.enqueue("p", "review", { taskId: c1, plan: "solid", agent: "cc-1" }), 3000);

    const lineage = spy.contexts[0].lineage!;
    expect(lineage.rootThreadId).toBeTypeOf("number");
    // the sibling appears as a title + one-liner…
    expect(lineage.siblings.map((s) => s.id)).toEqual([c2]);
    expect(lineage.siblings[0].title).toBe("child two");
    expect(typeof lineage.siblings[0].summary).toBe("string");
    // …and its transcript text is NOT in the context anywhere
    expect(JSON.stringify(spy.contexts[0])).not.toContain("SIBLING-SECRET-XYZ");
    expect(JSON.stringify(spy.contexts[0])).not.toContain("shared intent here");
    // the ancestor chain carries the parent as summary fields only
    expect(lineage.ancestors.map((a) => a.id)).toEqual([parent]);
    expect(lineage.ancestors[0].title).toBe("split the work");
    void db;
  });

  it("keeps long own-thread history pull-only while exposing every thread id", async () => {
    const { db, queue, worker, spy } = await spySetup();
    active = worker;
    const id = await queue.submit("p", "dana", { title: "t", body: "b", evidence: [] });
    const root = ((await db
      .prepare("SELECT root_thread_id FROM tasks WHERE id=?")
      .get<{ root_thread_id: number }>(id)) as { root_thread_id: number }).root_thread_id;
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      const th = (
        (await db
          .prepare(
            "INSERT INTO threads (project_id, kind, task_id, root_id, created_at) VALUES ('p','answer',?,?,?) RETURNING id",
          )
          .get<{ id: number }>(id, root, now))!
      ).id;
      await db.prepare(
        "INSERT INTO thread_messages (thread_id, role, author, content, created_at) VALUES (?,'coder','cc-1',?,?)",
      ).run(th, `MSG-${i} ${"x".repeat(600)}`, now);
    }
    await queue.claimNext("p", "cc-1", DEFAULT_LEASE_TTL_MS);
    await worker.waitForJob(await worker.enqueue("p", "review", { taskId: id, plan: "solid", agent: "cc-1" }), 3000);

    const { ownThreadIds } = spy.contexts[0].lineage!;
    // Root submission thread is linked via task_id (plus the 10 answer threads).
    expect(ownThreadIds).toHaveLength(11);
    expect(ownThreadIds).toContain(root);
    expect(JSON.stringify(spy.contexts[0])).not.toContain("MSG-0");
    expect(JSON.stringify(spy.contexts[0])).not.toContain("MSG-9");
  });

  it("closing a task writes 1-2 line mediator summaries onto its threads", async () => {
    const { db, queue, worker } = await spySetup();
    active = worker;
    const id = await queue.submit("p", "dana", { title: "doomed", body: "b", evidence: [] });
    await worker.waitForJob(await worker.enqueue("p", "groom", { taskId: id, submittedBy: "dana" }), 3000);
    expect(await db.prepare("SELECT summary FROM threads WHERE kind='groom'").get()).toEqual({ summary: null });
    await worker.waitForJob(
      await worker.enqueue("p", "discuss", { message: `close task ${id}: obsolete`, from: "dana" }),
      3000,
    );
    const { summary } = (await db
      .prepare("SELECT summary FROM threads WHERE kind='groom'")
      .get<{ summary: string }>()) as { summary: string };
    expect(summary).toContain("accept");
    expect(summary.split("\n").length).toBeLessThanOrEqual(2);
  });

  it("reconcile (task completion) writes summaries onto the completed task's threads", async () => {
    const { db, queue, worker } = await spySetup();
    active = worker;
    const id = await queue.submit("p", "dana", { title: "ship it", body: "b", evidence: [] });
    await worker.waitForJob(await worker.enqueue("p", "groom", { taskId: id, submittedBy: "dana" }), 3000);
    await queue.claimNext("p", "cc-1", DEFAULT_LEASE_TTL_MS);
    await queue.approvePlan(id, "plan");
    await queue.complete(id, "cc-1", "shipped", "https://github.com/x/y/pull/9");
    await worker.waitForJob(
      await worker.enqueue("p", "reconcile", {
        taskId: id, agent: "cc-1",
        prUrl: "https://github.com/x/y/pull/9", prDescription: "Ships it.",
      }),
      3000,
    );
    const rows = await db
      .prepare("SELECT kind, summary FROM threads WHERE task_id=? ORDER BY id")
      .all<{ kind: string; summary: string | null }>(id);
    expect(rows.length).toBeGreaterThanOrEqual(2); // groom + reconcile's discuss thread
    for (const r of rows) {
      expect(r.summary, r.kind).toBeTruthy();
      expect(r.summary!.split("\n").length).toBeLessThanOrEqual(2);
    }
  });

  describe("rich thread capture (#45)", () => {
    it("stamps each step a strictly-increasing created_at", async () => {
      const { db, queue, worker } = await setup();
      active = worker;
      const id = await queue.submit("p", "dana", { title: "t", body: "b", evidence: [] });
      const jobId = await worker.enqueue("p", "groom", { taskId: id, submittedBy: "dana" });
      await worker.waitForJob(jobId, 3000);
      const rows = await db
        .prepare(
          "SELECT m.created_at AS ca FROM thread_messages m JOIN threads th ON th.id=m.thread_id WHERE th.kind='groom' ORDER BY m.id",
        )
        .all<{ ca: number }>();
      expect(rows.length).toBe(2);
      expect(rows[1].ca).toBeGreaterThan(rows[0].ca);
    });

    it("persists the mediator sidecar and accumulated per-job usage with the resolved model", async () => {
      const db = await openTestDb();
      await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
      const queue = new Queue(db);
      const worker = new MediatorWorker(db, { tickMs: 20, jobTimeoutMs: 2000 });
      const metaDriver = {
        async groom(_ctx: MediatorContext, s: Submission) {
          return { action: "accept" as const, title: s.title, body: s.body, priority: s.priority, rationale: "ok" };
        },
        takeMeta() {
          return { reasoning: "thought about it", model: "requested/model", usage: { promptTokens: 5, completionTokens: 6 } };
        },
        takeUsage() {
          return {
            promptTokens: 31,
            completionTokens: 17,
            cachedTokens: 19,
            cacheWriteTokens: 7,
            cacheDiscountUsd: 0.004,
            costUsd: 0.012,
            completionCount: 3,
            requestedModel: "openrouter/auto",
            resolvedModel: "test/resolved-model",
          };
        },
      };
      registerPipelines({ db, queue, worker, driverFor: () => metaDriver as never });
      worker.start();
      active = worker;
      const id = await queue.submit("p", "dana", { title: "cap", body: "b", evidence: [] });
      const jobId = await worker.enqueue("p", "groom", { taskId: id, submittedBy: "dana" });
      await worker.waitForJob(jobId, 3000);
      const row = (await db
        .prepare(
          "SELECT reasoning, structured, model, usage FROM thread_messages WHERE role='mediator' ORDER BY id DESC LIMIT 1",
        )
        .get<{ reasoning: string; structured: string; model: string; usage: string }>()) as {
        reasoning: string; structured: string; model: string; usage: string;
      };
      expect(row.reasoning).toBe("thought about it");
      expect(row.model).toBe("test/resolved-model");
      expect(JSON.parse(row.usage)).toMatchObject({ promptTokens: 31, completionTokens: 17, cachedTokens: 19, completionCount: 3 });
      expect(JSON.parse(row.structured)).toMatchObject({ action: "accept" });
      expect(await db.prepare(
        "SELECT job_id, project_id, kind, requested_model, resolved_model, prompt_tokens, completion_tokens, cached_tokens, cache_write_tokens, cache_discount_usd, cost_usd, completion_count FROM mediator_usage WHERE job_id=?",
      ).get(jobId)).toEqual({
        job_id: jobId,
        project_id: "p",
        kind: "groom",
        requested_model: "openrouter/auto",
        resolved_model: "test/resolved-model",
        prompt_tokens: 31,
        completion_tokens: 17,
        cached_tokens: 19,
        cache_write_tokens: 7,
        cache_discount_usd: 0.004,
        cost_usd: 0.012,
        completion_count: 3,
      });
      const usageAt = (await db.prepare("SELECT created_at FROM mediator_usage WHERE job_id=?").get<{ created_at: number }>(jobId))!.created_at;
      const dayStart = Math.floor(usageAt / 86_400_000) * 86_400_000;
      expect(await db.prepare(
        "SELECT SUM(cost_usd) AS cost_usd, CAST(SUM(completion_count) AS INTEGER) AS completion_count FROM mediator_usage WHERE project_id=? AND created_at>=? AND created_at<?",
      ).get("p", dayStart, dayStart + 86_400_000)).toEqual({ cost_usd: 0.012, completion_count: 3 });
    });

    it("weaves an answered clarification into the groom transcript as ordered steps", async () => {
      const { db, queue, worker } = await setup();
      active = worker;
      const id = await queue.submit("p", "dana", { title: "t", body: "b", evidence: [] });
      await db
        .prepare(
          "INSERT INTO questions (project_id, task_id, asked_by, question, answer, status, created_at) VALUES ('p', ?, 'mediator', ?, ?, 'answered', 1)",
        )
        .run(id, "which region?", "us-east");
      await worker.waitForJob(await worker.enqueue("p", "groom", { taskId: id, submittedBy: "dana" }), 3000);
      const msgs = await db
        .prepare(
          "SELECT m.role, m.author, m.content FROM thread_messages m JOIN threads th ON th.id=m.thread_id WHERE th.kind='groom' ORDER BY m.id",
        )
        .all<{ role: string; author: string; content: string }>();
      expect(msgs.map((m) => m.role)).toEqual(["human", "mediator", "human", "mediator"]);
      expect(msgs[1].content).toBe("which region?");
      expect(msgs[2].content).toBe("us-east");
    });
  });

  it("blankUncitedIds keeps grounded ids and blanks invented ones", () => {
    const allowed = new Set([7, 42]);
    const out = blankUncitedIds("Fixed in #7 (DEC-42). Also DEC-999, task 88, and #500.", allowed);
    expect(out).toContain("#7");
    expect(out).toContain("DEC-42");
    expect(out).toContain("DEC-?");
    expect(out).not.toContain("DEC-999");
    expect(out).not.toContain("#500");
    expect(out).not.toMatch(/task 88\b/);
  });

  it("discuss blanks an invented id in the model's reply before storing it", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
    const queue = new Queue(db);
    const worker = new MediatorWorker(db, { tickMs: 20, jobTimeoutMs: 2000 });
    const stubDriver = {
      async discuss() {
        return { reply: "Shipped in #1. See DEC-999 for the rest.", actions: [], rationale: "r" };
      },
    };
    registerPipelines({ db, queue, worker, driverFor: () => stubDriver as never });
    worker.start();
    active = worker;
    const id = await queue.submit("p", "dana", { title: "real task", body: "b", evidence: [] });
    const result = JSON.parse(
      (await worker.waitForJob(await worker.enqueue("p", "discuss", { message: "status?", from: "dana" }), 3000)).result!,
    );
    expect(result.reply).toContain(`#${id}`); // grounded id survives
    expect(result.reply).not.toContain("DEC-999"); // invented id blanked
    expect(result.reply).toContain("DEC-?");
  });

  // Groom validation guards (task #46): deterministic post-groom holds that
  // override an admitting decision the operator holds. The driver's output is
  // advisory — a FakeDriver "accept" for a research-only or held-scope shape
  // must still be bounced by the pipeline.
  describe("groom validation guards", () => {
    async function heldSetup(topics: string) {
      const { db, queue, worker } = await setup();
      const memory = new MemoryStore(db);
      await memory.upsert("p", {
        path: "conventions/held-scope.md",
        type: "Convention",
        title: "Held scope",
        description: "topics on hold",
        tags: ["hold"],
        body: topics,
      });
      return { db, queue, worker };
    }

    it("bounces a legacy ellipsis-only task the driver tried to accept", async () => {
      const { db, queue, worker } = await setup();
      active = worker;
      const id = await queue.submit("p", "dana", { title: "...", body: "…", evidence: [] });
      const job = await worker.waitForJob(
        await worker.enqueue("p", "groom", { taskId: id, submittedBy: "dana" }),
        3000,
      );
      expect(JSON.parse(job.result!)).toMatchObject({ action: "clarify" });
      expect((await queue.brief(id)).state).toBe("BLOCKED");
      const question = await db.prepare("SELECT question FROM questions WHERE task_id=?").get<{ question: string }>(id);
      expect(question?.question).toMatch(/concrete work/i);
      expect(question?.question).toMatch(/Recommended:/);
      expect(question?.question.match(/\?/g)).toHaveLength(1);
    });

    it("bounces an accept whose model rewrite is content-free", async () => {
      class EmptyRewriteDriver extends FakeDriver {
        override async groom() {
          return { action: "accept" as const, title: "...", body: " ", priority: 2, rationale: "empty rewrite" };
        }
      }
      const { db, queue, worker } = await setup(new EmptyRewriteDriver());
      active = worker;
      const id = await queue.submit("p", "dana", {
        title: "Keep this real title",
        body: "Implement a concrete change.",
        evidence: [],
      });
      const job = await worker.waitForJob(
        await worker.enqueue("p", "groom", { taskId: id, submittedBy: "dana" }),
        3000,
      );
      expect(JSON.parse(job.result!)).toMatchObject({ action: "clarify" });
      expect((await queue.brief(id)).state).toBe("BLOCKED");
      expect(await db.prepare("SELECT COUNT(*) AS n FROM questions WHERE task_id=?").get(id)).toEqual({ n: 1 });
    });

    it("bounces a research-only submission the driver tried to accept", async () => {
      const { db, queue, worker } = await setup();
      active = worker;
      const id = await queue.submit("p", "dana", {
        title: "Research current rate-limiter strategies",
        body: "Survey token-bucket vs leaky-bucket and report findings.",
        evidence: [],
      });
      const job = await worker.waitForJob(await worker.enqueue("p", "groom", { taskId: id, submittedBy: "dana" }), 3000);
      expect(job.status).toBe("done");
      expect(JSON.parse(job.result!)).toMatchObject({ action: "clarify" });
      const q = await db.prepare("SELECT question, asked_by, status FROM questions WHERE task_id=?").get<{ question: string; asked_by: string; status: string }>(id);
      expect(q?.asked_by).toBe("mediator");
      expect(q?.status).toBe("open");
      expect(q?.question).toMatch(/research/i);
      expect(q?.question).toMatch(/Recommended:/);
      expect(q?.question.match(/\?/g)).toHaveLength(1);
      expect((await queue.brief(id)).state).toBe("BLOCKED");
      expect((await db.prepare("SELECT kind FROM decision_log").all())).toEqual([{ kind: "clarify" }]);
    });

    it("accepts investigate-then-fix work (names an implementation change)", async () => {
      const { db, queue, worker } = await setup();
      active = worker;
      const id = await queue.submit("p", "dana", {
        title: "Investigate then fix the flaky upload test",
        body: "Investigate the flake, then fix the race in the upload retry.",
        evidence: [],
      });
      const job = await worker.waitForJob(await worker.enqueue("p", "groom", { taskId: id, submittedBy: "dana" }), 3000);
      expect(JSON.parse(job.result!)).toMatchObject({ action: "accept" });
      const n = await db.prepare("SELECT COUNT(*) AS n FROM questions WHERE task_id=?").get<{ n: number }>(id);
      expect(n?.n).toBe(0);
    });

    it("accepts a concrete build task even when a sentence leads with a research verb", async () => {
      // Tightened firing (#51): research-only fires only when the ENTIRE
      // deliverable is open-ended research. A submission with a concrete build
      // core (reduce the image size) must not be bounced just because a
      // sentence opens with "Survey".
      const { db, queue, worker } = await setup();
      active = worker;
      const id = await queue.submit("p", "dana", {
        title: "Reduce the worker Docker image size",
        body: "Survey the current layers, then switch the final stage to prod-only installs.",
        evidence: [],
      });
      const job = await worker.waitForJob(await worker.enqueue("p", "groom", { taskId: id, submittedBy: "dana" }), 3000);
      expect(JSON.parse(job.result!)).toMatchObject({ action: "accept" });
      const n = await db.prepare("SELECT COUNT(*) AS n FROM questions WHERE task_id=?").get<{ n: number }>(id);
      expect(n?.n).toBe(0);
    });

    it("bounces a held-scope submission (the #39 better-auth shape)", async () => {
      const { db, queue, worker } = await heldSetup("- auth\n- phase-D");
      active = worker;
      const id = await queue.submit("p", "andrew", {
        title: "Research and integrate better-auth",
        body: "Add better-auth for OAuth login.",
        evidence: [],
      });
      const job = await worker.waitForJob(await worker.enqueue("p", "groom", { taskId: id, submittedBy: "andrew" }), 3000);
      expect(JSON.parse(job.result!)).toMatchObject({ action: "clarify" });
      const q = await db.prepare("SELECT question FROM questions WHERE task_id=?").get<{ question: string }>(id);
      expect(q?.question).toMatch(/held|hold/i);
      expect(q?.question).toMatch(/Recommended:/);
      expect(q?.question.match(/\?/g)).toHaveLength(1);
      expect((await queue.brief(id)).state).toBe("BLOCKED");
    });

    it("lets a normal fix in held scope through", async () => {
      const { db, queue, worker } = await heldSetup("- auth");
      active = worker;
      const id = await queue.submit("p", "dana", {
        title: "fix: auth session cookie dropped on refresh",
        body: "Expected: session persists across refresh. Actual: cookie cleared. Repro: refresh while signed in.",
        evidence: [],
      });
      const job = await worker.waitForJob(await worker.enqueue("p", "groom", { taskId: id, submittedBy: "dana" }), 3000);
      expect(JSON.parse(job.result!)).toMatchObject({ action: "accept" });
      const n = await db.prepare("SELECT COUNT(*) AS n FROM questions WHERE task_id=?").get<{ n: number }>(id);
      expect(n?.n).toBe(0);
    });

    it("bounces an invisible backend-only feature the driver tried to accept (#72, the #64 shape)", async () => {
      const { db, queue, worker } = await setup();
      active = worker;
      const id = await queue.submit("p", "andrew", {
        title: "better-auth Phase 2 — swap the token backend",
        body: "Replace the auth backend behind the seam. Preserves the existing token flow; nothing visible changes for the human.",
        evidence: [],
      });
      const job = await worker.waitForJob(await worker.enqueue("p", "groom", { taskId: id, submittedBy: "andrew" }), 3000);
      expect(JSON.parse(job.result!)).toMatchObject({ action: "clarify" });
      const q = await db.prepare("SELECT question FROM questions WHERE task_id=?").get<{ question: string }>(id);
      expect(q?.question).toMatch(/visible|usable|working vertical/i);
      expect(q?.question).toMatch(/Recommended:/);
      expect(q?.question.match(/\?/g)).toHaveLength(1);
      expect((await queue.brief(id)).state).toBe("BLOCKED");
    });

    it("bounces a design-doc-only submission as a milestone, not a DONE feature (#72)", async () => {
      const { db, queue, worker } = await setup();
      active = worker;
      const id = await queue.submit("p", "andrew", {
        title: "docs: better-auth integration design",
        body: "Write the design doc describing the integration. No code ships; documents the design for a later phase.",
        evidence: [],
      });
      const job = await worker.waitForJob(await worker.enqueue("p", "groom", { taskId: id, submittedBy: "andrew" }), 3000);
      expect(JSON.parse(job.result!)).toMatchObject({ action: "clarify" });
      const q = await db.prepare("SELECT question FROM questions WHERE task_id=?").get<{ question: string }>(id);
      expect(q?.question).toMatch(/milestone|doc/i);
      expect(q?.question).toMatch(/Recommended:/);
      expect(q?.question.match(/\?/g)).toHaveLength(1);
      expect((await queue.brief(id)).state).toBe("BLOCKED");
    });

    it("accepts a usable-vertical feature that names visible delivery (#72 escape)", async () => {
      const { db, queue, worker } = await setup();
      active = worker;
      const id = await queue.submit("p", "andrew", {
        title: "Sign-in on the dashboard",
        body: "Add a sign-in page the human uses to log in; the dashboard renders their projects after sign-in. Preserves the existing token flow as a fallback.",
        evidence: [],
      });
      const job = await worker.waitForJob(await worker.enqueue("p", "groom", { taskId: id, submittedBy: "andrew" }), 3000);
      expect(JSON.parse(job.result!)).toMatchObject({ action: "accept" });
      const n = await db.prepare("SELECT COUNT(*) AS n FROM questions WHERE task_id=?").get<{ n: number }>(id);
      expect(n?.n).toBe(0);
    });

    it("lets a fix through even when it preserves existing behavior (#72 fix exemption)", async () => {
      const { db, queue, worker } = await setup();
      active = worker;
      const id = await queue.submit("p", "dana", {
        title: "fix: race in the token refresh path",
        body: "Expected: refresh succeeds under load. Actual: intermittent 401. Repro: hammer refresh. Fix preserves the existing token flow; nothing visible changes.",
        evidence: [],
      });
      const job = await worker.waitForJob(await worker.enqueue("p", "groom", { taskId: id, submittedBy: "dana" }), 3000);
      expect(JSON.parse(job.result!)).toMatchObject({ action: "accept" });
      const n = await db.prepare("SELECT COUNT(*) AS n FROM questions WHERE task_id=?").get<{ n: number }>(id);
      expect(n?.n).toBe(0);
    });

    it("accepts corrective/hardening work without fix: prefix (no invisible-slice reshape)", async () => {
      const { db, queue, worker } = await setup();
      active = worker;
      const cases = [
        {
          title: "markEvent missing on promoteAwaitingMerge path",
          body: "Gap fix: promoteAwaitingMerge must call markEvent like tools.ts complete. Backend-only; preserves existing DONE flow; nothing visible changes.",
        },
        {
          title: "Make coder_complete verification arg required",
          body: "Hardening: make the verification argument required. Backend-only schema change; no user-facing UI.",
        },
        {
          title: "Scorecard metric double-counts failed checks",
          body: "Bug fix in the aggregator under concurrent completion. Backend-only correctness; preserves existing dashboard layout.",
        },
        {
          title: "Sanitize Needs-You reason text",
          body: "Sanitization/scrub of human-facing attention reasons so attempt notes do not leak env names. Corrective info-disclosure fix.",
        },
      ];
      for (const c of cases) {
        const id = await queue.submit("p", "dana", { title: c.title, body: c.body, evidence: [] });
        const job = await worker.waitForJob(await worker.enqueue("p", "groom", { taskId: id, submittedBy: "dana" }), 3000);
        expect(JSON.parse(job.result!), c.title).toMatchObject({ action: "accept" });
        const n = await db.prepare("SELECT COUNT(*) AS n FROM questions WHERE task_id=?").get<{ n: number }>(id);
        expect(n?.n, c.title).toBe(0);
      }
    });

    it("pre-classifies fix/chore before the model (reshape FakeDriver never runs)", async () => {
      // Task #488: GLM can still emit invisible-slice reshape on backend fixes.
      // Route fix/chore before driver.groom so a reshape-only model cannot grill.
      class AlwaysReshapeDriver extends FakeDriver {
        override async groom() {
          return {
            action: "clarify" as const,
            question:
              "What visible, usable delivery should complete this backend-only feature slice? Recommended: reshape it as a working vertical.",
            rationale: "invisible/backend-only feature slice; reshape into a working vertical",
          };
        }
      }
      const db = await openTestDb();
      await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
      const queue = new Queue(db);
      const worker = new MediatorWorker(db, { tickMs: 20, jobTimeoutMs: 2000 });
      registerPipelines({ db, queue, worker, driverFor: () => new AlwaysReshapeDriver() });
      worker.start();
      active = worker;
      const id = await queue.submit("p", "dana", {
        title: "Bounded-retry stamp clears only on state change",
        body: "Fix: clear merge_probe_transient_since on a successful 304/unchanged tick. Stale stamp causes premature BLOCK. Backend-only; preserves existing AWAITING_MERGE flow.",
        evidence: [],
      });
      const job = await worker.waitForJob(await worker.enqueue("p", "groom", { taskId: id, submittedBy: "dana" }), 3000);
      expect(JSON.parse(job.result!)).toMatchObject({ action: "accept" });
      expect((await queue.brief(id)).grooming_rationale).toMatch(/pre-classified fix\/chore/i);
      const n = await db.prepare("SELECT COUNT(*) AS n FROM questions WHERE task_id=?").get<{ n: number }>(id);
      expect(n?.n).toBe(0);
    });

    it("never merges into a DONE task — falls back to accept", async () => {
      const { db, queue, worker } = await setup();
      active = worker;
      const done = await queue.submit("p", "dana", { title: "shipped work", body: "b", evidence: [] });
      await db.prepare("UPDATE tasks SET state='DONE' WHERE id=?").run(done);
      const dup = await queue.submit("p", "rui", { title: "dup", body: `MERGE:${done} same as shipped`, evidence: [] });
      const job = await worker.waitForJob(await worker.enqueue("p", "groom", { taskId: dup, submittedBy: "rui" }), 3000);
      expect(job.status).toBe("done");
      expect(JSON.parse(job.result!)).toMatchObject({ action: "accept", task_id: dup });
      expect((await queue.brief(dup)).state).toBe("QUEUED");
      expect((await queue.brief(dup)).grooming_rationale).toMatch(new RegExp(`refused ${done} \\(target_not_mergeable\\)`));
      // The DONE task is untouched and no merge decision was logged.
      expect((await db.prepare("SELECT state FROM tasks WHERE id=?").get<{ state: string }>(done))?.state).toBe("DONE");
      expect((await db.prepare("SELECT kind FROM decision_log").all())).not.toContainEqual({ kind: "merge" });
    });
  });
});

describe("dependency edges via the mediator (#57)", () => {
  it("groom accept with a DEPENDS:<A> marker records an ORDER edge — A is served first, but B is not gated (#75)", async () => {
    const { db, queue, worker } = await setup();
    active = worker;
    const a = await queue.submit("p", "dana", { title: "A", body: "first", evidence: [] });
    const b = await queue.submit("p", "dana", { title: "B", body: `second DEPENDS:${a}`, evidence: [] });
    const job = await worker.waitForJob(await worker.enqueue("p", "groom", { taskId: b, submittedBy: "dana" }), 3000);
    expect(job.status).toBe("done");
    expect(JSON.parse(job.result!)).toMatchObject({ action: "accept", task_id: b });
    expect(await unsatisfiedDeps(db, b)).toEqual([a]);
    // Order, not gate: A (all deps satisfied) is offered first, but B is STILL
    // claimable while A is only CLAIMED — nothing sits blocked on the edge.
    const claimed = await queue.claimNext("p", "cc-1", DEFAULT_LEASE_TTL_MS);
    expect(claimed?.id).toBe(a);
    expect((await queue.claimNext("p", "cc-2", DEFAULT_LEASE_TTL_MS))?.id).toBe(b);
  });

  it("a groom depends_on naming a nonexistent id is skipped without failing the job", async () => {
    const { db, queue, worker } = await setup();
    active = worker;
    const b = await queue.submit("p", "dana", { title: "B", body: "solo DEPENDS:9999", evidence: [] });
    const job = await worker.waitForJob(await worker.enqueue("p", "groom", { taskId: b, submittedBy: "dana" }), 3000);
    expect(job.status).toBe("done");
    expect(JSON.parse(job.result!)).toMatchObject({ action: "accept", task_id: b });
    expect(await unsatisfiedDeps(db, b)).toEqual([]); // invalid edge skipped
  });

  it("discuss add_dependency applies an order edge; a cycle-creating edge is refused, not crashed", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
    const queue = new Queue(db);
    const worker = new MediatorWorker(db, { tickMs: 20, jobTimeoutMs: 2000 });
    let call = 0;
    const stubDriver = {
      async discuss() {
        call += 1;
        // first call: add B->A; second call: attempt the cycle A->B
        const action =
          call === 1
            ? { action: "add_dependency" as const, dependent_task_id: 2, depends_on_task_id: 1, reason: "A before B" }
            : { action: "add_dependency" as const, dependent_task_id: 1, depends_on_task_id: 2, reason: "cycle" };
        return { reply: "ok", actions: [action], rationale: "r" };
      },
    };
    registerPipelines({ db, queue, worker, driverFor: () => stubDriver as never });
    worker.start();
    active = worker;
    const a = await queue.submit("p", "dana", { title: "A", body: "b", evidence: [] });
    const b = await queue.submit("p", "dana", { title: "B", body: "b", evidence: [] });
    expect(a).toBe(1);
    expect(b).toBe(2);

    const r1 = JSON.parse(
      (await worker.waitForJob(await worker.enqueue("p", "discuss", { message: "A before B", from: "dana" }), 3000)).result!,
    );
    expect(r1.applied).toHaveLength(1);
    expect(await unsatisfiedDeps(db, b)).toEqual([a]);

    const r2 = JSON.parse(
      (await worker.waitForJob(await worker.enqueue("p", "discuss", { message: "make a cycle", from: "dana" }), 3000)).result!,
    );
    expect(r2.applied).toEqual([]);
    expect(r2.refused[0].reason).toMatch(/cycle/);
  });

  describe("deferred work suppresses interrogation (#493)", () => {
    class QuestioningDriver extends FakeDriver {
      constructor(private readonly mode: "accept" | "clarify") {
        super();
      }
      override async groom(ctx: MediatorContext, s: Submission) {
        if (this.mode === "clarify") {
          return {
            action: "clarify" as const,
            question:
              "Where should the consent gate live? Recommended: sign-up only — keep sign-in free of the gate until legal confirms otherwise.",
            rationale: "need a product decision before coding",
            person_owned: true,
            project_questions: [
              "What ToS URL should SIWE present?",
              "Which SIWE approach should we use?",
            ],
            reasoning: `weighing submission "${s.title}" → clarify`,
          };
        }
        const base = await super.groom(ctx, s);
        if (base.action !== "accept") return base;
        return {
          ...base,
          project_questions: [
            "What ToS URL should SIWE present?",
            "Which SIWE approach should we use?",
          ],
        };
      }
    }

    it("does not raise project questions while grooming an INCUBATING (warm_for) task", async () => {
      const db = await openTestDb();
      await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
      const queue = new Queue(db);
      const worker = new MediatorWorker(db, { tickMs: 20, jobTimeoutMs: 2000 });
      registerPipelines({ db, queue, worker, driverFor: () => new QuestioningDriver("accept") });
      worker.start();
      active = worker;

      const id = await queue.submit("p", "dana", {
        title: "Consent gate for SIWE",
        body: "Add a consent gate before SIWE signing.",
        evidence: [],
        warmForMs: 60 * 60 * 1000,
      });
      expect((await queue.brief(id)).state).toBe("INCUBATING");

      const job = await worker.waitForJob(
        await worker.enqueue("p", "groom", { taskId: id, submittedBy: "dana" }),
        3000,
      );
      expect(job.status).toBe("done");
      expect(JSON.parse(job.result!)).toMatchObject({ action: "accept" });
      expect((await queue.brief(id)).state).toBe("INCUBATING");
      const open = await db
        .prepare("SELECT COUNT(*) AS n FROM questions WHERE project_id='p' AND status='open'")
        .get<{ n: number }>();
      expect(open?.n).toBe(0);
    });

    it("does not open clarify or project questions on INCUBATING work", async () => {
      const db = await openTestDb();
      await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
      const queue = new Queue(db);
      const worker = new MediatorWorker(db, { tickMs: 20, jobTimeoutMs: 2000 });
      registerPipelines({ db, queue, worker, driverFor: () => new QuestioningDriver("clarify") });
      worker.start();
      active = worker;

      const id = await queue.submit("p", "dana", {
        title: "Consent gate for SIWE",
        body: "CLARIFY: Where should the consent gate live? Recommended: sign-up only — keep sign-in free of the gate until legal confirms otherwise.",
        evidence: [],
        warmForMs: 60 * 60 * 1000,
      });
      const job = await worker.waitForJob(
        await worker.enqueue("p", "groom", { taskId: id, submittedBy: "dana" }),
        3000,
      );
      expect(JSON.parse(job.result!)).toMatchObject({
        action: "clarify_deferred",
        task_id: id,
        state: "INCUBATING",
      });
      expect((await queue.brief(id)).state).toBe("INCUBATING");
      const open = await db
        .prepare("SELECT COUNT(*) AS n FROM questions WHERE project_id='p' AND status='open'")
        .get<{ n: number }>();
      expect(open?.n).toBe(0);
    });

    it("does not raise questions when re-grooming an explicitly HELD task", async () => {
      const db = await openTestDb();
      await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
      const queue = new Queue(db);
      const worker = new MediatorWorker(db, { tickMs: 20, jobTimeoutMs: 2000 });
      registerPipelines({ db, queue, worker, driverFor: () => new QuestioningDriver("accept") });
      worker.start();
      active = worker;

      const id = await queue.submit("p", "dana", {
        title: "Deferred legal docs",
        body: "Draft ToS and Privacy for SIWE.",
        evidence: [],
      });
      await db
        .prepare(
          "UPDATE tasks SET state='HELD', hold_cause='explicit', result_summary=? WHERE id=?",
        )
        .run("held (explicit): parked by operator", id);

      const job = await worker.waitForJob(
        await worker.enqueue("p", "groom", { taskId: id, submittedBy: "dana" }),
        3000,
      );
      expect(job.status).toBe("done");
      expect((await queue.brief(id)).state).toBe("HELD");
      const open = await db
        .prepare("SELECT COUNT(*) AS n FROM questions WHERE project_id='p' AND status='open'")
        .get<{ n: number }>();
      expect(open?.n).toBe(0);
    });

    it("allows project questions on the seal groom at graduation", async () => {
      const db = await openTestDb();
      await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
      const queue = new Queue(db);
      const worker = new MediatorWorker(db, { tickMs: 20, jobTimeoutMs: 2000 });
      registerPipelines({ db, queue, worker, driverFor: () => new QuestioningDriver("accept") });
      worker.start();
      active = worker;

      const id = await queue.submit("p", "dana", {
        title: "Consent gate for SIWE",
        body: "Add a consent gate before SIWE signing.",
        evidence: [],
        warmForMs: 60 * 60 * 1000,
      });
      await db.prepare("UPDATE tasks SET incubate_until=? WHERE id=?").run(Date.now() - 1, id);

      await vi.waitFor(async () => expect((await queue.brief(id)).state).toBe("QUEUED"), { timeout: 3000 });
      const open = await db
        .prepare(
          "SELECT question FROM questions WHERE project_id='p' AND status='open' AND task_id IS NULL ORDER BY id",
        )
        .all<{ question: string }>();
      expect(open.map((row) => row.question)).toEqual([
        "What ToS URL should SIWE present?",
        "Which SIWE approach should we use?",
      ]);
    });
  });
});
