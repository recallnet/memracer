import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import type { Db } from "./db.js";
import { QuestionLedger, type ProjectQuestionInput } from "./mediator/question-ledger.js";
import { ProjectKnowledgeState, isProjectKnowledgeDomain } from "./mediator/project-knowledge.js";
import { classifyTaskMerge, type MergeTaskSnapshot } from "./mediator/merge-safety.js";

export interface EvidenceInput {
  /** Server-owned row id, present on evidence read back from the queue. */
  id?: number;
  kind: "code" | "stacktrace" | "log" | "link" | "research";
  path?: string;
  lines?: string;
  snippet?: string;
  note?: string;
}

export interface EvidenceRecord extends EvidenceInput {
  id: number;
}

export interface SubmitInput {
  title: string;
  body: string;
  priority?: number;
  repo?: string;
  baseSha?: string;
  evidence: EvidenceInput[];
  parentId?: number;
  /**
   * When true with parentId, keep `submitted_by` as the filer instead of
   * reassigning authorship to the parent author (human follow-up default).
   * Used by coder mid-task findings so the reporting coder stays on the row.
   */
  preserveSubmitter?: boolean;
  /**
   * CI-fix open-child dedup key (#472). When set, the partial unique index
   * `idx_tasks_open_ci_fix` admits at most one non-DONE child per
   * (parent_id, ci_fix_key). Leave unset for ordinary submissions.
   */
  ciFixKey?: string;
  /**
   * Warming period (#61) in milliseconds. When set, the task is born
   * INCUBATING with incubate_until = now + warmForMs — invisible to coders,
   * counting down — instead of QUEUED. Parse a human spec with parseWarmFor.
   */
  warmForMs?: number;
}

export interface MergeAuditInput {
  rationale: string;
  citations?: unknown[];
  mode?: "groom" | "consolidate" | "internal";
}

export type TaskMergeResult =
  | { merged: true }
  | {
      merged: false;
      reason:
        | "same_task"
        | "source_not_mergeable"
        | "target_not_mergeable"
        | "scope_mismatch"
        | "weak_overlap";
    };

export interface IdempotentSubmitResult {
  id: number;
  created: boolean;
}

const WARM_PRESETS: Record<string, number> = {
  "1h": 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
  "1w": 7 * 24 * 60 * 60 * 1000,
};

/**
 * Parse a warming-period spec into milliseconds. Accepts the presets 1h/1d/1w
 * or an ISO-8601 duration (PnDTnHnMnS, e.g. "PT30M", "P2D", "P1W"). Throws on
 * anything else or a non-positive duration — a warm_for the submitter can't
 * have meant should surface as an error, not silently become QUEUED.
 */
export function parseWarmFor(spec: string): number {
  const trimmed = spec.trim();
  const preset = WARM_PRESETS[trimmed.toLowerCase()];
  if (preset) return preset;
  const iso =
    /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(trimmed);
  if (iso && trimmed.toUpperCase() !== "P" && trimmed.toUpperCase() !== "PT") {
    const [, w, d, h, m, s] = iso;
    const ms =
      (Number(w ?? 0) * 7 * 24 * 60 * 60 +
        Number(d ?? 0) * 24 * 60 * 60 +
        Number(h ?? 0) * 60 * 60 +
        Number(m ?? 0) * 60 +
        Number(s ?? 0)) *
      1000;
    if (ms > 0) return ms;
  }
  throw new Error(`invalid warm_for "${spec}" — use 1h/1d/1w or an ISO-8601 duration like PT30M`);
}

export interface TaskRow {
  id: number;
  project_id: string;
  title: string;
  body: string;
  priority: number;
  state: string;
  base_sha: string | null;
  repo: string | null;
  submitted_by: string;
  watermark: string | null;
  lease_agent: string | null;
  lease_expires_at: number | null;
  lease_ttl_ms?: number;
  result_summary: string | null;
  result_pr_url: string | null;
  result_pr_number: number | null;
  result_pr_description: string | null;
  pr_verification: string | null;
  pr_verification_etag: string | null;
  grooming_rationale: string | null;
  parent_id: number | null;
  root_thread_id: number | null;
  plan: string | null;
  plan_deadline: number | null;
  plan_approved_at: number | null;
  /** Warming graduation timestamp (#61); non-null only while state='INCUBATING'. */
  incubate_until: number | null;
  block_kind: BlockKind | null;
  block_requeue_at: number | null;
  hold_cause: HoldCause | null;
  /** Transition-only clock for the current QUEUED episode. */
  queued_at: number | null;
  queue_generation: number;
  /**
   * Predecessor task ids that are not yet DONE (#57). Order/display hint only
   * — never a claim gate. Populated by status()/brief().
   */
  waiting_on?: number[];
  /** Machine-readable operational disposition (derived; see operational-disposition.ts). */
  operational?: import("./operational-disposition.js").OperationalDisposition;
}

export type BlockKind = "human" | "dependency" | "infra_failure";
export type HoldCause = "conflict" | "question" | "dependency" | "explicit";
export const DEFAULT_INFRA_RETRY_MS = 5 * 60 * 1000;

export interface WorkPeek {
  project_id: string;
  title: string;
  priority: number;
}

export interface WorkAvailability {
  available_count: number;
  peek: WorkPeek[];
}

/**
 * Predecessor ids of a task that are not yet DONE (a missing predecessor row
 * counts as satisfied). A dependency is ORDER ONLY (#75): this is an advisory
 * DISPLAY/serve-order hint (surfaced as `waiting_on`), never a claim gate — a
 * task with unsatisfied predecessors is still claimable, just offered after
 * peers whose predecessors are all DONE.
 */
export async function unsatisfiedDeps(db: Db, taskId: number): Promise<number[]> {
  const rows = await db
    .prepare(
      `SELECT d.depends_on AS id FROM task_deps d JOIN tasks pre ON pre.id = d.depends_on
       WHERE d.task_id = ? AND pre.state <> 'DONE' ORDER BY d.depends_on`,
    )
    .all<{ id: number }>(taskId);
  return rows.map((r) => r.id);
}

/** Batch unsatisfied deps for many tasks (one query) — avoids N+1 in status(). */
export async function unsatisfiedDepsByTask(
  db: Db,
  taskIds: number[],
): Promise<Map<number, number[]>> {
  const out = new Map<number, number[]>();
  for (const id of taskIds) out.set(id, []);
  if (taskIds.length === 0) return out;
  const placeholders = taskIds.map(() => "?").join(",");
  const rows = await db
    .prepare(
      `SELECT d.task_id AS task_id, d.depends_on AS id
         FROM task_deps d JOIN tasks pre ON pre.id = d.depends_on
        WHERE d.task_id IN (${placeholders}) AND pre.state <> 'DONE'
        ORDER BY d.task_id, d.depends_on`,
    )
    .all<{ task_id: number; id: number }>(...taskIds);
  for (const row of rows) {
    const list = out.get(row.task_id) ?? [];
    list.push(row.id);
    out.set(row.task_id, list);
  }
  return out;
}

/**
 * True if adding edge dependent->dependsOn ("dependent depends on dependsOn")
 * would close a cycle: walk the predecessors of dependsOn; reaching dependent
 * means the new edge loops. O(edges), run once at insertion — never per-claim.
 */
async function edgeWouldCycle(db: Db, dependentId: number, dependsOnId: number): Promise<boolean> {
  const seen = new Set<number>();
  let frontier = [dependsOnId];
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const id of frontier) {
      if (id === dependentId) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      const preds = await db
        .prepare("SELECT depends_on AS id FROM task_deps WHERE task_id = ?")
        .all<{ id: number }>(id);
      for (const p of preds) next.push(p.id);
    }
    frontier = next;
  }
  return false;
}

/**
 * Insert edge dependentId->dependsOnId ("dependent depends on dependsOn").
 * Validates both tasks live in projectId, rejects self-edges and cycles.
 * Idempotent. Throws with a stated reason on any rejection.
 */
export async function insertDependency(
  db: Db,
  projectId: string,
  dependentId: number,
  dependsOnId: number,
): Promise<void> {
  if (dependentId === dependsOnId) throw new Error(`task ${dependentId} cannot depend on itself`);
  const both = await db
    .prepare("SELECT id FROM tasks WHERE id IN (?, ?) AND project_id = ?")
    .all<{ id: number }>(dependentId, dependsOnId, projectId);
  if (both.length !== 2) throw new Error(`both tasks must exist in project ${projectId}`);
  if (await edgeWouldCycle(db, dependentId, dependsOnId)) {
    throw new Error(`dependency ${dependentId}->${dependsOnId} would create a cycle`);
  }
  const exists = await db
    .prepare("SELECT 1 AS one FROM task_deps WHERE task_id = ? AND depends_on = ?")
    .get<{ one: number }>(dependentId, dependsOnId);
  if (!exists) {
    await db.prepare("INSERT INTO task_deps (task_id, depends_on) VALUES (?, ?)").run(dependentId, dependsOnId);
  }
}

/** Remove edge dependentId->dependsOnId. No-op when absent. */
export async function removeDependency(db: Db, dependentId: number, dependsOnId: number): Promise<void> {
  await db.prepare("DELETE FROM task_deps WHERE task_id = ? AND depends_on = ?").run(dependentId, dependsOnId);
}

export interface TaskNote {
  agent: string;
  note: string;
  created_at: number;
}

export interface TaskBrief extends TaskRow {
  evidence: EvidenceRecord[];
  attempts: { agent: string; outcome: string; notes: string | null }[];
  questions: { question: string; answer: string | null; answered_by: string | null; status: string; asked_by: string }[];
  /** the BRIEF_NOTES_LIMIT most recent progress notes, oldest first */
  notes: TaskNote[];
}

/** Cap on progress notes returned in a brief — keeps long-running tasks from bloating claims. */
export const BRIEF_NOTES_LIMIT = 20;

export const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000;
export const MAX_LEASE_TTL_MS = 120 * 60 * 1000;
export const LEASE_RECOVERY_GRACE_MS = 5 * 60 * 1000;

function boundedLeaseTtl(ttlMs: number): number {
  return Math.max(1, Math.min(Math.floor(ttlMs), MAX_LEASE_TTL_MS));
}

/** A claimed task must get a plan approved within this window or it requeues. */
export const PLAN_WINDOW_MS = 60 * 60 * 1000;

/** How long a released task stays invisible to the agent that released it. */
export const RELEASE_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * Dedup window: a resubmission of the same content by the same submitter
 * within this window is treated as a duplicate of the live task rather than
 * forking a new one. Outside it, the resubmission opens a fresh task — an
 * old idea coming back around is legitimately new work.
 */
export const DEDUP_WINDOW_MS = 10 * 60 * 1000;

export class Queue {
  private readonly events = new EventEmitter();
  private readonly questionLedger: QuestionLedger;

  constructor(private readonly db: Db) {
    this.events.setMaxListeners(0);
    this.questionLedger = new QuestionLedger(db);
  }

  /**
   * Content watermark for dedup: a sha256 of the submission's title+body after
   * normalizing away the differences that do not change intent — case,
   * surrounding/collapsed whitespace, and punctuation. Two submissions that
   * say the same thing with trivial reformatting share a watermark; a
   * different ask does not. Pure and deterministic (no clock, no ids).
   */
  static watermark(title: string, body: string): string {
    const normalize = (s: string) =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    return createHash("sha256").update(`${normalize(title)}\n${normalize(body)}`).digest("hex");
  }

  /**
   * Change signal: fired after any mutation to a project's queue-visible
   * state (tasks, leases, steers, questions). Mediator pipelines call
   * notifyChanged after their own decision_log/thread writes.
   */
  onChanged(listener: (projectId: string) => void): void {
    this.events.on("changed", listener);
  }

  offChanged(listener: (projectId: string) => void): void {
    this.events.removeListener("changed", listener);
  }

  changedListenerCount(): number {
    return this.events.listenerCount("changed");
  }

  notifyChanged(projectId: string): void {
    this.events.emit("changed", projectId);
  }

  /**
   * The root thread anchoring a submission: follow-up children inherit their
   * parent task's root (one shared root per submission lineage — fan-out
   * ready); a fresh submission mints a kind='submission' root thread whose
   * first human message carries the prompt verbatim (title + body +
   * evidence refs) — the short shared intent every later job reads.
   */
  private async rootThreadFor(
    projectId: string,
    submittedBy: string,
    input: SubmitInput,
    now: number,
  ): Promise<number> {
    if (input.parentId) {
      const parent = await this.db
        .prepare("SELECT root_thread_id FROM tasks WHERE id = ?")
        .get<{ root_thread_id: number | null }>(input.parentId);
      if (parent?.root_thread_id) return parent.root_thread_id;
    }
    const root = await this.db
      .prepare(
        "INSERT INTO threads (project_id, kind, task_id, root_id, created_at) VALUES (?, 'submission', NULL, NULL, ?) RETURNING id",
      )
      .get<{ id: number }>(projectId, now);
    const rootId = root!.id;
    const refs = input.evidence
      .map((ev) => `- [${ev.kind}] ${[ev.path, ev.lines, ev.note].filter(Boolean).join(" ") || ev.snippet || ""}`)
      .join("\n");
    const content = `${input.title}\n${input.body}${refs ? `\n\nEvidence:\n${refs}` : ""}`;
    await this.db
      .prepare("INSERT INTO thread_messages (thread_id, role, author, content, created_at) VALUES (?, 'human', ?, ?, ?)")
      .run(rootId, submittedBy, content, now);
    return rootId;
  }

  private async insertSubmission(
    projectId: string,
    submittedBy: string,
    input: SubmitInput,
    now: number,
  ): Promise<number> {
    // Human follow-ups credit the origin author (parent), not the filer —
    // otherwise human-role agents collapse authorship. System CI-fix children
    // keep submitted_by=system (and any future system-spawned children).
    // Coder findings pass preserveSubmitter so the reporting coder stays author.
    let author = submittedBy;
    if (
      input.parentId != null &&
      submittedBy !== "system" &&
      !input.ciFixKey &&
      !input.preserveSubmitter
    ) {
      const parent = await this.db
        .prepare("SELECT submitted_by FROM tasks WHERE id=? AND project_id=?")
        .get<{ submitted_by: string }>(input.parentId, projectId);
      if (parent?.submitted_by) author = parent.submitted_by;
    }
    const rootThreadId = await this.rootThreadFor(projectId, author, input, now);
    // Warming (#61): a warm_for submission is born INCUBATING with a
    // graduation clock; it stays off every coder surface (never QUEUED)
    // until the seal groom graduates it. A normal submission is QUEUED.
    const incubating = input.warmForMs != null && input.warmForMs > 0;
    const state = incubating ? "INCUBATING" : "QUEUED";
    const incubateUntil = incubating ? now + input.warmForMs! : null;
    const inserted = await this.db
      .prepare(
        `INSERT INTO tasks (project_id, title, body, priority, state, base_sha, repo, submitted_by, watermark, parent_id, root_thread_id, incubate_until, queued_at, queue_generation, ci_fix_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get<{ id: number }>(
        projectId,
        input.title,
        input.body,
        input.priority ?? 2,
        state,
        input.baseSha ?? null,
        input.repo ?? null,
        author,
        Queue.watermark(input.title, input.body),
        input.parentId ?? null,
        rootThreadId,
        incubateUntil,
        incubating ? null : now,
        incubating ? 0 : 1,
        input.ciFixKey ?? null,
        now,
        now,
      );
    // Bidirectional thread↔task link: a newly minted root submission thread
    // starts with task_id NULL (root is created before the task row). Backfill
    // only when no other task already claims this root (follow-ups share the
    // parent root and must not reassign it).
    const rootOwner = await this.db
      .prepare("SELECT id FROM tasks WHERE root_thread_id=? AND id<>? ORDER BY id ASC LIMIT 1")
      .get<{ id: number }>(rootThreadId, inserted!.id);
    if (!rootOwner) {
      await this.db
        .prepare("UPDATE threads SET task_id=? WHERE id=? AND task_id IS NULL")
        .run(inserted!.id, rootThreadId);
    }
    const evStmt = this.db.prepare(
      `INSERT INTO evidence (task_id, kind, path, lines, snippet, note) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const ev of input.evidence) {
      await evStmt.run(inserted!.id, ev.kind, ev.path ?? null, ev.lines ?? null, ev.snippet ?? null, ev.note ?? null);
    }
    return inserted!.id;
  }

  private signalSubmission(projectId: string, input: SubmitInput): void {
    // An incubating task is not claimable work yet — signal the dashboard
    // (countdown) but do not wake parked coder waiters. It gets its 'enqueued'
    // on graduation. A normal submission wakes waiters immediately.
    if (input.warmForMs == null || input.warmForMs <= 0) this.events.emit("enqueued", projectId);
    this.notifyChanged(projectId);
  }

  async submit(projectId: string, submittedBy: string, input: SubmitInput): Promise<number> {
    const taskId = await this.db.transaction(() =>
      this.insertSubmission(projectId, submittedBy, input, Date.now()),
    );
    this.signalSubmission(projectId, input);
    return taskId;
  }

  async findSubmissionByKey(
    projectId: string,
    submittedBy: string,
    idempotencyKey: string,
  ): Promise<number | null> {
    const row = await this.db
      .prepare(
        `SELECT s.task_id FROM submission_idempotency s
         JOIN tasks t ON t.id=s.task_id AND t.project_id=s.project_id
         WHERE s.project_id=? AND s.submitted_by=? AND s.idempotency_key=?`,
      )
      .get<{ task_id: number | null }>(projectId, submittedBy, idempotencyKey);
    return row?.task_id ?? null;
  }

  async rememberSubmissionKey(
    projectId: string,
    submittedBy: string,
    idempotencyKey: string,
    taskId: number,
  ): Promise<number> {
    return this.db.transaction(async () => {
      // Participate in the same task-row lock as merge. If this writer wins,
      // merge later retargets the mapping; if merge won, the deleted id cannot
      // be published after its retarget sweep.
      const reserved = await this.db
        .prepare("UPDATE tasks SET updated_at=updated_at WHERE id=? AND project_id=? RETURNING id")
        .get<{ id: number }>(taskId, projectId);
      if (!reserved) throw new Error(`task ${taskId} no longer exists in project ${projectId}`);
      await this.db
        .prepare(
          `INSERT INTO submission_idempotency
             (project_id, submitted_by, idempotency_key, task_id, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (project_id, submitted_by, idempotency_key) DO NOTHING`,
        )
        .run(projectId, submittedBy, idempotencyKey, taskId, Date.now());
      const mapped = await this.findSubmissionByKey(projectId, submittedBy, idempotencyKey);
      if (mapped === null) throw new Error("idempotent submission reservation is incomplete");
      return mapped;
    });
  }

  async submitIdempotent(
    projectId: string,
    submittedBy: string,
    idempotencyKey: string,
    input: SubmitInput,
  ): Promise<IdempotentSubmitResult> {
    const result = await this.db.transaction(async (): Promise<IdempotentSubmitResult> => {
      const now = Date.now();
      const reserved = await this.db
        .prepare(
          `INSERT INTO submission_idempotency
             (project_id, submitted_by, idempotency_key, task_id, created_at)
           VALUES (?, ?, ?, NULL, ?)
           ON CONFLICT (project_id, submitted_by, idempotency_key) DO NOTHING
           RETURNING idempotency_key`,
        )
        .get<{ idempotency_key: string }>(projectId, submittedBy, idempotencyKey, now);
      if (!reserved) {
        const existing = await this.findSubmissionByKey(projectId, submittedBy, idempotencyKey);
        if (existing === null) throw new Error("idempotent submission reservation is incomplete");
        return { id: existing, created: false };
      }
      const id = await this.insertSubmission(projectId, submittedBy, input, now);
      await this.db
        .prepare(
          `UPDATE submission_idempotency SET task_id=?
           WHERE project_id=? AND submitted_by=? AND idempotency_key=?`,
        )
        .run(id, projectId, submittedBy, idempotencyKey);
      return { id, created: true };
    });
    if (result.created) this.signalSubmission(projectId, input);
    return result;
  }

  async status(projectId: string): Promise<{ tasks: TaskRow[] }> {
    const { deriveOperationalDisposition } = await import("./operational-disposition.js");
    const tasks = await this.db
      .prepare(
        `SELECT * FROM tasks WHERE project_id = ?
         ORDER BY CASE WHEN state = 'DONE' THEN 1 ELSE 0 END, priority ASC, id ASC`,
      )
      .all<TaskRow>(projectId);
    if (tasks.length === 0) return { tasks };

    // Batch open-question + latest groom job lookups (avoid N+1 per task).
    const openQuestionTaskIds = new Set(
      (
        await this.db
          .prepare(
            `SELECT DISTINCT task_id AS id FROM questions
              WHERE project_id = ? AND status = 'open' AND task_id IS NOT NULL`,
          )
          .all<{ id: number }>(projectId)
      ).map((row) => row.id),
    );
    const groomByTask = new Map<number, "pending" | "running" | "done" | "failed">();
    const groomRows = await this.db
      .prepare(
        `SELECT id, status, payload FROM jobs
          WHERE project_id = ? AND kind = 'groom'
          ORDER BY id DESC`,
      )
      .all<{ id: number; status: string; payload: string }>(projectId);
    for (const job of groomRows) {
      let taskId: number | null = null;
      try {
        const parsed = JSON.parse(job.payload) as { taskId?: unknown };
        if (typeof parsed.taskId === "number") taskId = parsed.taskId;
      } catch {
        /* ignore malformed payload */
      }
      if (taskId == null || groomByTask.has(taskId)) continue;
      if (job.status === "pending" || job.status === "running" || job.status === "done" || job.status === "failed") {
        groomByTask.set(taskId, job.status);
      }
    }

    const depsByTask = await unsatisfiedDepsByTask(
      this.db,
      tasks.map((t) => t.id),
    );
    for (const t of tasks) {
      t.waiting_on = depsByTask.get(t.id) ?? [];
      t.operational = deriveOperationalDisposition({
        state: t.state,
        lease_agent: t.lease_agent,
        lease_expires_at: t.lease_expires_at,
        hold_cause: t.hold_cause,
        block_kind: t.block_kind,
        block_requeue_at: t.block_requeue_at,
        incubate_until: t.incubate_until,
        grooming_rationale: t.grooming_rationale,
        plan: t.plan,
        plan_deadline: t.plan_deadline,
        queued_at: t.queued_at,
        updated_at: (t as { updated_at?: number }).updated_at ?? null,
        waiting_on: t.waiting_on,
        groom_job_status: groomByTask.get(t.id) ?? null,
        has_open_question: openQuestionTaskIds.has(t.id),
      });
    }
    return { tasks };
  }

  async brief(taskId: number): Promise<TaskBrief> {
    // repo falls back to the project's repo: a cold agent must learn where to
    // work from the brief itself (simulation round 4 finding).
    const task = (await this.db
      .prepare(
        `SELECT t.*, COALESCE(t.repo, p.repo) AS repo
         FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ?`,
      )
      .get<TaskRow>(taskId)) as TaskRow;
    const evidence = await this.db
      .prepare(
        `SELECT id, kind, path, lines, snippet, note FROM evidence
         WHERE task_id = ? AND kind <> 'image' ORDER BY id`,
      )
      .all<EvidenceRecord>(taskId);
    const attempts = await this.db
      .prepare(`SELECT agent, outcome, notes FROM attempts WHERE task_id = ? ORDER BY id ASC`)
      .all<{ agent: string; outcome: string; notes: string | null }>(taskId);
    const questions = await this.db
      .prepare(`SELECT question, answer, answered_by, status, asked_by FROM questions WHERE task_id = ? ORDER BY id ASC`)
      .all<{ question: string; answer: string | null; answered_by: string | null; status: string; asked_by: string }>(taskId);
    const notes = (
      await this.db
        .prepare(
          `SELECT agent, note, created_at FROM task_notes WHERE task_id = ?
           ORDER BY id DESC LIMIT ${BRIEF_NOTES_LIMIT}`,
        )
        .all<TaskNote>(taskId)
    ).reverse();
    const waiting_on = await unsatisfiedDeps(this.db, taskId);
    return { ...task, waiting_on, evidence, attempts, questions, notes };
  }

  /**
   * The live task a resubmission duplicates, or null. Deterministic dedup:
   * same project, same normalized content watermark, same submitter, still
   * open (never DONE), and created inside DEDUP_WINDOW_MS. Lowest id wins so
   * the original is returned. Scoping to submitter+window keeps a legitimately
   * new take on an old idea, or a different member's parallel report, from
   * being swallowed.
   */
  async findDuplicate(
    projectId: string,
    submittedBy: string,
    title: string,
    body: string,
  ): Promise<TaskBrief | null> {
    const row = await this.db
      .prepare(
        `SELECT id FROM tasks
         WHERE project_id = ? AND submitted_by = ? AND watermark = ?
           AND state != 'DONE' AND created_at > ?
         ORDER BY id ASC LIMIT 1`,
      )
      .get<{ id: number }>(projectId, submittedBy, Queue.watermark(title, body), Date.now() - DEDUP_WINDOW_MS);
    return row ? this.brief(row.id) : null;
  }

  /**
   * A different member's still-open submission that duplicates this one — the
   * duplicate-divergent conflict signal (#77). Same project and normalized
   * content watermark, a DIFFERENT submitter (same-submitter dups are handled
   * by findDuplicate), non-DONE, not the task itself, and not already inside an
   * OPEN conflict conversation (so a resubmission never re-opens one). Lowest id
   * wins. Unlike findDuplicate this is NOT time-windowed: two members filing the
   * same ask hours apart still conflict.
   */
  async findConflictingSubmission(
    projectId: string,
    taskId: number,
    submittedBy: string,
    title: string,
    body: string,
  ): Promise<TaskBrief | null> {
    const row = await this.db
      .prepare(
        `SELECT id FROM tasks t
         WHERE t.project_id = ? AND t.watermark = ? AND t.submitted_by <> ?
           AND t.state <> 'DONE' AND t.id <> ?
           AND NOT EXISTS (
             SELECT 1 FROM conversation_tasks ct JOIN conversations c ON c.id = ct.conversation_id
             WHERE ct.task_id = t.id AND c.state = 'OPEN'
           )
         ORDER BY t.id ASC LIMIT 1`,
      )
      .get<{ id: number }>(projectId, Queue.watermark(title, body), submittedBy, taskId);
    return row ? this.brief(row.id) : null;
  }

  /** True when the task already sits inside an OPEN conflict conversation. */
  async taskInOpenConversation(taskId: number): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT 1 AS ok FROM conversation_tasks ct JOIN conversations c ON c.id = ct.conversation_id
         WHERE ct.task_id = ? AND c.state = 'OPEN' LIMIT 1`,
      )
      .get<{ ok: number }>(taskId);
    return !!row;
  }

  /**
   * Move a task into HELD for the duration of a conflict conversation, so no
   * coder builds a duplicate while the humans discuss. Releases any lease.
   * State-guarded to non-terminal states; a DONE task is left untouched.
   */
  async holdForConversation(taskId: number, reason: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE tasks SET state='HELD', result_summary=?, hold_cause='conflict', lease_agent=NULL, lease_expires_at=NULL,
                          plan_deadline=NULL, block_kind=NULL, block_requeue_at=NULL, updated_at=?
         WHERE id=? AND state <> 'DONE' AND state <> 'HELD'`,
      )
      .run(`held (conflict conversation): ${reason}`, Date.now(), taskId);
    this.notifyChanged(await this.projectOf(taskId));
  }

  /**
   * Release a conflict-conversation hold back to QUEUED (clears the held
   * summary), so the conciliation outcome can act on a live task through the
   * shared apply path. State-guarded on HELD; a task the outcome will close or
   * re-hold passes cleanly through this first.
   */
  async clearConflictHold(taskId: number): Promise<void> {
    const now = Date.now();
    const res = await this.db
      .prepare(
        "UPDATE tasks SET state='QUEUED', result_summary=NULL, hold_cause=NULL, block_kind=NULL, block_requeue_at=NULL, queued_at=?, queue_generation=queue_generation+1, updated_at=? WHERE id=? AND state='HELD'",
      )
      .run(now, now, taskId);
    if (res.changes > 0) {
      const projectId = await this.projectOf(taskId);
      this.events.emit("enqueued", projectId);
      this.notifyChanged(projectId);
    }
  }

  /** An open mediator clarification on a task ({id, question}), or null. */
  async pendingMediatorQuestion(taskId: number): Promise<{ id: number; question: string } | null> {
    const row = await this.db
      .prepare(
        "SELECT id, question FROM questions WHERE task_id = ? AND asked_by = 'mediator' AND status = 'open' ORDER BY id ASC LIMIT 1",
      )
      .get<{ id: number; question: string }>(taskId);
    return row ?? null;
  }

  /** Hold a provisional submission while its durable mediator question is open. */
  async holdForMediatorClarification(taskId: number, projectId: string, question: string): Promise<number> {
    const { runWithDeferredPushes } = await import("./push-dispatch.js");
    // addQuestions defers push while nested; runWithDeferredPushes drains only this request's bag after commit.
    return runWithDeferredPushes(this.db, async () =>
      this.db.transaction(async () => {
        const held = await this.db.prepare(
          `UPDATE tasks SET state='BLOCKED', block_kind='human', block_requeue_at=NULL,
                            lease_agent=NULL, lease_expires_at=NULL, updated_at=?
           WHERE id=? AND project_id=? AND state='QUEUED'`,
        ).run(Date.now(), taskId, projectId);
        if (held.changes !== 1) throw new Error(`task ${taskId} is no longer queued for mediator clarification`);
        const [opened] = await this.addQuestions(projectId, taskId, "mediator", question);
        if (!opened) throw new Error(`mediator clarification for task ${taskId} did not produce an open question`);
        return opened;
      }),
    );
  }

  /** A question's routing fields (who asked, which task, still open?), or null. */
  async questionById(
    questionId: number,
  ): Promise<{
    id: number;
    project_id: string;
    task_id: number | null;
    asked_by: string;
    status: string;
    question: string;
    domain: string | null;
    refresh_trigger: string | null;
  } | null> {
    const row = await this.db
      .prepare("SELECT id, project_id, task_id, asked_by, status, question, domain, refresh_trigger FROM questions WHERE id = ?")
      .get<{
        id: number;
        project_id: string;
        task_id: number | null;
        asked_by: string;
        status: string;
        question: string;
        domain: string | null;
        refresh_trigger: string | null;
      }>(questionId);
    return row ?? null;
  }

  /** Shared mutation path for task-bound and project-scoped questions. */
  async addQuestions(
    projectId: string,
    taskId: number | null,
    askedBy: string,
    questions: string | string[] | ProjectQuestionInput | ProjectQuestionInput[],
  ): Promise<number[]> {
    return this.questionLedger.add(projectId, taskId, askedBy, questions);
  }

  async claimNext(projectId: string, agent: string, ttlMs: number): Promise<TaskBrief | null> {
    let mutated = false;
    const taskId = await this.db.transaction(async (): Promise<number | null> => {
      const now = Date.now();
      if (this.db.dialect === "postgres") {
        // READ COMMITTED does not prevent two claims for different task rows
        // from both observing no lease. Serialize claims per verified seat.
        await this.db.prepare(
          "SELECT pg_advisory_xact_lock(1296387405, hashtext(CAST(? AS TEXT))) AS locked",
        ).get(`memracer:lease-agent:${agent}`);
      }
      const existing = await this.db.prepare(
        `SELECT id FROM tasks WHERE lease_agent=? AND state IN ('CLAIMED','PLANNED','EXECUTING')
           AND lease_expires_at >= ? LIMIT 1`,
      ).get<{ id: number }>(agent, now - LEASE_RECOVERY_GRACE_MS);
      if (existing) return null;
      const expired = await this.db
        .prepare(
          `SELECT id, state, lease_agent, lease_expires_at FROM tasks
           WHERE project_id = ? AND state IN ('CLAIMED','PLANNED','EXECUTING') AND lease_expires_at < ?`,
        )
        .all<{ id: number; state: string; lease_agent: string; lease_expires_at: number }>(projectId, now - LEASE_RECOVERY_GRACE_MS);
      for (const t of expired) {
        // Postgres READ COMMITTED permits another claim transaction to sweep
        // and re-lease this row after our SELECT. Requeue only the exact lease
        // observed above; write attempt history only when this CAS wins.
        const requeued = await this.db
          .prepare(
            `UPDATE tasks SET state = 'QUEUED', lease_agent = NULL, lease_expires_at = NULL, queued_at = ?, queue_generation=queue_generation+1, updated_at = ?
             WHERE id = ? AND project_id = ? AND state = ? AND lease_agent = ?
               AND lease_expires_at = ? AND lease_expires_at < ?`,
          )
          .run(now, now, t.id, projectId, t.state, t.lease_agent, t.lease_expires_at, now - LEASE_RECOVERY_GRACE_MS);
        if (requeued.changes === 0) continue;
        await this.db
          .prepare(
            `INSERT INTO attempts (task_id, agent, outcome, notes, created_at)
             VALUES (?, ?, 'lease_expired', 'lease expired; task requeued', ?)`,
          )
          .run(t.id, t.lease_agent, now);
        mutated = true;
      }
      // A live lease does not excuse a missing plan: a confused agent
      // heartbeating forever must not hold an unplanned task. plan_deadline
      // is only cleared by plan approval, so pre-approval CLAIMED/EXECUTING
      // tasks past the window requeue here regardless of the lease.
      const planExpired = await this.db
        .prepare(
          `SELECT id, state, lease_agent, plan_deadline FROM tasks
           WHERE project_id = ? AND state IN ('CLAIMED','EXECUTING')
             AND plan_deadline IS NOT NULL AND plan_deadline < ?`,
        )
        .all<{ id: number; state: string; lease_agent: string; plan_deadline: number }>(projectId, now);
      for (const t of planExpired) {
        // A later owner gets a fresh plan deadline. Match both ownership and
        // the observed deadline so this stale sweep cannot erase that lease.
        const requeued = await this.db
          .prepare(
            `UPDATE tasks SET state = 'QUEUED', lease_agent = NULL, lease_expires_at = NULL,
                              plan_deadline = NULL, queued_at = ?, queue_generation=queue_generation+1, updated_at = ?
             WHERE id = ? AND project_id = ? AND state = ? AND lease_agent = ?
               AND plan_deadline = ? AND plan_deadline < ?`,
          )
          .run(now, now, t.id, projectId, t.state, t.lease_agent, t.plan_deadline, now);
        if (requeued.changes === 0) continue;
        await this.db
          .prepare(
            `INSERT INTO attempts (task_id, agent, outcome, notes, created_at)
             VALUES (?, ?, 'plan_window_expired', 'plan window expired; task requeued', ?)`,
          )
          .run(t.id, t.lease_agent, now);
        mutated = true;
      }
      // Release cooldown: an agent that just gave a task back must not be
      // re-served the same task on its next poll (release loop, observed
      // live). Other agents see it immediately.
      // A dependency is ORDER ONLY (#75): task_deps never GATES a claim — a
      // dependent whose predecessor is not yet DONE is still claimable; the
      // coder that draws a not-yet-ready task simply releases and is re-served
      // later. task_deps only nudges serve-ORDER: tasks whose predecessors are
      // all DONE are offered first (unsatisfied-dep-count ASC), so the natural
      // order is followed without any task ever sitting blocked. The only hard
      // filter left is the release cooldown (don't re-serve a task to the agent
      // that just gave it back).
      const row = await this.db
        .prepare(
          `SELECT id FROM tasks t WHERE t.project_id = ? AND t.state = 'QUEUED'
             AND NOT EXISTS (
               SELECT 1 FROM attempts a
               WHERE a.task_id = t.id AND a.agent = ? AND a.outcome = 'released'
                 AND a.created_at > ?
                 AND a.id = (SELECT MAX(id) FROM attempts WHERE task_id = t.id)
             )
           ORDER BY
             (SELECT COUNT(*) FROM task_deps d JOIN tasks pre ON pre.id = d.depends_on
              WHERE d.task_id = t.id AND pre.state <> 'DONE') ASC,
             t.priority ASC, t.id ASC LIMIT 1`,
        )
        .get<{ id: number }>(projectId, agent, now - RELEASE_COOLDOWN_MS);
      if (!row) return null;
      // state='QUEUED' guard: under Postgres two concurrent claim
      // transactions can both read the same QUEUED row (read committed) —
      // the loser's UPDATE matches nothing and it walks away empty instead
      // of double-claiming.
      const claimed = await this.db
        .prepare(
          `UPDATE tasks SET state = 'CLAIMED', lease_agent = ?, lease_expires_at = ?,
                            lease_ttl_ms = ?, plan_deadline = ?, updated_at = ?
           WHERE id = ? AND state = 'QUEUED'`,
        )
        .run(agent, now + boundedLeaseTtl(ttlMs), boundedLeaseTtl(ttlMs), now + PLAN_WINDOW_MS, now, row.id);
      if (claimed.changes === 0) return null;
      await this.db
        .prepare("UPDATE projects SET last_active_lease_at = ?, claim_generation = claim_generation + 1 WHERE id = ?")
        .run(now, projectId);
      mutated = true;
      return row.id;
    });
    if (mutated) this.notifyChanged(projectId);
    return taskId === null ? null : this.brief(taskId);
  }

  /**
   * Reclaim expired leases and closed plan windows across every project, and
   * emit `enqueued` + `changed` for each project touched. This is what makes the
   * project event stream COMPLETE: an expired lease or plan window is a
   * time-based transition into claimability that no mutation signals on its own,
   * so a coder parked on the SSE stream (`memracer wait`) would never wake for
   * it. Running this on the worker tick converts those time-edges into events —
   * and promptly frees a crashed coder's task instead of waiting for the next
   * coder to happen to claim.
   *
   * Idempotent against claimNext's inline recovery: both requeue under the same
   * CAS guard (the exact observed lease/deadline, still past the window), so
   * whichever transaction runs second matches no rows and no-ops.
   */
  async recoverExpiredLeases(now = Date.now()): Promise<number[]> {
    const recovered = new Set<number>();
    const projects = new Set<string>();

    const leaseExpired = await this.db
      .prepare(
        `SELECT id, project_id, state, lease_agent, lease_expires_at FROM tasks
         WHERE state IN ('CLAIMED','PLANNED','EXECUTING') AND lease_expires_at < ?`,
      )
      .all<{ id: number; project_id: string; state: string; lease_agent: string; lease_expires_at: number }>(
        now - LEASE_RECOVERY_GRACE_MS,
      );
    for (const t of leaseExpired) {
      const requeued = await this.db.transaction(async () => {
        const r = await this.db
          .prepare(
            `UPDATE tasks SET state='QUEUED', lease_agent=NULL, lease_expires_at=NULL,
                              queued_at=?, queue_generation=queue_generation+1, updated_at=?
             WHERE id=? AND state=? AND lease_agent=? AND lease_expires_at=? AND lease_expires_at < ?`,
          )
          .run(now, now, t.id, t.state, t.lease_agent, t.lease_expires_at, now - LEASE_RECOVERY_GRACE_MS);
        if (r.changes === 0) return false;
        await this.db
          .prepare(
            `INSERT INTO attempts (task_id, agent, outcome, notes, created_at)
             VALUES (?, ?, 'lease_expired', 'lease expired; task requeued', ?)`,
          )
          .run(t.id, t.lease_agent, now);
        return true;
      });
      if (requeued) {
        recovered.add(t.id);
        projects.add(t.project_id);
      }
    }

    const planExpired = await this.db
      .prepare(
        `SELECT id, project_id, state, lease_agent, plan_deadline FROM tasks
         WHERE state IN ('CLAIMED','EXECUTING') AND plan_deadline IS NOT NULL AND plan_deadline < ?`,
      )
      .all<{ id: number; project_id: string; state: string; lease_agent: string; plan_deadline: number }>(now);
    for (const t of planExpired) {
      const requeued = await this.db.transaction(async () => {
        const r = await this.db
          .prepare(
            `UPDATE tasks SET state='QUEUED', lease_agent=NULL, lease_expires_at=NULL,
                              plan_deadline=NULL, queued_at=?, queue_generation=queue_generation+1, updated_at=?
             WHERE id=? AND state=? AND lease_agent=? AND plan_deadline=? AND plan_deadline < ?`,
          )
          .run(now, now, t.id, t.state, t.lease_agent, t.plan_deadline, now);
        if (r.changes === 0) return false;
        await this.db
          .prepare(
            `INSERT INTO attempts (task_id, agent, outcome, notes, created_at)
             VALUES (?, ?, 'plan_window_expired', 'plan window expired; task requeued', ?)`,
          )
          .run(t.id, t.lease_agent, now);
        return true;
      });
      if (requeued) {
        recovered.add(t.id);
        projects.add(t.project_id);
      }
    }

    for (const projectId of projects) {
      this.events.emit("enqueued", projectId);
      this.notifyChanged(projectId);
    }
    return [...recovered];
  }

  private async requireLease(taskId: number, agent: string): Promise<{ lease_ttl_ms: number }> {
    const row = await this.db
      .prepare(`SELECT lease_agent, lease_expires_at, lease_ttl_ms FROM tasks WHERE id = ?`)
      .get<{ lease_agent: string | null; lease_expires_at: number | null; lease_ttl_ms: number }>(taskId);
    if (!row) throw new Error(`task ${taskId} not found`);
    if (row.lease_agent !== agent || (row.lease_expires_at ?? 0) < Date.now() - LEASE_RECOVERY_GRACE_MS) {
      throw new Error(`task ${taskId}: no live lease held by ${agent}`);
    }
    return row;
  }

  async renewLease(taskId: number, agent: string, ttlMs?: number): Promise<TaskBrief> {
    await this.db.transaction(async () => {
      const lease = await this.requireLease(taskId, agent);
      const now = Date.now();
      const duration = boundedLeaseTtl(ttlMs ?? lease.lease_ttl_ms);
      const renewed = await this.db.prepare(
        `UPDATE tasks SET lease_expires_at=?, lease_ttl_ms=?, updated_at=?
         WHERE id=? AND lease_agent=? AND state IN ('CLAIMED','PLANNED','EXECUTING')`,
      ).run(now + duration, duration, now, taskId, agent);
      if (renewed.changes === 0) throw new Error(`task ${taskId}: lease ownership changed during renewal`);
    });
    return this.briefAndNotify(taskId);
  }

  async renewAgentLeases(agent: string): Promise<TaskBrief[]> {
    const now = Date.now();
    const rows = await this.db.prepare(
      `SELECT id FROM tasks WHERE lease_agent=? AND state IN ('CLAIMED','PLANNED','EXECUTING')
       AND lease_expires_at >= ? ORDER BY id`,
    ).all<{ id: number }>(agent, now - LEASE_RECOVERY_GRACE_MS);
    const renewed: TaskBrief[] = [];
    for (const row of rows) renewed.push(await this.renewLease(row.id, agent));
    return renewed;
  }

  async progress(taskId: number, agent: string, note: string, ttlMs?: number): Promise<TaskBrief> {
    await this.db.transaction(async () => {
      const lease = await this.requireLease(taskId, agent);
      const now = Date.now();
      const duration = boundedLeaseTtl(ttlMs ?? lease.lease_ttl_ms);
      const renewed = await this.db
        .prepare(
          `UPDATE tasks SET state = 'EXECUTING', lease_expires_at = ?, lease_ttl_ms=?, updated_at = ?
           WHERE id = ? AND lease_agent=? AND state IN ('CLAIMED','PLANNED','EXECUTING')`,
        )
        .run(now + duration, duration, now, taskId, agent);
      if (renewed.changes === 0) throw new Error(`task ${taskId}: lease ownership changed during progress`);
      await this.db
        .prepare(`INSERT INTO task_notes (task_id, agent, note, created_at) VALUES (?, ?, ?, ?)`)
        .run(taskId, agent, note, now);
    });
    return this.briefAndNotify(taskId);
  }

  private async briefAndNotify(taskId: number): Promise<TaskBrief> {
    const brief = await this.brief(taskId);
    this.notifyChanged(brief.project_id);
    return brief;
  }

  async complete(
    taskId: number,
    agent: string,
    summary: string,
    prUrl: string,
    opts: {
      prDescription?: string;
      /**
       * DONE only when the PR is merged with green required checks.
       * Open/red PRs must use AWAITING_MERGE so DONE stays truthful.
       * Defaults to DONE for direct callers that already verified (tests).
       */
      terminal?: "DONE" | "AWAITING_MERGE";
      prVerification?: string | null;
      prVerificationEtag?: string | null;
      /**
       * Prefer a number already parsed by the caller (e.g. parsePrUrl in
       * coder_complete) over re-parsing the URL with the loose trailing-digit
       * fallback used by direct/test callers.
       */
      prNumber?: number | null;
    } = {},
  ): Promise<TaskBrief> {
    const parsedTrailing = /(\d+)\/?$/.exec(prUrl);
    const prNumber =
      opts.prNumber !== undefined
        ? opts.prNumber
        : parsedTrailing
          ? Number(parsedTrailing[1])
          : null;
    const terminal = opts.terminal ?? "DONE";
    const outcome = terminal === "DONE" ? "completed" : "awaiting_merge";
    await this.db.transaction(async () => {
      await this.requireLease(taskId, agent);
      const now = Date.now();
      const completed = await this.db
        .prepare(
          `UPDATE tasks SET state = ?, lease_agent = NULL, lease_expires_at = NULL,
                            result_summary = ?, result_pr_url = ?, result_pr_number = ?,
                            result_pr_description = ?, pr_verification = ?, pr_verification_etag = ?,
                            updated_at = ?
           WHERE id = ? AND lease_agent=? AND state IN ('CLAIMED','PLANNED','EXECUTING')`,
        )
        .run(
          terminal,
          summary,
          prUrl,
          prNumber,
          opts.prDescription ?? null,
          opts.prVerification ?? null,
          opts.prVerificationEtag ?? null,
          now,
          taskId,
          agent,
        );
      if (completed.changes === 0) throw new Error(`task ${taskId}: lease ownership changed during completion`);
      await this.db
        .prepare(
          `INSERT INTO attempts (task_id, agent, outcome, notes, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(taskId, agent, outcome, summary, now);
    });
    if (terminal === "DONE") {
      await this.recoverDependencyHolds({ predecessorId: taskId });
    }
    const brief = await this.brief(taskId);
    // A completed predecessor unblocks its dependents — wake parked waiters.
    this.events.emit("enqueued", brief.project_id);
    this.notifyChanged(brief.project_id);
    return brief;
  }

  /**
   * Requeue an AWAITING_MERGE row whose PR was closed without merge.
   * Clears stale PR fields so the dashboard no longer shows the closed PR.
   * Leaves the task claimable again with a clear attempt note — never silent limbo.
   * Returns `{ agent }` when this call won the CAS, or null if already settled.
   */
  async requeueAwaitingMerge(
    taskId: number,
    opts: {
      prVerification?: string | null;
      prVerificationEtag?: string | null;
      reason?: string;
    } = {},
  ): Promise<{ agent: string } | null> {
    const now = Date.now();
    const reason =
      opts.reason ?? "PR closed without merge; requeued for a new or reopened PR";
    let changed = 0;
    let agent = "system";
    await this.db.transaction(async () => {
      const updated = await this.db
        .prepare(
          `UPDATE tasks SET state = 'QUEUED',
                            pr_verification = ?, pr_verification_etag = ?,
                            result_pr_url = NULL, result_pr_number = NULL,
                            result_pr_description = NULL, result_summary = NULL,
                            lease_agent = NULL, lease_expires_at = NULL,
                            queued_at = ?, queue_generation = queue_generation + 1,
                            updated_at = ?
           WHERE id = ? AND state = 'AWAITING_MERGE'`,
        )
        .run(
          opts.prVerification ?? "closed-unmerged",
          opts.prVerificationEtag ?? null,
          now,
          now,
          taskId,
        );
      changed = updated.changes;
      if (changed === 0) return;
      const last = await this.db
        .prepare(
          `SELECT agent FROM attempts WHERE task_id=? AND outcome='awaiting_merge'
           ORDER BY id DESC LIMIT 1`,
        )
        .get<{ agent: string }>(taskId);
      agent = last?.agent ?? "system";
      await this.db
        .prepare(
          `INSERT INTO attempts (task_id, agent, outcome, notes, created_at)
           VALUES (?, ?, 'released', ?, ?)`,
        )
        .run(taskId, agent, reason, now);
    });
    if (changed === 0) return null;
    const brief = await this.brief(taskId);
    this.events.emit("enqueued", brief.project_id);
    this.notifyChanged(brief.project_id);
    return { agent };
  }

  /**
   * Stamp the first consecutive merge-probe failure time (idempotent). Returns
   * the durable first-failure timestamp used for the transient budget ceiling.
   */
  async noteMergeProbeTransient(taskId: number): Promise<number> {
    const now = Date.now();
    await this.db
      .prepare(
        `UPDATE tasks SET merge_probe_transient_since = ?, updated_at = ?
         WHERE id = ? AND state = 'AWAITING_MERGE' AND merge_probe_transient_since IS NULL`,
      )
      .run(now, now, taskId);
    const row = await this.db
      .prepare(`SELECT merge_probe_transient_since AS since FROM tasks WHERE id = ?`)
      .get<{ since: number | null }>(taskId);
    return row?.since ?? now;
  }

  /** Clear the merge-probe transient stamp after a successful settle or escalation. */
  async clearMergeProbeTransient(taskId: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE tasks SET merge_probe_transient_since = NULL
         WHERE id = ? AND merge_probe_transient_since IS NOT NULL`,
      )
      .run(taskId);
  }

  /**
   * Park an AWAITING_MERGE row as human-BLOCKED when closed-unmerged work may
   * have landed under another PR (squash/stack) and cannot be auto-resolved.
   * Opens a question so NeedsYou surfaces it. No lease required.
   */
  async flagMergedElsewhereAttention(
    taskId: number,
    opts: {
      prVerification?: string | null;
      prVerificationEtag?: string | null;
      reason: string;
    },
  ): Promise<{ agent: string } | null> {
    const { runWithDeferredPushes } = await import("./push-dispatch.js");
    const now = Date.now();
    let changed = 0;
    let agent = "system";
    await runWithDeferredPushes(this.db, async () =>
      this.db.transaction(async () => {
        const updated = await this.db
          .prepare(
            `UPDATE tasks SET state = 'BLOCKED', block_kind = 'human', block_requeue_at = NULL,
                              pr_verification = ?, pr_verification_etag = ?,
                              lease_agent = NULL, lease_expires_at = NULL,
                              updated_at = ?
             WHERE id = ? AND state = 'AWAITING_MERGE'`,
          )
          .run(
            opts.prVerification ?? "closed-unmerged",
            opts.prVerificationEtag ?? null,
            now,
            taskId,
          );
        changed = updated.changes;
        if (changed === 0) return;
        const last = await this.db
          .prepare(
            `SELECT agent FROM attempts WHERE task_id=? AND outcome='awaiting_merge'
             ORDER BY id DESC LIMIT 1`,
          )
          .get<{ agent: string }>(taskId);
        agent = last?.agent ?? "system";
        await this.db
          .prepare(
            `INSERT INTO attempts (task_id, agent, outcome, notes, created_at)
             VALUES (?, ?, 'blocked', ?, ?)`,
          )
          .run(taskId, agent, opts.reason, now);
        const [questionId] = await this.addQuestions(
          await this.projectOf(taskId),
          taskId,
          agent,
          `blocked: ${opts.reason} — what should happen?`,
        );
        if (!questionId) {
          throw new Error(`merged-elsewhere attention for task ${taskId} did not produce an open question`);
        }
      }),
    );
    if (changed === 0) return null;
    const brief = await this.brief(taskId);
    this.notifyChanged(brief.project_id);
    return { agent };
  }

  /**
   * Promote an AWAITING_MERGE row to DONE once GitHub reports merged-green.
   * Returns `{ agent }` of the completing coder when this call won the
   * transition (single-fire for pollers), or null when another path already
   * promoted. Attribution prefers the latest awaiting_merge attempt agent.
   */
  async promoteAwaitingMerge(
    taskId: number,
    opts: { prVerification?: string | null; prVerificationEtag?: string | null } = {},
  ): Promise<{ agent: string } | null> {
    const now = Date.now();
    let changed = 0;
    let agent = "system";
    await this.db.transaction(async () => {
      const updated = await this.db
        .prepare(
          `UPDATE tasks SET state = 'DONE',
                            pr_verification = ?, pr_verification_etag = ?,
                            updated_at = ?
           WHERE id = ? AND state = 'AWAITING_MERGE'`,
        )
        .run(
          opts.prVerification ?? "merged-green",
          opts.prVerificationEtag ?? null,
          now,
          taskId,
        );
      changed = updated.changes;
      if (changed === 0) return;
      const last = await this.db
        .prepare(
          `SELECT agent, notes FROM attempts WHERE task_id=? AND outcome='awaiting_merge'
           ORDER BY id DESC LIMIT 1`,
        )
        .get<{ agent: string; notes: string | null }>(taskId);
      agent = last?.agent ?? "system";
      await this.db
        .prepare(
          `INSERT INTO attempts (task_id, agent, outcome, notes, created_at)
           VALUES (?, ?, 'completed', ?, ?)`,
        )
        .run(taskId, agent, last?.notes ?? "merged-green", now);
    });
    if (changed === 0) return null;
    await this.recoverDependencyHolds({ predecessorId: taskId });
    const brief = await this.brief(taskId);
    this.events.emit("enqueued", brief.project_id);
    this.notifyChanged(brief.project_id);
    return { agent };
  }

  /** Add dependency edge dependent->dependsOn; wakes waiters and signals change. */
  async addDependency(projectId: string, dependentId: number, dependsOnId: number): Promise<void> {
    await insertDependency(this.db, projectId, dependentId, dependsOnId);
    this.events.emit("enqueued", projectId);
    this.notifyChanged(projectId);
  }

  /** Remove dependency edge dependent->dependsOn; a removed gate may free work. */
  async removeDependency(projectId: string, dependentId: number, dependsOnId: number): Promise<void> {
    await removeDependency(this.db, dependentId, dependsOnId);
    this.events.emit("enqueued", projectId);
    this.notifyChanged(projectId);
  }

  /**
   * INCUBATING tasks whose graduation clock has struck (incubate_until <= now),
   * across every project. The seal sweep enqueues a seal groom for each — the
   * task only becomes claimable once that groom graduates it.
   */
  async dueIncubations(now: number = Date.now()): Promise<{ id: number; project_id: string; submitted_by: string }[]> {
    return this.db
      .prepare(
        `SELECT id, project_id, submitted_by FROM tasks
         WHERE state='INCUBATING' AND incubate_until IS NOT NULL AND incubate_until <= ?
         ORDER BY id ASC`,
      )
      .all<{ id: number; project_id: string; submitted_by: string }>(now);
  }

  /**
   * Graduate an INCUBATING task to QUEUED (clears the clock) once its seal
   * groom has run. Idempotent and race-safe via the state guard: a task the
   * groom merged/closed away is no longer INCUBATING, so this no-ops. On a real
   * transition it wakes parked coder waiters — the warming period is over and
   * the task is now claimable work.
   */
  async graduate(taskId: number): Promise<boolean> {
    const now = Date.now();
    const res = await this.db
      .prepare(
        "UPDATE tasks SET state='QUEUED', incubate_until=NULL, queued_at=?, queue_generation=queue_generation+1, updated_at=? WHERE id=? AND state='INCUBATING'",
      )
      .run(now, now, taskId);
    if (res.changes === 0) return false;
    const projectId = await this.projectOf(taskId);
    this.events.emit("enqueued", projectId);
    this.notifyChanged(projectId);
    return true;
  }

  /**
   * Submitter/admin early seal: graduate an INCUBATING task now, before its
   * clock strikes. Same transition and waiter-wake as graduate(); returns
   * false if the task is not INCUBATING (already graduated, or never warm).
   */
  async sealEarly(taskId: number): Promise<boolean> {
    return this.graduate(taskId);
  }

  /**
   * Put an unclaimed QUEUED task back into a warming period. The guarded
   * update is the whole transition: a concurrent claim wins by changing the
   * state first, in which case this returns false and never disturbs its
   * lease. Warming can change the canonical spec, so it also invalidates any
   * approved plan retained by a previously released task. Attempts stay as
   * history; QUEUED tasks already have no lease. The task stays invisible to
   * coders and its dashboard countdown updates.
   */
  async warm(taskId: number, incubateUntil: number): Promise<boolean> {
    const res = await this.db
      .prepare(
        `UPDATE tasks SET state='INCUBATING', incubate_until=?, plan=NULL,
                          plan_approved_at=NULL, plan_deadline=NULL, updated_at=?
         WHERE id=? AND state='QUEUED'`,
      )
      .run(incubateUntil, Date.now(), taskId);
    if (res.changes === 0) return false;
    this.notifyChanged(await this.projectOf(taskId));
    return true;
  }

  /**
   * Submitter/admin extend: push an INCUBATING task's graduation clock out to a
   * new absolute timestamp. No-op (returns false) unless the task is still
   * INCUBATING. Keeps it off coder surfaces; only the countdown changes.
   */
  async extendIncubation(taskId: number, newIncubateUntil: number): Promise<boolean> {
    const res = await this.db
      .prepare(
        "UPDATE tasks SET incubate_until=?, updated_at=? WHERE id=? AND state='INCUBATING'",
      )
      .run(newIncubateUntil, Date.now(), taskId);
    if (res.changes === 0) return false;
    this.notifyChanged(await this.projectOf(taskId));
    return true;
  }

  async applyGroomAccept(taskId: number, title: string, body: string, priority: number, rationale: string): Promise<void> {
    await this.db
      .prepare("UPDATE tasks SET title=?, body=?, priority=?, grooming_rationale=?, updated_at=? WHERE id=?")
      .run(title, body, priority, rationale, Date.now(), taskId);
    this.notifyChanged(await this.projectOf(taskId));
  }

  /**
   * Retain a model-proposed merge as independent work only while its source
   * is still untouched queue work. A concurrent claim or terminal transition
   * wins and must never have its canonical fields rewritten by the fallback.
   */
  async applyGroomMergeFallback(
    taskId: number,
    title: string,
    body: string,
    priority: number,
    audit: Pick<MergeAuditInput, "rationale" | "citations">,
  ): Promise<boolean> {
    const projectId = await this.db.transaction(async () => {
      const now = Date.now();
      const updated = await this.db
        .prepare(
          `UPDATE tasks SET title=?, body=?, priority=?, grooming_rationale=?, updated_at=?
           WHERE id=? AND state='QUEUED' AND lease_agent IS NULL
           RETURNING project_id`,
        )
        .get<{ project_id: string }>(title, body, priority, audit.rationale, now, taskId);
      if (!updated) return null;
      await this.db
        .prepare(
          `INSERT INTO decision_log
             (project_id, task_id, kind, summary, rationale, created_at, citations)
           VALUES (?, ?, 'create', ?, ?, ?, ?)`,
        )
        .run(
          updated.project_id,
          taskId,
          `created "${title}" (merge safety fallback)`,
          audit.rationale,
          now,
          JSON.stringify(audit.citations ?? []),
        );
      return updated.project_id;
    });
    if (projectId === null) return false;
    // Notify from the row returned by the compare-and-set. A later merge may
    // delete this task immediately after commit, so a second projectOf read
    // would introduce a needless race and turn success into a job failure.
    this.notifyChanged(projectId);
    return true;
  }

  /**
   * Remove a security-refused provisional task while retaining its taskless
   * submission thread and audit decision. Reserving it as DONE first closes
   * the claim race before task-bound rows are detached or deleted.
   */
  async applyGroomRefuse(taskId: number, projectId: string): Promise<boolean> {
    let removed = false;
    await this.db.transaction(async () => {
      const reserved = await this.db
        .prepare(
          `UPDATE tasks SET state='DONE', lease_agent=NULL, lease_expires_at=NULL, updated_at=?
           WHERE id=? AND project_id=? AND state IN ('QUEUED','INCUBATING','PARKED')
             AND lease_agent IS NULL`,
        )
        .run(Date.now(), taskId, projectId);
      if (reserved.changes === 0) return;

      await this.db.prepare("UPDATE tasks SET parent_id=NULL WHERE parent_id=?").run(taskId);
      await this.db.prepare("UPDATE decision_log SET task_id=NULL WHERE task_id=?").run(taskId);
      await this.db.prepare("UPDATE threads SET task_id=NULL WHERE task_id=?").run(taskId);
      await this.db.prepare("UPDATE session_events SET task_id=NULL WHERE task_id=?").run(taskId);
      await this.db.prepare("UPDATE memory_log SET task_id=NULL WHERE task_id=?").run(taskId);
      for (const table of [
        "conversation_tasks",
        "task_deps",
        "evidence",
        "attempts",
        "questions",
        "task_notes",
        "steers",
        "task_transitions",
        "attention_alerts",
      ]) {
        const predicate = table === "task_deps" ? "task_id=? OR depends_on=?" : "task_id=?";
        await this.db.prepare(`DELETE FROM ${table} WHERE ${predicate}`).run(taskId, ...(table === "task_deps" ? [taskId] : []));
      }
      const deleted = await this.db.prepare("DELETE FROM tasks WHERE id=? AND project_id=?").run(taskId, projectId);
      removed = deleted.changes === 1;
    });
    if (removed) this.notifyChanged(projectId);
    return removed;
  }

  async applyGroomMerge(
    duplicateTaskId: number,
    targetTaskId: number,
    audit: MergeAuditInput = { rationale: "internal task merge", mode: "internal" },
  ): Promise<TaskMergeResult> {
    if (duplicateTaskId === targetTaskId) return { merged: false, reason: "same_task" };
    const outcome = await this.db.transaction(async () => {
      const source = await this.mergeTaskRow(duplicateTaskId);
      if (!source || source.state !== "QUEUED" || source.lease_agent !== null) {
        return { result: { merged: false, reason: "source_not_mergeable" } as TaskMergeResult };
      }
      // This no-op write is the cross-dialect reservation. PostgreSQL locks
      // both matched rows; SQLite already serializes this write transaction.
      const reserved = await this.db
        .prepare(
          `UPDATE tasks SET updated_at=updated_at
           WHERE id IN (?, ?) AND project_id=? AND state='QUEUED'
             AND lease_agent IS NULL`,
        )
        .run(duplicateTaskId, targetTaskId, source.project_id);
      if (reserved.changes !== 2) {
        return { result: await this.mergeGuardFailure(duplicateTaskId, source.project_id, false) };
      }
      const snapshots = await this.loadMergeSnapshots(duplicateTaskId, targetTaskId);
      if (!snapshots) {
        return { result: { merged: false, reason: "target_not_mergeable" } as TaskMergeResult };
      }
      const verdict = classifyTaskMerge(snapshots.source, snapshots.target);
      if (!verdict.allowed) return { result: { merged: false, reason: verdict.reason } as TaskMergeResult };

      await this.recordTaskMerge(source.project_id, snapshots.source, snapshots.target, audit);
      await this.retargetMergedTaskReferences(duplicateTaskId, targetTaskId);
      const deleted = await this.db
        .prepare("DELETE FROM tasks WHERE id=? AND project_id=? AND state='QUEUED' AND lease_agent IS NULL")
        .run(duplicateTaskId, source.project_id);
      if (deleted.changes !== 1) throw new Error(`groom merge lost reserved source task ${duplicateTaskId}`);
      return { result: { merged: true } as TaskMergeResult, projectId: source.project_id };
    });
    if (outcome.result.merged) {
      // A cleared edge may free a dependent that was gated on the duplicate.
      this.events.emit("enqueued", outcome.projectId!);
      this.notifyChanged(outcome.projectId!);
    }
    return outcome.result;
  }

  /**
   * Merge only when both rows are still groomed, untouched queue work.
   * Consolidation sweeps must never race an active groom or fold a task an
   * agent has claimed into another task.
   */
  async applyQueuedGroomMerge(
    duplicateTaskId: number,
    targetTaskId: number,
    projectId: string,
    audit: MergeAuditInput = { rationale: "internal queued task consolidation", mode: "consolidate" },
  ): Promise<TaskMergeResult> {
    if (duplicateTaskId === targetTaskId) return { merged: false, reason: "same_task" };
    const result = await this.db.transaction(async () => {
      // The guarded no-op update is the eligibility proof and row reservation.
      // SQLite serializes the write transaction; Postgres locks both matched
      // rows until this transaction commits.
      const reserved = await this.db
        .prepare(
          `UPDATE tasks SET updated_at=updated_at
           WHERE id IN (?, ?) AND project_id=? AND state='QUEUED'
             AND lease_agent IS NULL AND grooming_rationale IS NOT NULL`,
        )
        .run(duplicateTaskId, targetTaskId, projectId);
      if (reserved.changes !== 2) {
        return this.mergeGuardFailure(duplicateTaskId, projectId, true);
      }
      const snapshots = await this.loadMergeSnapshots(duplicateTaskId, targetTaskId);
      if (!snapshots) return { merged: false, reason: "target_not_mergeable" } as TaskMergeResult;
      const verdict = classifyTaskMerge(snapshots.source, snapshots.target);
      if (!verdict.allowed) return { merged: false, reason: verdict.reason } as TaskMergeResult;

      await this.recordTaskMerge(projectId, snapshots.source, snapshots.target, audit);
      await this.retargetMergedTaskReferences(duplicateTaskId, targetTaskId);
      const deleted = await this.db
        .prepare(
          `DELETE FROM tasks
           WHERE id=? AND project_id=? AND state='QUEUED'
             AND lease_agent IS NULL AND grooming_rationale IS NOT NULL`,
        )
        .run(duplicateTaskId, projectId);
      if (deleted.changes !== 1) throw new Error(`queued merge lost reserved source task ${duplicateTaskId}`);
      return { merged: true } as TaskMergeResult;
    });
    if (result.merged) {
      this.events.emit("enqueued", projectId);
      this.notifyChanged(projectId);
    }
    return result;
  }

  private async mergeTaskRow(taskId: number): Promise<{
    id: number;
    project_id: string;
    state: string;
    lease_agent: string | null;
    grooming_rationale: string | null;
  } | undefined> {
    return this.db
      .prepare("SELECT id, project_id, state, lease_agent, grooming_rationale FROM tasks WHERE id=?")
      .get(taskId);
  }

  private async mergeGuardFailure(
    sourceTaskId: number,
    projectId: string,
    requireGroomed: boolean,
  ): Promise<TaskMergeResult> {
    const source = await this.mergeTaskRow(sourceTaskId);
    const sourceEligible = source?.project_id === projectId
      && source.state === "QUEUED"
      && source.lease_agent === null
      && (!requireGroomed || source.grooming_rationale !== null);
    if (!sourceEligible) return { merged: false, reason: "source_not_mergeable" };
    // A guarded reservation that did not match two rows cannot proceed. When
    // the source remains eligible, the target is the failed side. Another
    // transaction may already have changed it again under READ COMMITTED, but
    // the merge must still remain refused.
    return { merged: false, reason: "target_not_mergeable" };
  }

  private async loadMergeSnapshots(
    sourceTaskId: number,
    targetTaskId: number,
  ): Promise<{ source: MergeTaskSnapshot; target: MergeTaskSnapshot } | null> {
    const rows = await this.db
      .prepare("SELECT id, title, body FROM tasks WHERE id IN (?, ?)")
      .all<{ id: number; title: string; body: string }>(sourceTaskId, targetTaskId);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const source = byId.get(sourceTaskId);
    const target = byId.get(targetTaskId);
    if (!source || !target) return null;
    const evidence = await this.db
      .prepare("SELECT task_id, path FROM evidence WHERE task_id IN (?, ?) AND path IS NOT NULL ORDER BY id")
      .all<{ task_id: number; path: string }>(sourceTaskId, targetTaskId);
    const snapshot = (row: { id: number; title: string; body: string }): MergeTaskSnapshot => ({
      ...row,
      evidencePaths: evidence.filter((item) => item.task_id === row.id).map((item) => item.path),
    });
    return { source: snapshot(source), target: snapshot(target) };
  }

  private async recordTaskMerge(
    projectId: string,
    source: MergeTaskSnapshot,
    target: MergeTaskSnapshot,
    audit: MergeAuditInput,
  ): Promise<void> {
    // Store a REFERENCE, never the merged task's full body. The decision log is
    // fed verbatim into every groom prompt; inlining a foreign task's body here
    // is the context-poisoning surface that lets the model regurgitate it onto
    // the task being groomed. Title stays (already exposed queue-wide); body does not.
    const provenance = JSON.stringify({
      merged_from: { task_id: source.id, title: source.title },
    });
    const rationale = `${audit.rationale.trim() || "queue approved task merge"}\n${provenance}`;
    const summary = audit.mode === "consolidate"
      ? `consolidated queued task ${source.id} into task ${target.id}`
      : `merged task ${source.id} into task ${target.id}`;
    await this.db
      .prepare(
        `INSERT INTO decision_log
           (project_id, task_id, kind, summary, rationale, created_at, citations)
         VALUES (?, ?, 'merge', ?, ?, ?, ?)`,
      )
      .run(projectId, target.id, summary, rationale, Date.now(), JSON.stringify(audit.citations ?? []));
  }

  /** Retarget every durable task owner before deleting a merged duplicate. */
  private async retargetMergedTaskReferences(duplicateTaskId: number, targetTaskId: number): Promise<void> {
    await this.db
      .prepare("UPDATE tasks SET parent_id=NULLIF(?, id) WHERE parent_id=?")
      .run(targetTaskId, duplicateTaskId);
    for (const table of [
      "evidence",
      "attempts",
      "questions",
      "decision_log",
      "threads",
      "session_events",
      "memory_log",
      "task_notes",
      "steers",
      "task_transitions",
    ]) {
      await this.db.prepare(`UPDATE ${table} SET task_id=? WHERE task_id=?`).run(targetTaskId, duplicateTaskId);
    }
    await this.db.prepare("UPDATE submission_idempotency SET task_id=? WHERE task_id=?").run(targetTaskId, duplicateTaskId);
    await this.db.prepare("UPDATE memory_docs SET source_task=? WHERE source_task=?").run(targetTaskId, duplicateTaskId);
    await this.db
      .prepare(
        `DELETE FROM conversation_tasks
         WHERE task_id=? AND conversation_id IN (
           SELECT conversation_id FROM conversation_tasks WHERE task_id=?
         )`,
      )
      .run(duplicateTaskId, targetTaskId);
    await this.db.prepare("UPDATE conversation_tasks SET task_id=? WHERE task_id=?").run(targetTaskId, duplicateTaskId);
    await this.db.prepare("DELETE FROM attention_alerts WHERE task_id=?").run(duplicateTaskId);
    // Drop dependency edges touching the merged-away duplicate (either
    // direction). A dangling edge would gate a dependent on a missing task.
    await this.db
      .prepare("DELETE FROM task_deps WHERE task_id=? OR depends_on=?")
      .run(duplicateTaskId, duplicateTaskId);
  }

  private async projectOf(taskId: number): Promise<string> {
    const row = (await this.db
      .prepare("SELECT project_id FROM tasks WHERE id=?")
      .get<{ project_id: string }>(taskId)) as { project_id: string };
    return row.project_id;
  }

  async park(taskId: number, agent: string): Promise<TaskBrief> {
    await this.db.transaction(async () => {
      await this.requireLease(taskId, agent);
      await this.db
        .prepare("UPDATE tasks SET state='PARKED', lease_agent=NULL, lease_expires_at=NULL, updated_at=? WHERE id=?")
        .run(Date.now(), taskId);
    });
    return this.briefAndNotify(taskId);
  }

  async block(
    taskId: number,
    agent: string,
    reason: string,
    options: { kind?: BlockKind; retryAfterMs?: number } = {},
  ): Promise<TaskBrief> {
    const { runWithDeferredPushes } = await import("./push-dispatch.js");
    // addQuestions defers push while nested; drain only this request's bag after commit.
    await runWithDeferredPushes(this.db, async () =>
      this.db.transaction(async () => {
        await this.requireLease(taskId, agent);
        const now = Date.now();
        const kind = options.kind ?? "human";
        const retryAfterMs = options.retryAfterMs ?? DEFAULT_INFRA_RETRY_MS;
        if (kind === "infra_failure" && (!Number.isFinite(retryAfterMs) || retryAfterMs <= 0)) {
          throw new Error("infra_failure retryAfterMs must be positive");
        }
        await this.db
          .prepare(
            `UPDATE tasks SET state='BLOCKED', block_kind=?, block_requeue_at=?,
                              lease_agent=NULL, lease_expires_at=NULL, updated_at=? WHERE id=?`,
          )
          .run(kind, kind === "infra_failure" ? now + retryAfterMs : null, now, taskId);
        await this.db
          .prepare("INSERT INTO attempts (task_id, agent, outcome, notes, created_at) VALUES (?, ?, 'blocked', ?, ?)")
          .run(taskId, agent, reason, now);
        if (kind !== "infra_failure") {
          // Human-owned blocks land with an answerable handle. Infrastructure
          // blocks use their retry clock instead and must not page a human.
          const [questionId] = await this.addQuestions(
            await this.projectOf(taskId),
            taskId,
            agent,
            `blocked: ${reason} — what should happen?`,
          );
          if (!questionId) {
            throw new Error(`block reason for task ${taskId} did not produce an open question`);
          }
        }
      }),
    );
    return this.briefAndNotify(taskId);
  }

  /** Requeue expired infrastructure blocks and repair legacy blocks with no exit trigger. */
  async recoverBlockedTasks(now = Date.now()): Promise<number[]> {
    const candidates = await this.db.prepare(
      `SELECT t.id, t.project_id, t.block_kind, t.block_requeue_at
       FROM tasks t
       WHERE t.state='BLOCKED' AND (
         (t.block_kind='infra_failure' AND t.block_requeue_at<=?) OR
         ((t.block_kind<>'infra_failure' OR t.block_kind IS NULL OR t.block_requeue_at IS NULL) AND NOT EXISTS (
           SELECT 1 FROM questions q WHERE q.task_id=t.id AND q.status='open'
         ))
       )
       ORDER BY t.id`,
    ).all<{ id: number; project_id: string; block_kind: BlockKind | null; block_requeue_at: number | null }>(now);
    const recovered: number[] = [];
    const projects = new Set<string>();
    for (const candidate of candidates) {
      const infraRetry = candidate.block_kind === "infra_failure" && candidate.block_requeue_at !== null;
      const changed = await this.db.transaction(async () => {
        const result = await this.db.prepare(
          `UPDATE tasks SET state='QUEUED', block_kind=NULL, block_requeue_at=NULL,
                            queued_at=?, queue_generation=queue_generation+1, updated_at=?
           WHERE id=? AND state='BLOCKED' AND (
             (block_kind='infra_failure' AND block_requeue_at<=?) OR
             ((block_kind<>'infra_failure' OR block_kind IS NULL OR block_requeue_at IS NULL) AND NOT EXISTS (
               SELECT 1 FROM questions q WHERE q.task_id=tasks.id AND q.status='open'
             ))
           )`,
        ).run(now, now, candidate.id, now);
        if (result.changes !== 1) return false;
        await this.db.prepare(
          "INSERT INTO attempts (task_id, agent, outcome, notes, created_at) VALUES (?, 'system', 'released', ?, ?)",
        ).run(candidate.id, infraRetry
          ? "auto-requeued: infrastructure retry clock elapsed"
          : "auto-requeued: recovered BLOCKED task with no open question or retry trigger", now);
        return true;
      });
      if (!changed) continue;
      recovered.push(candidate.id);
      projects.add(candidate.project_id);
    }
    for (const projectId of projects) {
      this.events.emit("enqueued", projectId);
      this.notifyChanged(projectId);
    }
    return recovered;
  }

  /**
   * Requeue dependency-backed HELD tasks once every predecessor is DONE and no
   * other durable hold condition remains. Condition-backed hold causes are
   * eligible directly; legacy NULL causes require a dependency edge. Explicit
   * mediator deferrals are never eligible. The optional predecessor scope is
   * used by complete(); the unscoped form is the periodic repair backstop.
   */
  async recoverDependencyHolds(
    opts: { projectId?: string; predecessorId?: number; now?: number } = {},
  ): Promise<number[]> {
    const now = opts.now ?? Date.now();
    const scopeClauses: string[] = [];
    const scopeParams: Array<string | number> = [];
    if (opts.projectId !== undefined) {
      scopeClauses.push("t.project_id=?");
      scopeParams.push(opts.projectId);
    }
    if (opts.predecessorId !== undefined) {
      scopeClauses.push(`EXISTS (
        SELECT 1 FROM task_deps scope_dep
        WHERE scope_dep.task_id=t.id AND scope_dep.depends_on=?
      )`);
      scopeParams.push(opts.predecessorId);
    }
    const scopeSql = scopeClauses.length > 0 ? `AND ${scopeClauses.join(" AND ")}` : "";
    const candidates = await this.db.prepare(
      `SELECT t.id, t.project_id
       FROM tasks t
       WHERE t.state='HELD'
         ${scopeSql}
         AND (
           t.hold_cause IN ('conflict','question','dependency') OR
           (t.hold_cause IS NULL AND EXISTS (SELECT 1 FROM task_deps origin WHERE origin.task_id=t.id))
         )
         AND NOT EXISTS (
           SELECT 1 FROM questions q
           WHERE q.task_id=t.id AND q.asked_by='mediator' AND q.status='open'
         )
         AND NOT EXISTS (
           SELECT 1 FROM conversation_tasks ct JOIN conversations c ON c.id=ct.conversation_id
           WHERE ct.task_id=t.id AND c.state='OPEN'
         )
         AND NOT EXISTS (
           SELECT 1 FROM task_deps d JOIN tasks pre ON pre.id=d.depends_on
           WHERE d.task_id=t.id AND pre.state<>'DONE'
         )
       ORDER BY t.id`,
    ).all<{ id: number; project_id: string }>(...scopeParams);

    const recovered: number[] = [];
    const projects = new Set<string>();
    for (const candidate of candidates) {
      const changed = await this.db.transaction(async () => {
        const result = await this.db.prepare(
          `UPDATE tasks
           SET state='QUEUED', result_summary=NULL,
               lease_agent=NULL, lease_expires_at=NULL, plan_deadline=NULL,
               block_kind=NULL, block_requeue_at=NULL, hold_cause=NULL,
               queued_at=?, queue_generation=queue_generation+1, updated_at=?
           WHERE id=? AND state='HELD'
             AND (
               hold_cause IN ('conflict','question','dependency') OR
               (hold_cause IS NULL AND EXISTS (SELECT 1 FROM task_deps origin WHERE origin.task_id=tasks.id))
             )
             AND NOT EXISTS (
               SELECT 1 FROM questions q
               WHERE q.task_id=tasks.id AND q.asked_by='mediator' AND q.status='open'
             )
             AND NOT EXISTS (
               SELECT 1 FROM conversation_tasks ct JOIN conversations c ON c.id=ct.conversation_id
               WHERE ct.task_id=tasks.id AND c.state='OPEN'
             )
             AND NOT EXISTS (
               SELECT 1 FROM task_deps d JOIN tasks pre ON pre.id=d.depends_on
               WHERE d.task_id=tasks.id AND pre.state<>'DONE'
             )`,
        ).run(now, now, candidate.id);
        if (result.changes !== 1) return false;
        await this.db.prepare(
          "INSERT INTO attempts (task_id, agent, outcome, notes, created_at) VALUES (?, 'system', 'released', 'auto-requeued: HELD conditions resolved', ?)",
        ).run(candidate.id, now);
        return true;
      });
      if (!changed) continue;
      recovered.push(candidate.id);
      projects.add(candidate.project_id);
    }
    for (const recoveredProject of projects) {
      this.events.emit("enqueued", recoveredProject);
      this.notifyChanged(recoveredProject);
    }
    return recovered;
  }

  /** Give a leased task back: immediate requeue with the reason in the attempt history. */
  async release(taskId: number, agent: string, reason: string): Promise<TaskBrief> {
    await this.db.transaction(async () => {
      await this.requireLease(taskId, agent);
      const now = Date.now();
      await this.db
        .prepare(
          `UPDATE tasks SET state='QUEUED', lease_agent=NULL, lease_expires_at=NULL,
                            plan_deadline=NULL, queued_at=?, queue_generation=queue_generation+1, updated_at=? WHERE id=?`,
        )
        .run(now, now, taskId);
      await this.db
        .prepare("INSERT INTO attempts (task_id, agent, outcome, notes, created_at) VALUES (?, ?, 'released', ?, ?)")
        .run(taskId, agent, reason, now);
    });
    const brief = await this.brief(taskId);
    // a released task is claimable work again — wake parked waiters
    this.events.emit("enqueued", brief.project_id);
    this.notifyChanged(brief.project_id);
    return brief;
  }

  async approvePlan(taskId: number, plan: string): Promise<TaskBrief> {
    const now = Date.now();
    await this.db
      .prepare(
        `UPDATE tasks SET state='PLANNED', plan=?, plan_approved_at=?, plan_deadline=NULL, updated_at=?
         WHERE id=? AND state IN ('CLAIMED','EXECUTING')`,
      )
      .run(plan, now, now, taskId);
    return this.briefAndNotify(taskId);
  }

  async answerQuestion(
    questionId: number,
    answer: string,
    byName: string,
  ): Promise<{ project_id: string; task_id: number | null; event_generations: Array<{ domain: string; generation: number }> }> {
    const answered = await this.db.transaction(async () => {
      const qrow = await this.db
        .prepare("SELECT project_id, task_id, domain FROM questions WHERE id=? AND status='open'")
        .get<{ project_id: string; task_id: number | null; domain: string | null }>(questionId);
      if (!qrow) throw new Error(`question ${questionId} not found or already answered`);
      const now = Date.now();
      const update = await this.db.prepare(
        "UPDATE questions SET answer=?, answered_by=?, status='answered', answered_at=? WHERE id=? AND status='open'",
      ).run(answer, byName.trim() || "unknown human", now, questionId);
      if (update.changes !== 1) throw new Error(`question ${questionId} was answered concurrently`);
      const event_generations = qrow.task_id === null && isProjectKnowledgeDomain(qrow.domain)
        ? await new ProjectKnowledgeState(this.db).markEvent(
            qrow.project_id,
            [qrow.domain],
            `human answered project question Q${questionId}`,
            now,
          )
        : [];
      if (qrow.task_id !== null) {
        await this.db
          .prepare("UPDATE tasks SET state='QUEUED', block_kind=NULL, block_requeue_at=NULL, queued_at=?, queue_generation=queue_generation+1, updated_at=? WHERE id=? AND state IN ('PARKED','BLOCKED')")
          .run(now, now, qrow.task_id);
      }
      await this.questionLedger.sync(qrow.project_id);
      return { ...qrow, event_generations };
    });
    // a task freed by an answer is new work — wake parked waiters after commit
    if (answered.task_id !== null) this.events.emit("enqueued", answered.project_id);
    this.notifyChanged(answered.project_id);
    return answered;
  }

  /** Resolves when queue eligibility may have changed, or after timeoutMs. */
  private waitForEnqueueAny(projectIds: string[], timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const watched = new Set(projectIds);
      const emitter = this.events;
      const onEnqueued = (projectId: string) => {
        if (watched.has(projectId)) done();
      };
      const timer = setTimeout(() => done(), timeoutMs);
      function done() {
        clearTimeout(timer);
        emitter.removeListener("enqueued", onEnqueued);
        resolve();
      }
      emitter.on("enqueued", onEnqueued);
    });
  }

  static readonly MAX_WAIT_S = 90;
  static readonly POLL_TICK_MS = 5000;

  /**
   * Read-only availability probe. Expired leases and plan windows count as
   * available because claimNext will lazily requeue them when a coder elects
   * to claim. This method must never perform that sweep itself: callers may
   * safely abandon an outstanding long-poll without acquiring a lease.
   */
  private async availableInProject(
    projectId: string,
    agent: string,
    peekLimit: number,
  ): Promise<WorkAvailability> {
    const now = Date.now();
    const eligible = `t.project_id = ? AND (
           (
             t.state = 'QUEUED'
             AND NOT EXISTS (
               SELECT 1 FROM attempts a
               WHERE a.task_id = t.id AND a.agent = ? AND a.outcome = 'released'
                 AND a.created_at > ?
                 AND a.id = (SELECT MAX(id) FROM attempts WHERE task_id = t.id)
             )
           )
           OR (t.state IN ('CLAIMED','PLANNED','EXECUTING') AND t.lease_expires_at < ?)
           OR (
             t.state IN ('CLAIMED','EXECUTING')
             AND t.plan_deadline IS NOT NULL AND t.plan_deadline < ?
           )
         )`;
    const params = [projectId, agent, now - RELEASE_COOLDOWN_MS, now - LEASE_RECOVERY_GRACE_MS, now] as const;
    const count = await this.db
      .prepare(`SELECT COUNT(*) AS count FROM tasks t WHERE ${eligible}`)
      .get<{ count: number | string }>(...params);
    const rows = peekLimit === 0
      ? []
      : await this.db
        .prepare(
          `SELECT t.project_id, t.title, t.priority
           FROM tasks t WHERE ${eligible}
           ORDER BY
           (SELECT COUNT(*) FROM task_deps d JOIN tasks pre ON pre.id = d.depends_on
            WHERE d.task_id = t.id AND pre.state <> 'DONE') ASC,
           t.priority ASC, t.id ASC LIMIT ?`,
        )
        .all<{ project_id: string; title: string; priority: number }>(...params, peekLimit);
    return {
      available_count: Number(count?.count ?? 0),
      peek: rows,
    };
  }

  async checkWork(
    projectId: string,
    agent: string,
    timeoutS: number,
    peekLimit = 0,
  ): Promise<WorkAvailability> {
    return this.checkWorkAny([projectId], agent, timeoutS, peekLimit);
  }

  async checkWorkAny(
    projectIds: string[],
    agent: string,
    timeoutS: number,
    peekLimit = 0,
  ): Promise<WorkAvailability> {
    const deadline = Date.now() + Math.min(timeoutS, Queue.MAX_WAIT_S) * 1000;
    for (;;) {
      let availableCount = 0;
      const peek: WorkPeek[] = [];
      for (const projectId of projectIds) {
        const available = await this.availableInProject(projectId, agent, Math.max(0, peekLimit - peek.length));
        availableCount += available.available_count;
        peek.push(...available.peek);
      }
      if (availableCount > 0) return { available_count: availableCount, peek };
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { available_count: 0, peek: [] };
      await this.waitForEnqueueAny(projectIds, Math.min(remaining, Queue.POLL_TICK_MS));
    }
  }

  /**
   * Claimable-count for a role's waiter (Fix A — the `memracer wait` backend).
   * Mirrors the coder claim eligibility used by checkWork/availableInProject
   * (a QUEUED task not on this-agent release cooldown, OR a lease that expired,
   * OR an unplanned CLAIMED/EXECUTING task past its plan window). Only the coder
   * role draws from this queue; other roles have no claimable work here, so
   * their depth is always 0. Pass no agent — the waiter is not a specific seat,
   * so the per-agent release cooldown never applies. One COUNT, kept cheap.
   */
  async claimableCount(projectId: string, role: string): Promise<number> {
    if (role !== "coder") return 0;
    const { available_count } = await this.availableInProject(projectId, "", 0);
    return available_count;
  }

  async claimNextAny(projectIds: string[], agent: string, ttlMs: number): Promise<TaskBrief | null> {
    for (const projectId of projectIds) {
      const brief = await this.claimNext(projectId, agent, ttlMs);
      if (brief) return brief;
    }
    return null;
  }
}
