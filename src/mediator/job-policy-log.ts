import type { Db } from "../db.js";

export type JobPolicyDifficulty = "simple" | "medium" | "hard";
export type JobPolicyEffort = "none" | "low" | "high" | "xhigh" | "enabled" | "budgeted";
export type JobPolicyOutcome = "ok" | "fail" | "retry";
export type JobPolicyQualitySignal = "rejected" | "steered" | "reopened";
export type JobPolicyRolloutArm = "flat" | "routed";

export interface JobPolicyInvocationKey {
  jobId: number;
  attempt: number;
  invocation: number;
}

export interface JobPolicyInvocationStart extends JobPolicyInvocationKey {
  projectId: string;
  taskId: number | null;
  /** The real durable job kind. Kept open-ended so adding a worker kind needs no CHECK rebuild. */
  kind: string;
  classifiedDifficulty: JobPolicyDifficulty | null;
  model: string;
  effort: JobPolicyEffort;
  maxTokens: number;
  rolloutArm: JobPolicyRolloutArm;
  startedAt: number;
}

export interface JobPolicyInvocationFinish {
  outcome: JobPolicyOutcome;
  finishedAt: number;
  tokensIn: number;
  tokensOut: number;
}

/**
 * Dialect-neutral persistence for the policy actually applied to model calls.
 * Every method composes with the Db transaction seam: callers may use it alone
 * or inside the worker's guarded job-transition transaction.
 */
export class JobPolicyLog {
  constructor(private readonly db: Db) {}

  /** Reserve an immutable invocation identity. Duplicate delivery is a no-op. */
  async start(input: JobPolicyInvocationStart): Promise<boolean> {
    const inserted = await this.db.prepare(
      `INSERT INTO job_policy_log (
         project_id, job_id, task_id, attempt, invocation, kind,
         classified_difficulty, model, effort, max_tokens, rollout_arm,
         started_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(job_id, attempt, invocation) DO NOTHING`,
    ).run(
      input.projectId,
      input.jobId,
      input.taskId,
      input.attempt,
      input.invocation,
      input.kind,
      input.classifiedDifficulty,
      input.model,
      input.effort,
      input.maxTokens,
      input.rolloutArm,
      input.startedAt,
      input.startedAt,
      input.startedAt,
    );
    return inserted.changes === 1;
  }

  /** Finalize once. A duplicate/stale terminal callback cannot rewrite history. */
  async finish(key: JobPolicyInvocationKey, result: JobPolicyInvocationFinish): Promise<boolean> {
    const updated = await this.db.prepare(
      `UPDATE job_policy_log
          SET latency_ms=? - started_at, tokens_in=?, tokens_out=?, outcome=?, finished_at=?, updated_at=?
        WHERE job_id=? AND attempt=? AND invocation=? AND outcome IS NULL`,
    ).run(
      result.finishedAt,
      result.tokensIn,
      result.tokensOut,
      result.outcome,
      result.finishedAt,
      result.finishedAt,
      key.jobId,
      key.attempt,
      key.invocation,
    );
    return updated.changes === 1;
  }

  /**
   * Apply the authoritative worker outcome to every provider call in an
   * attempt. This intentionally supersedes a call-level `ok`/`fail`: a later
   * pipeline error makes otherwise-successful calls part of a retried or
   * failed durable attempt.
   */
  async markAttemptOutcome(
    jobId: number,
    attempt: number,
    outcome: "fail" | "retry",
    finishedAt = Date.now(),
  ): Promise<number> {
    const updated = await this.db.prepare(
      `UPDATE job_policy_log
          SET latency_ms=COALESCE(latency_ms, ? - started_at),
              outcome=?, finished_at=COALESCE(finished_at, ?), updated_at=?
        WHERE job_id=? AND attempt=?`,
    ).run(finishedAt, outcome, finishedAt, finishedAt, jobId, attempt);
    return updated.changes;
  }

  /** Attach the first downstream quality signal; later callbacks are no-ops. */
  async markQuality(
    key: JobPolicyInvocationKey,
    signal: JobPolicyQualitySignal,
    signaledAt: number,
  ): Promise<boolean> {
    const updated = await this.db.prepare(
      `UPDATE job_policy_log
          SET quality_signal=?, quality_signaled_at=?, updated_at=?
        WHERE job_id=? AND attempt=? AND invocation=? AND quality_signal IS NULL`,
    ).run(
      signal,
      signaledAt,
      signaledAt,
      key.jobId,
      key.attempt,
      key.invocation,
    );
    return updated.changes === 1;
  }

  /** Attach a downstream signal to the latest successful, unsignaled task call. */
  async markQualityForTask(
    taskId: number,
    signal: JobPolicyQualitySignal,
    signaledAt = Date.now(),
  ): Promise<boolean> {
    return this.db.transaction(async () => {
      const key = await this.db.prepare(
        `SELECT job_id, attempt, invocation
           FROM job_policy_log
          WHERE task_id=? AND outcome='ok' AND quality_signal IS NULL
          ORDER BY finished_at DESC, job_id DESC, attempt DESC, invocation DESC
          LIMIT 1`,
      ).get<{ job_id: number; attempt: number; invocation: number }>(taskId);
      if (!key) return false;
      return this.markQuality({
        jobId: key.job_id,
        attempt: key.attempt,
        invocation: key.invocation,
      }, signal, signaledAt);
    });
  }

}
