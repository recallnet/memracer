import { describe, expect, it } from "vitest";
import { openDb, renderSchema, type Db } from "../src/db.js";
import {
  JobPolicyLog,
  type JobPolicyInvocationStart,
} from "../src/mediator/job-policy-log.js";
import { openPgliteDb } from "./helpers/pglite.js";

const backends: { name: string; open: () => Promise<Db> }[] = [
  { name: "sqlite", open: async () => openDb(":memory:") },
  { name: "postgres", open: () => openPgliteDb() },
];

async function seed(db: Db): Promise<{ jobId: number; taskId: number }> {
  await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
  const task = await db.prepare(
    `INSERT INTO tasks (project_id, title, body, submitted_by, created_at, updated_at)
     VALUES ('p','Task','body','dana',1,1) RETURNING id`,
  ).get<{ id: number }>();
  const job = await db.prepare(
    `INSERT INTO jobs (project_id, kind, payload, status, attempts, started_at, created_at, updated_at)
     VALUES ('p','groom','{}','running',1,10,1,10) RETURNING id`,
  ).get<{ id: number }>();
  return { jobId: job!.id, taskId: task!.id };
}

function invocation(jobId: number, taskId: number): JobPolicyInvocationStart {
  return {
    jobId,
    projectId: "p",
    taskId,
    attempt: 1,
    invocation: 1,
    kind: "groom",
    classifiedDifficulty: "simple",
    model: "google/gemini-3.1-flash-lite",
    effort: "none",
    maxTokens: 8192,
    rolloutArm: "routed",
    startedAt: 100,
  };
}

describe.each(backends)("job policy persistence ($name)", ({ open }) => {
  it("records and idempotently finalizes one routed invocation", async () => {
    const db = await open();
    const { jobId, taskId } = await seed(db);
    const log = new JobPolicyLog(db);

    await log.start(invocation(jobId, taskId));
    await log.start(invocation(jobId, taskId));
    await db.exec(renderSchema(db.dialect));
    await db.exec(renderSchema(db.dialect));
    expect(await db.prepare("SELECT COUNT(*) AS n FROM job_policy_log").get()).toEqual({ n: 1 });

    expect(await log.finish({ jobId, attempt: 1, invocation: 1 }, {
      outcome: "ok",
      finishedAt: 175,
      tokensIn: 120,
      tokensOut: 34,
    })).toBe(true);
    expect(await log.finish({ jobId, attempt: 1, invocation: 1 }, {
      outcome: "fail",
      finishedAt: 200,
      tokensIn: 999,
      tokensOut: 999,
    })).toBe(false);

    expect(await db.prepare(
      `SELECT project_id, job_id, task_id, attempt, invocation, kind,
              classified_difficulty, model, effort, max_tokens, rollout_arm,
              latency_ms, tokens_in, tokens_out, outcome, quality_signal,
              started_at, finished_at, created_at, updated_at
         FROM job_policy_log`,
    ).get()).toEqual({
      project_id: "p",
      job_id: jobId,
      task_id: taskId,
      attempt: 1,
      invocation: 1,
      kind: "groom",
      classified_difficulty: "simple",
      model: "google/gemini-3.1-flash-lite",
      effort: "none",
      max_tokens: 8192,
      rollout_arm: "routed",
      latency_ms: 75,
      tokens_in: 120,
      tokens_out: 34,
      outcome: "ok",
      quality_signal: null,
      started_at: 100,
      finished_at: 175,
      created_at: 100,
      updated_at: 175,
    });
    await db.close();
  });

  it("preserves retry attempts and multiple consolidation invocations", async () => {
    const db = await open();
    const { jobId, taskId } = await seed(db);
    const log = new JobPolicyLog(db);
    const first = invocation(jobId, taskId);
    await log.start(first);
    await log.finish({ jobId, attempt: 1, invocation: 1 }, {
      outcome: "retry", finishedAt: 120, tokensIn: 10, tokensOut: 2,
    });
    await log.start({
      ...first,
      attempt: 2,
      invocation: 1,
      kind: "consolidate",
      classifiedDifficulty: null,
      startedAt: 200,
    });
    await log.start({
      ...first,
      attempt: 2,
      invocation: 2,
      kind: "consolidate",
      classifiedDifficulty: null,
      startedAt: 210,
    });
    await log.finish({ jobId, attempt: 2, invocation: 1 }, {
      outcome: "ok", finishedAt: 230, tokensIn: 20, tokensOut: 4,
    });
    await log.finish({ jobId, attempt: 2, invocation: 2 }, {
      outcome: "ok", finishedAt: 250, tokensIn: 30, tokensOut: 6,
    });
    expect(await db.prepare(
      "SELECT attempt, invocation, outcome FROM job_policy_log ORDER BY attempt, invocation",
    ).all()).toEqual([
      { attempt: 1, invocation: 1, outcome: "retry" },
      { attempt: 2, invocation: 1, outcome: "ok" },
      { attempt: 2, invocation: 2, outcome: "ok" },
    ]);
    await db.close();
  });

  it("marks one quality signal without erasing the first downstream signal", async () => {
    const db = await open();
    const { jobId, taskId } = await seed(db);
    const log = new JobPolicyLog(db);
    await log.start(invocation(jobId, taskId));
    expect(await log.markQuality({ jobId, attempt: 1, invocation: 1 }, "steered", 180)).toBe(true);
    expect(await log.markQuality({ jobId, attempt: 1, invocation: 1 }, "reopened", 190)).toBe(false);
    expect(await db.prepare(
      "SELECT quality_signal, quality_signaled_at, updated_at FROM job_policy_log",
    ).get()).toEqual({ quality_signal: "steered", quality_signaled_at: 180, updated_at: 180 });
    await db.close();
  });

  it("makes the worker outcome authoritative over completed invocations", async () => {
    const db = await open();
    const { jobId, taskId } = await seed(db);
    const log = new JobPolicyLog(db);
    const first = invocation(jobId, taskId);
    await log.start(first);
    await log.start({ ...first, invocation: 2, startedAt: 110 });
    await log.finish({ jobId, attempt: 1, invocation: 1 }, {
      outcome: "fail", finishedAt: 125, tokensIn: 10, tokensOut: 2,
    });
    expect(await log.markAttemptOutcome(jobId, 1, "retry", 150)).toBe(2);
    expect(await db.prepare(
      "SELECT invocation, latency_ms, outcome, finished_at FROM job_policy_log ORDER BY invocation",
    ).all()).toEqual([
      { invocation: 1, latency_ms: 25, outcome: "retry", finished_at: 125 },
      { invocation: 2, latency_ms: 40, outcome: "retry", finished_at: 150 },
    ]);
    await db.close();
  });

  it("attaches downstream quality to the latest successful invocation for a task", async () => {
    const db = await open();
    const { jobId, taskId } = await seed(db);
    const log = new JobPolicyLog(db);
    const first = invocation(jobId, taskId);
    await log.start(first);
    await log.finish({ jobId, attempt: 1, invocation: 1 }, {
      outcome: "ok", finishedAt: 120, tokensIn: 10, tokensOut: 2,
    });
    await log.start({ ...first, invocation: 2, startedAt: 130 });
    await log.finish({ jobId, attempt: 1, invocation: 2 }, {
      outcome: "ok", finishedAt: 140, tokensIn: 11, tokensOut: 3,
    });
    expect(await log.markQualityForTask(taskId, "reopened", 180)).toBe(true);
    expect(await log.markQualityForTask(taskId, "steered", 190)).toBe(true);
    expect(await db.prepare(
      "SELECT invocation, quality_signal FROM job_policy_log ORDER BY invocation",
    ).all()).toEqual([
      { invocation: 1, quality_signal: "steered" },
      { invocation: 2, quality_signal: "reopened" },
    ]);
    await db.close();
  });

  it("enforces policy enums, positive ordinals, and parent relationships", async () => {
    const db = await open();
    const { jobId, taskId } = await seed(db);
    const log = new JobPolicyLog(db);
    await expect(log.start({ ...invocation(jobId, taskId), effort: "medium" as "high" })).rejects.toThrow();
    await expect(log.start({ ...invocation(jobId, taskId), attempt: 0 })).rejects.toThrow();
    await expect(log.start({ ...invocation(jobId, taskId), jobId: jobId + 999 })).rejects.toThrow();
    await db.close();
  });
});
