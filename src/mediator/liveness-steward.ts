/**
 * Mediator liveness steward: detect stale/failed groom work, retry, escalate,
 * and raise a durable alert when automation cannot resolve.
 *
 * Timing defaults from jobTimeoutMs (same family as worker claim stuck cutoff).
 * Progress is DB-authoritative via jobs rows + decision_log alerts.
 *
 * Fresh QUEUED tasks with no job yet are owned by the normal submit→groom path.
 * Null grooming_rationale alone is never "stale" — that would re-enqueue every tick.
 */

import type { Db } from "../db/driver.js";
import type { MediatorWorker } from "./worker.js";

/** Uses allowed decision_log.kind 'escalate' for durable automation failures. */
export const STEWARD_ALERT_KIND = "escalate";

/** After this many failed groom attempts, escalate model tier once. */
export function stewardEscalateAfterAttempts(jobTimeoutMs: number): number {
  // Bound: at least 2 retries before escalate; scale mildly with timeout budget.
  return Math.max(2, Math.min(5, Math.floor(jobTimeoutMs / 60_000) || 2));
}

/** QUEUED with no successful groom after this age is considered stale. */
export function stewardStaleQueuedMs(jobTimeoutMs: number): number {
  return Math.max(jobTimeoutMs, 2 * jobTimeoutMs);
}

export interface StewardTickResult {
  retried: number[];
  escalated: number[];
  alerted: number[];
}

/**
 * One steward pass for a project. Idempotent: re-enqueue only when no pending/running
 * groom exists; alerts only once per task generation (decision_log dedupe by summary).
 */
export async function runLivenessStewardPass(
  db: Db,
  worker: MediatorWorker,
  projectId: string,
  jobTimeoutMs: number,
  now = Date.now(),
): Promise<StewardTickResult> {
  const result: StewardTickResult = { retried: [], escalated: [], alerted: [] };
  const staleMs = stewardStaleQueuedMs(jobTimeoutMs);
  const escalateAfter = stewardEscalateAfterAttempts(jobTimeoutMs);
  const cutoff = now - staleMs;

  // Age-stale QUEUED only (COALESCE so null queued_at uses updated_at — never
  // treat "missing queued_at" alone as infinite-stale; that re-enqueued every
  // fixture insert and hung human_status under postgres CI load).
  const candidates = await db
    .prepare(
      `SELECT id, title, queued_at, updated_at, grooming_rationale, submitted_by
         FROM tasks
        WHERE project_id = ?
          AND state = 'QUEUED'
          AND lease_agent IS NULL
          AND COALESCE(queued_at, updated_at) < ?`,
    )
    .all<{
      id: number;
      title: string;
      queued_at: number | null;
      updated_at: number;
      grooming_rationale: string | null;
      submitted_by: string;
    }>(projectId, cutoff);

  // Recent QUEUED with a failed/done-without-rationale groom (retry path without age wait).
  const recent = await db
    .prepare(
      `SELECT id, title, queued_at, updated_at, grooming_rationale, submitted_by
         FROM tasks
        WHERE project_id = ?
          AND state = 'QUEUED'
          AND lease_agent IS NULL
          AND COALESCE(queued_at, updated_at) >= ?`,
    )
    .all<{
      id: number;
      title: string;
      queued_at: number | null;
      updated_at: number;
      grooming_rationale: string | null;
      submitted_by: string;
    }>(projectId, cutoff);

  const byId = new Map<number, (typeof candidates)[number]>();
  for (const task of candidates) byId.set(task.id, task);
  for (const task of recent) byId.set(task.id, task);

  for (const task of byId.values()) {
    const latest = await db
      .prepare(
        `SELECT id, status, attempts, error FROM jobs
          WHERE project_id = ? AND kind = 'groom' AND payload LIKE ?
          ORDER BY id DESC LIMIT 1`,
      )
      .get<{ id: number; status: string; attempts: number; error: string | null }>(
        projectId,
        `%"taskId":${task.id}%`,
      );

    const active =
      latest && (latest.status === "pending" || latest.status === "running");
    if (active) continue;

    const attempts = latest?.attempts ?? 0;
    const aged = (task.queued_at ?? task.updated_at) < cutoff;
    const failed = latest?.status === "failed";
    const doneWithoutRationale = latest?.status === "done" && !task.grooming_rationale;
    // Already groomed (has rationale) and not failed — leave alone even if "aged"
    // (fixtures often use epoch timestamps that would otherwise re-enqueue forever).
    if (task.grooming_rationale && !failed && !doneWithoutRationale) continue;

    // Fresh task with no job: submit path owns it.
    if (!aged && !failed && !doneWithoutRationale) continue;
    if (!latest && !aged) continue;

    if (attempts >= escalateAfter + 2) {
      // Exhausted — durable alert, do not spin forever
      const summary = `liveness: task #${task.id} still unclaimable after ${attempts} groom attempts`;
      const existing = await db
        .prepare(
          `SELECT id FROM decision_log WHERE project_id=? AND task_id=? AND kind=? AND summary=? LIMIT 1`,
        )
        .get<{ id: number }>(projectId, task.id, STEWARD_ALERT_KIND, summary);
      if (!existing) {
        await db
          .prepare(
            `INSERT INTO decision_log (project_id, task_id, kind, summary, rationale, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            projectId,
            task.id,
            STEWARD_ALERT_KIND,
            summary,
            `Recovery: inspect groom errors, re-groom, or hold/reopen. last_error=${latest?.error ?? "none"}`,
            now,
          );
        result.alerted.push(task.id);
      }
      continue;
    }

    // Retry / escalate: re-enqueue groom (policy driver picks model; attempts on job track progress)
    await worker.findOrEnqueue(projectId, "groom", {
      taskId: task.id,
      submittedBy: task.submitted_by,
      steward: true,
      escalate: attempts >= escalateAfter,
    });
    if (attempts >= escalateAfter) result.escalated.push(task.id);
    else result.retried.push(task.id);
  }

  return result;
}
