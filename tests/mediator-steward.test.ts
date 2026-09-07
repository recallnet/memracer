import { describe, expect, it, vi } from "vitest";
import {
  runLivenessStewardPass,
  stewardEscalateAfterAttempts,
  stewardStaleQueuedMs,
  STEWARD_ALERT_KIND,
} from "../src/mediator/liveness-steward.js";
import { openDb } from "../src/db.js";
import type { MediatorWorker } from "../src/mediator/worker.js";

describe("liveness steward policy", () => {
  it("bounds escalate/stale from jobTimeoutMs without magic free-float", () => {
    expect(stewardEscalateAfterAttempts(60_000)).toBeGreaterThanOrEqual(2);
    expect(stewardStaleQueuedMs(30_000)).toBeGreaterThanOrEqual(30_000);
  });

  it("retries failed groom, escalates after threshold, alerts when exhausted", async () => {
    const db = openDb(":memory:");
    await db.prepare("INSERT INTO projects (id, name, repo) VALUES (?,?,?)").run("p", "P", "r/p");
    const now = 1_000_000;
    await db
      .prepare(
        `INSERT INTO tasks (id, project_id, title, body, priority, state, submitted_by, queued_at, updated_at, created_at)
         VALUES (1, 'p', 't', 'b', 0, 'QUEUED', 'ada', ?, ?, ?)`,
      )
      .run(now - 10_000_000, now - 10_000_000, now - 10_000_000);

    // Simulate many failed groom attempts
    await db
      .prepare(
        `INSERT INTO jobs (id, project_id, kind, payload, status, attempts, created_at, updated_at)
         VALUES (1, 'p', 'groom', ?, 'failed', 10, ?, ?)`,
      )
      .run(JSON.stringify({ taskId: 1, submittedBy: "ada" }), now - 1000, now - 1000);

    const enqueued: unknown[] = [];
    const worker = {
      findOrEnqueue: vi.fn(async (_p: string, kind: string, payload: unknown) => {
        enqueued.push({ kind, payload });
        return 99;
      }),
    } as unknown as MediatorWorker;

    const r1 = await runLivenessStewardPass(db, worker, "p", 60_000, now);
    // attempts=10 >= escalateAfter+2 → alert path
    expect(r1.alerted).toContain(1);
    const alert = await db
      .prepare("SELECT kind, summary FROM decision_log WHERE task_id=1")
      .get<{ kind: string; summary: string }>();
    expect(alert?.kind).toBe(STEWARD_ALERT_KIND);
    expect(alert?.summary).toMatch(/#1/);

    // Idempotent: second pass does not duplicate alert
    const r2 = await runLivenessStewardPass(db, worker, "p", 60_000, now);
    expect(r2.alerted).toEqual([]);
    const count = await db
      .prepare("SELECT COUNT(*) AS n FROM decision_log WHERE task_id=1 AND kind=?")
      .get<{ n: number }>(STEWARD_ALERT_KIND);
    expect(Number(count?.n)).toBe(1);
  });

  it("re-enqueues groom on stale QUEUED without spinning when job already pending", async () => {
    const db = openDb(":memory:");
    await db.prepare("INSERT INTO projects (id, name, repo) VALUES (?,?,?)").run("p", "P", "r/p");
    const now = 2_000_000;
    await db
      .prepare(
        `INSERT INTO tasks (id, project_id, title, body, priority, state, submitted_by, queued_at, updated_at, created_at)
         VALUES (2, 'p', 'stale', 'b', 0, 'QUEUED', 'ada', ?, ?, ?)`,
      )
      .run(now - 10_000_000, now - 10_000_000, now - 10_000_000);

    const worker = {
      findOrEnqueue: vi.fn(async () => 7),
    } as unknown as MediatorWorker;

    const r = await runLivenessStewardPass(db, worker, "p", 60_000, now);
    expect(r.retried).toContain(2);
    expect(worker.findOrEnqueue).toHaveBeenCalledTimes(1);

    // Active pending groom → skip
    await db
      .prepare(
        `INSERT INTO jobs (project_id, kind, payload, status, attempts, created_at, updated_at)
         VALUES ('p', 'groom', ?, 'pending', 1, ?, ?)`,
      )
      .run(JSON.stringify({ taskId: 2, submittedBy: "ada" }), now, now);
    (worker.findOrEnqueue as ReturnType<typeof vi.fn>).mockClear();
    const r2 = await runLivenessStewardPass(db, worker, "p", 60_000, now);
    expect(r2.retried).toEqual([]);
    expect(worker.findOrEnqueue).not.toHaveBeenCalled();
  });

  it("does not re-enqueue fresh QUEUED tasks with no job (submit path owns them)", async () => {
    const db = openDb(":memory:");
    await db.prepare("INSERT INTO projects (id, name, repo) VALUES (?,?,?)").run("p", "P", "r/p");
    const now = 3_000_000;
    await db
      .prepare(
        `INSERT INTO tasks (id, project_id, title, body, priority, state, submitted_by, queued_at, updated_at, created_at)
         VALUES (3, 'p', 'fresh', 'b', 0, 'QUEUED', 'ada', ?, ?, ?)`,
      )
      .run(now - 1_000, now - 1_000, now - 1_000);
    const worker = {
      findOrEnqueue: vi.fn(async () => 8),
    } as unknown as MediatorWorker;
    const r = await runLivenessStewardPass(db, worker, "p", 60_000, now);
    expect(r.retried).toEqual([]);
    expect(worker.findOrEnqueue).not.toHaveBeenCalled();
  });
});
