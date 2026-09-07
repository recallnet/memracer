import { AsyncLocalStorage } from "node:async_hooks";
import Database from "better-sqlite3";
import type { Db, RunResult, SqlValue, Statement } from "./driver.js";
import {
  ATTEMPTS_COLUMNS,
  DECISION_COLUMNS,
  EVIDENCE_COLUMN_NAMES,
  EVIDENCE_COLUMNS,
  GITHUB_INSTALLATIONS_COLUMNS,
  JOBS_COLUMNS,
  QUESTIONS_COLUMNS,
  TASKS_COLUMNS,
  TASKS_COLUMN_NAMES,
  THREADS_COLUMNS,
  renderSchema,
} from "./schema.js";

type RawDb = Database.Database;

/**
 * Widen the jobs.kind CHECK on databases created before the 'curate',
 * 'discuss', 'reconcile', 'catchup', 'seal', 'enhance', 'conciliate', or
 * 'consolidate', or 'refresh' job kinds. SQLite cannot ALTER a CHECK, so this is the
 * documented rebuild: create the table with the new definition, copy, drop,
 * rename — one transaction.
 */
function migrateJobsKindCheck(db: RawDb): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='jobs'")
    .get() as { sql: string } | undefined;
  if (
    !row ||
    (row.sql.includes("'curate'") &&
      row.sql.includes("'discuss'") &&
      row.sql.includes("'reconcile'") &&
      row.sql.includes("'catchup'") &&
      row.sql.includes("'seal'") &&
      row.sql.includes("'enhance'") &&
      row.sql.includes("'conciliate'") &&
      row.sql.includes("'consolidate'") &&
      row.sql.includes("'refresh'"))
  )
    return;
  db.transaction(() => {
    db.exec(`
      CREATE TABLE jobs_new (${JOBS_COLUMNS});
      INSERT INTO jobs_new SELECT * FROM jobs;
      DROP TABLE jobs;
      ALTER TABLE jobs_new RENAME TO jobs;
      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status, id);
    `);
  })();
}

/**
 * Widen the decision_log.kind CHECK on databases created before the 'close'
 * and 'update' decision kinds (mediator discuss actions). Same rebuild
 * pattern as migrateJobsKindCheck.
 */
function migrateDecisionKindCheck(db: RawDb): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='decision_log'")
    .get() as { sql: string } | undefined;
  if (
    !row ||
    (row.sql.includes("'close'") &&
      row.sql.includes("'update'") &&
      row.sql.includes("'hold'") &&
      row.sql.includes("'reopen'"))
  )
    return;
  db.transaction(() => {
    db.exec(`
      CREATE TABLE decision_log_new (${DECISION_COLUMNS});
      INSERT INTO decision_log_new SELECT * FROM decision_log;
      DROP TABLE decision_log;
      ALTER TABLE decision_log_new RENAME TO decision_log;
    `);
  })();
}

/**
 * Widen the evidence.kind CHECK and install the metadata-only image guard on
 * databases created before image attachments. Columns are copied by explicit
 * name because ensureColumns appends image metadata after legacy columns.
 */
function migrateEvidenceKindCheck(db: RawDb): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='evidence'")
    .get() as { sql: string } | undefined;
  if (!row || (row.sql.includes("'image'") && row.sql.includes("evidence_image_metadata_check"))) return;
  const present = new Set(
    (db.pragma("table_info(evidence)") as { name: string }[]).map((c) => c.name),
  );
  const cols = EVIDENCE_COLUMN_NAMES.filter((c) => present.has(c)).join(", ");
  db.transaction(() => {
    db.exec(`
      CREATE TABLE evidence_new (${EVIDENCE_COLUMNS});
      INSERT INTO evidence_new (${cols}) SELECT ${cols} FROM evidence;
      DROP TABLE evidence;
      ALTER TABLE evidence_new RENAME TO evidence;
      CREATE INDEX IF NOT EXISTS idx_evidence_task ON evidence (task_id);
    `);
  })();
}

/**
 * Widen the attempts.outcome CHECK on databases created before the
 * 'plan_window_expired', 'released', or 'awaiting_merge' outcomes. Same
 * rebuild pattern as migrateJobsKindCheck.
 */
function migrateAttemptsOutcomeCheck(db: RawDb): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='attempts'")
    .get() as { sql: string } | undefined;
  if (
    !row ||
    (row.sql.includes("'plan_window_expired'") &&
      row.sql.includes("'released'") &&
      row.sql.includes("'awaiting_merge'"))
  )
    return;
  db.transaction(() => {
    db.exec(`
      CREATE TABLE attempts_new (${ATTEMPTS_COLUMNS});
      INSERT INTO attempts_new SELECT * FROM attempts;
      DROP TABLE attempts;
      ALTER TABLE attempts_new RENAME TO attempts;
      CREATE INDEX IF NOT EXISTS idx_attempts_task ON attempts (task_id);
    `);
  })();
}

/**
 * Widen the threads.kind CHECK on databases created before the 'submission'
 * thread kind (session-topology roots). Same rebuild pattern as
 * migrateJobsKindCheck, with one twist: threads is a parent table
 * (thread_messages and tasks.root_thread_id reference it), so foreign keys
 * are switched off around the rebuild — DROP TABLE on a referenced parent
 * fails otherwise. Runs after ensureColumns has appended root_id/summary,
 * so INSERT..SELECT * lines up with THREADS_COLUMNS.
 */
function migrateThreadsKindCheck(db: RawDb): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='threads'")
    .get() as { sql: string } | undefined;
  if (!row || row.sql.includes("'submission'")) return;
  db.pragma("foreign_keys = OFF");
  db.transaction(() => {
    db.exec(`
      CREATE TABLE threads_new (${THREADS_COLUMNS});
      INSERT INTO threads_new SELECT * FROM threads;
      DROP TABLE threads;
      ALTER TABLE threads_new RENAME TO threads;
      CREATE INDEX IF NOT EXISTS idx_threads_project ON threads (project_id, id);
    `);
  })();
  db.pragma("foreign_keys = ON");
}

/** Existing databases required every question to belong to a task. Rebuild
 * once so project-level questions can store NULL without losing old rows. */
function migrateQuestionsTaskScope(db: RawDb): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='questions'")
    .get() as { sql: string } | undefined;
  if (!row || !/task_id\s+INTEGER\s+NOT NULL/i.test(row.sql)) return;
  db.transaction(() => {
    db.exec(`
      CREATE TABLE questions_new (${QUESTIONS_COLUMNS});
      INSERT INTO questions_new (id, project_id, task_id, asked_by, question, answer, status, created_at)
        SELECT id, project_id, task_id, asked_by, question, answer, status, created_at FROM questions;
      DROP TABLE questions;
      ALTER TABLE questions_new RENAME TO questions;
    `);
  })();
}

/** Widen the GitHub App installation selection CHECK for databases created
 * before blanket ('all') repository access was supported. The installation
 * table is referenced by github_project_repos, so foreign keys are switched
 * off around the guarded rebuild; rows and child bindings are copied by name.
 * Reopening an already widened database is a no-op. */
function migrateGitHubInstallationSelectionCheck(db: RawDb): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='github_installations'")
    .get() as { sql: string } | undefined;
  if (!row || row.sql.includes("'all'")) return;
  db.pragma("foreign_keys = OFF");
  db.transaction(() => {
    db.exec(`
      CREATE TABLE github_installations_new (${GITHUB_INSTALLATIONS_COLUMNS});
      INSERT INTO github_installations_new
        (installation_id, org_id, account_id, account_login, connected_by, repository_selection, created_at, updated_at)
        SELECT installation_id, org_id, account_id, account_login, connected_by, repository_selection, created_at, updated_at
          FROM github_installations;
      DROP TABLE github_installations;
      ALTER TABLE github_installations_new RENAME TO github_installations;
    `);
  })();
  db.pragma("foreign_keys = ON");
}

/**
 * Rebuild the tasks.state CHECK on databases created before 'INCUBATING',
 * 'HELD', or 'AWAITING_MERGE', or while the retired 'PENDING_VERIFICATION'
 * value was accepted.
 * tasks is a referenced parent (evidence, attempts, decision_log, questions,
 * task_notes, steers, task_deps, and threads.task_id all point at it) with a
 * parent_id self-reference and a circular tasks<->threads FK, so foreign keys
 * are switched off around the rebuild — DROP TABLE on a referenced parent
 * fails otherwise. Copy is by explicit column NAME (not SELECT *): on an
 * existing DB, ensureColumns appends its columns in a physical order that
 * differs from TASKS_COLUMNS, so a positional copy would misalign. The name
 * list is intersected with the columns actually present — a column the old
 * table never had (nullable in the new definition) simply copies as NULL — so
 * the rebuild is robust to any historical tasks shape. Legacy pending rows
 * move directly to DONE before the narrower table is created. Runs after
 * ensureColumns(tasks, ...).
 */
function migrateTasksStateCheck(db: RawDb): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'")
    .get() as { sql: string } | undefined;
  if (
    !row ||
    (row.sql.includes("'INCUBATING'") &&
      row.sql.includes("'HELD'") &&
      row.sql.includes("'AWAITING_MERGE'") &&
      !row.sql.includes("'PENDING_VERIFICATION'"))
  )
    return;
  const present = new Set(
    (db.pragma("table_info(tasks)") as { name: string }[]).map((c) => c.name),
  );
  const cols = TASKS_COLUMN_NAMES.filter((c) => present.has(c)).join(", ");
  db.pragma("foreign_keys = OFF");
  db.transaction(() => {
    db.exec("DROP TRIGGER IF EXISTS tasks_record_state_transition");
    if (present.has("state")) {
      const retiredFields = [
        "state = 'DONE'",
        present.has("pr_verification") ? "pr_verification = NULL" : null,
        present.has("pr_verification_etag") ? "pr_verification_etag = NULL" : null,
      ].filter(Boolean).join(", ");
      db.exec(`UPDATE tasks SET ${retiredFields} WHERE state = 'PENDING_VERIFICATION'`);
    }
    db.exec(`
      CREATE TABLE tasks_new (${TASKS_COLUMNS});
      INSERT INTO tasks_new (${cols}) SELECT ${cols} FROM tasks;
      DROP TABLE tasks;
      ALTER TABLE tasks_new RENAME TO tasks;
      CREATE INDEX IF NOT EXISTS idx_tasks_queue ON tasks (project_id, state, priority, id);
    `);
  })();
  db.pragma("foreign_keys = ON");
}

/**
 * Session-topology backfill for databases that predate root threads: a
 * task's earliest groom thread (fallback: its earliest thread of any kind)
 * becomes the root surrogate — stamped on tasks.root_thread_id and on every
 * other thread of that task as root_id. The surrogate itself keeps
 * root_id NULL (NULL = is a root). Idempotent: only NULL columns are filled.
 */
function backfillThreadRoots(db: RawDb): void {
  db.transaction(() => {
    db.exec(`
      UPDATE tasks SET root_thread_id = COALESCE(
        (SELECT MIN(th.id) FROM threads th WHERE th.task_id = tasks.id AND th.kind = 'groom'),
        (SELECT MIN(th.id) FROM threads th WHERE th.task_id = tasks.id)
      )
      WHERE root_thread_id IS NULL
        AND EXISTS (SELECT 1 FROM threads th WHERE th.task_id = tasks.id);
      UPDATE threads SET root_id = (SELECT t.root_thread_id FROM tasks t WHERE t.id = threads.task_id)
      WHERE root_id IS NULL AND task_id IS NOT NULL
        AND (SELECT t.root_thread_id FROM tasks t WHERE t.id = threads.task_id) IS NOT NULL
        AND id != (SELECT t.root_thread_id FROM tasks t WHERE t.id = threads.task_id);
    `);
  })();
}

/**
 * Curate-attribution backfill (#86) for databases whose memory_log predates
 * task_id: parse `curated@<decision_id>:` and read that decision's task_id.
 * Idempotent — only touches task_id IS NULL rows, and only sets a value when
 * the decision exists AND carries a task. Unmappable rows (bad/absent
 * decision, task-less decision, non-curate entries like "skipped invalid op")
 * stay null and surface in no task timeline — the desired outcome.
 */
function backfillMemoryLogTaskId(db: RawDb): void {
  const decisionId =
    "CAST(substr(memory_log.entry, 9, instr(substr(memory_log.entry, 9), ':') - 1) AS INTEGER)";
  db.exec(`
    UPDATE memory_log SET task_id = (
      SELECT dl.task_id FROM decision_log dl
      WHERE dl.project_id = memory_log.project_id AND dl.id = ${decisionId}
    )
    WHERE task_id IS NULL
      AND entry LIKE 'curated@%:%'
      AND (
        SELECT dl.task_id FROM decision_log dl
        WHERE dl.project_id = memory_log.project_id AND dl.id = ${decisionId}
      ) IS NOT NULL;
  `);
}

/**
 * Add columns that CREATE TABLE IF NOT EXISTS will not backfill on existing
 * databases. Idempotent: consults pragma table_info first. No-op when the
 * table itself is missing (SCHEMA creates it complete).
 */
function ensureColumns(db: RawDb, table: string, columns: Record<string, string>): void {
  const existing = new Set(
    (db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name),
  );
  if (existing.size === 0) return;
  for (const [name, decl] of Object.entries(columns)) {
    if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
  }
}

/**
 * The SQLite backend: better-sqlite3 (synchronous under the hood) behind the
 * async Db seam. A driver-level mutex serializes transactions against every
 * other statement, so an awaited callback can never interleave a foreign
 * statement into an open BEGIN..COMMIT; statements issued INSIDE the
 * transaction callback are recognized via AsyncLocalStorage and run
 * directly.
 */
export class SqliteDb implements Db {
  readonly dialect = "sqlite" as const;
  private readonly inTx = new AsyncLocalStorage<true>();
  private lock: Promise<void> = Promise.resolve();

  constructor(readonly raw: RawDb) {}

  /** Escape hatch for SQLite-specific maintenance (WAL checkpoints, table_info). */
  pragma(directive: string): unknown {
    return this.raw.pragma(directive);
  }

  /** better-auth drives the raw better-sqlite3 handle directly. */
  authDatabase(): unknown {
    return this.raw;
  }

  private async withLock<T>(fn: () => T | Promise<T>): Promise<T> {
    if (this.inTx.getStore()) return await fn();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const prev = this.lock;
    this.lock = prev.then(() => gate);
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  prepare(sql: string): Statement {
    let stmt: Database.Statement | undefined;
    const compiled = () => (stmt ??= this.raw.prepare(sql));
    return {
      get: <T>(...params: SqlValue[]) =>
        this.withLock(() => compiled().get(...params) as T | undefined),
      all: <T>(...params: SqlValue[]) =>
        this.withLock(() => compiled().all(...params) as T[]),
      run: (...params: SqlValue[]): Promise<RunResult> =>
        this.withLock(() => {
          const info = compiled().run(...params);
          return { changes: info.changes };
        }),
    };
  }

  exec(sql: string): Promise<void> {
    return this.withLock(() => {
      this.raw.exec(sql);
    });
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inTx.getStore()) return fn(); // nested: flatten into the enclosing transaction
    return this.withLock(async () => {
      this.raw.exec("BEGIN IMMEDIATE");
      try {
        const result = await this.inTx.run(true, fn);
        this.raw.exec("COMMIT");
        return result;
      } catch (err) {
        this.raw.exec("ROLLBACK");
        throw err;
      }
    });
  }

  isInTransaction(): boolean {
    return this.inTx.getStore() === true;
  }

  async close(): Promise<void> {
    this.raw.close();
  }
}

export function openDb(path: string): SqliteDb {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // coalesce_key is physically last in JOBS_COLUMNS, so adding it before the
  // legacy CHECK rebuild keeps that rebuild's positional copy aligned. Old
  // rows remain NULL and cannot collide in the new partial unique index.
  ensureColumns(db, "jobs", { coalesce_key: "TEXT" });
  migrateJobsKindCheck(db);
  // Citations are appended before the CHECK rebuild so its SELECT * copy has
  // the same physical column order as DECISION_COLUMNS on legacy databases.
  ensureColumns(db, "decision_log", { citations: "TEXT NOT NULL DEFAULT '[]'" });
  migrateDecisionKindCheck(db);
  migrateAttemptsOutcomeCheck(db);
  // The CHECK rebuild below copies by name after these nullable metadata
  // columns are appended. Existing text evidence remains metadata-free.
  ensureColumns(db, "evidence", {
    blob_ref: "TEXT",
    mime_type: "TEXT",
    caption: "TEXT",
  });
  migrateEvidenceKindCheck(db);
  const existingQuestionColumns = new Set(
    (db.pragma("table_info(questions)") as { name: string }[]).map((column) => column.name),
  );
  const backfillExistingProjectAnswers =
    existingQuestionColumns.size > 0 && !existingQuestionColumns.has("curated_at");
  migrateQuestionsTaskScope(db);
  ensureColumns(db, "questions", {
    domain: "TEXT",
    refresh_trigger: "TEXT",
    answered_by: "TEXT",
    answered_at: "INTEGER",
    curated_at: "INTEGER",
  });
  // Run exactly once, when curated_at first lands. Repeating this on boot
  // would incorrectly hide a newly answered row whose curation job failed.
  if (backfillExistingProjectAnswers) {
    db.exec(`UPDATE questions
                SET curated_at = COALESCE(answered_at, created_at)
              WHERE task_id IS NULL AND status='answered' AND curated_at IS NULL`);
  }
  db.exec("DROP INDEX IF EXISTS idx_questions_project_unique");
  // root_id/summary land before the CHECK rebuild so SELECT * lines up.
  ensureColumns(db, "threads", {
    root_id: "INTEGER REFERENCES threads(id)",
    summary: "TEXT",
  });
  migrateThreadsKindCheck(db);
  // Rich thread capture (#45): reasoning trace, structured decision, model and
  // token usage travel alongside each message. Additive + nullable — existing
  // rows keep NULL, no data migration.
  ensureColumns(db, "thread_messages", {
    reasoning: "TEXT",
    structured: "TEXT",
    model: "TEXT",
    usage: "TEXT",
  });
  // Org layer on existing DBs (fresh DBs get this from CREATE). org_id is added
  // without an inline REFERENCES: SQLite cannot add a foreign-key column to an
  // existing table via ALTER. (The legacy members/memberships tables are gone —
  // #90 — so no member-column migration remains.)
  ensureColumns(db, "projects", {
    org_id: "TEXT",
    created_by: "TEXT",
    attention_grace_ms: "INTEGER NOT NULL DEFAULT 900000",
    attention_cooldown_ms: "INTEGER NOT NULL DEFAULT 1800000",
    last_active_lease_at: "INTEGER",
    claim_generation: "INTEGER NOT NULL DEFAULT 0",
    archived_at: "INTEGER",
    archived_by: "TEXT",
    provider_key_mode: "TEXT NOT NULL DEFAULT 'inherit'",
    provider_key_id: "TEXT",
    project_key_ciphertext: "TEXT",
    project_key_iv: "TEXT",
    project_key_tag: "TEXT",
    project_key_last4: "TEXT",
    lite_model_mode: "TEXT",
    lite_model: "TEXT",
    thinking_model_mode: "TEXT",
    thinking_model: "TEXT",
  });
  // Team-creator + soft-delete + BYOK policy (no org-membership table exists).
  ensureColumns(db, "orgs", {
    created_by: "TEXT",
    archived_at: "INTEGER",
    archived_by: "TEXT",
    provider_id: "TEXT NOT NULL DEFAULT 'openrouter'",
    custom_base_url: "TEXT",
    lite_model_mode: "TEXT NOT NULL DEFAULT 'use_default'",
    lite_model: "TEXT",
    thinking_model_mode: "TEXT NOT NULL DEFAULT 'use_default'",
    thinking_model: "TEXT",
    allow_project_model_override: "INTEGER NOT NULL DEFAULT 0",
    project_create_policy: "TEXT NOT NULL DEFAULT 'any_org_member'",
    default_provider_key_id: "TEXT",
    stripe_customer_id: "TEXT",
    stripe_subscription_id: "TEXT",
    plan: "TEXT NOT NULL DEFAULT 'none'",
    seat_quantity: "INTEGER NOT NULL DEFAULT 0",
    billing_status: "TEXT NOT NULL DEFAULT 'none'",
    current_period_end: "INTEGER",
    billing_email: "TEXT",
    // Stripe event.created (ms) of last applied status-changing billing event.
    billing_last_event_created: "INTEGER",
  });
  db.exec(`
    CREATE TABLE IF NOT EXISTS stripe_events (
      event_id     TEXT PRIMARY KEY,
      processed_at INTEGER NOT NULL
    );
  `);
  // Seat enrollment grants (Part A) on existing DBs. renderSchema() also emits
  // this table below, but keep an explicit additive migration so the table is
  // guaranteed present regardless of schema-render ordering. Idempotent.
  db.exec(`
    CREATE TABLE IF NOT EXISTS seat_enrollments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_by TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      redeemed_at INTEGER,
      redeemed_key_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_seat_enrollments_project
      ON seat_enrollments (project_id, created_at);
  `);
  // Per-project roles (Part F) on existing DBs. renderSchema() also emits this
  // table, but keep an explicit additive migration so it is guaranteed present
  // regardless of schema-render ordering. Idempotent.
  db.exec(`
    CREATE TABLE IF NOT EXISTS roles (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      slug TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('human','worker')),
      display_name TEXT NOT NULL,
      system_prompt TEXT,
      model TEXT,
      always_available INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, slug)
    );
  `);
  ensureColumns(db, "tasks", {
    result_pr_number: "INTEGER",
    result_pr_description: "TEXT",
    pr_verification: "TEXT",
    pr_verification_etag: "TEXT",
    plan: "TEXT",
    plan_deadline: "INTEGER",
    plan_approved_at: "INTEGER",
    lease_ttl_ms: "INTEGER NOT NULL DEFAULT 1800000",
    root_thread_id: "INTEGER REFERENCES threads(id)",
    watermark: "TEXT",
    // Warming period (#61): graduation timestamp for an INCUBATING task.
    // Added before migrateTasksStateCheck so its named copy finds the column.
    incubate_until: "INTEGER",
    block_kind: "TEXT",
    block_requeue_at: "INTEGER",
    hold_cause: "TEXT CHECK (hold_cause IN ('conflict','question','dependency','explicit'))",
    // Queue-entry clock: metadata edits keep it stable; every transition back
    // to QUEUED assigns a new value in Queue/pipeline mutation paths.
    queued_at: "INTEGER",
    queue_generation: "INTEGER NOT NULL DEFAULT 0",
    // CI-fix open-child dedup (#472). Nullable so non-CI-fix rows stay out of
    // the partial unique index (idx_tasks_open_ci_fix).
    ci_fix_key: "TEXT",
    // First consecutive merge-probe failure timestamp (#485). Null when healthy.
    merge_probe_transient_since: "INTEGER",
  });
  // Widen the state CHECK after every task column exists to copy.
  migrateTasksStateCheck(db);
  // Curate attribution (#86): additive nullable FK on existing DBs. Mirrors
  // the root_thread_id nullable-FK pattern above.
  ensureColumns(db, "memory_log", { task_id: "INTEGER REFERENCES tasks(id)" });
  ensureColumns(db, "memory_docs", {
    source_task: "INTEGER",
    as_of: "TEXT",
    supersedes: "TEXT NOT NULL DEFAULT '[]'",
    superseded_by: "TEXT NOT NULL DEFAULT '[]'",
  });
  migrateGitHubInstallationSelectionCheck(db);
  db.exec(renderSchema("sqlite"));
  ensureColumns(db, "mcp_sessions", { next_event_sequence: "INTEGER NOT NULL DEFAULT 1" });
  // Negotiation ↔ questions ledger link (#473). Nullable; reconnect close
  // prefers question_id over text-matching the current_prompt.
  ensureColumns(db, "negotiations", { question_id: "INTEGER REFERENCES questions(id)" });
  // Legacy rows have no exact queue-entry clock. updated_at is conservative:
  // it may postpone one alert, while created_at could falsely age a task that
  // requeued recently. All post-migration transitions maintain queued_at.
  db.exec("UPDATE tasks SET queued_at = updated_at WHERE queued_at IS NULL AND state = 'QUEUED'");
  db.exec("UPDATE tasks SET queue_generation = 1 WHERE queue_generation = 0 AND state = 'QUEUED'");
  // Bidirectional root link (#499): backfill threads.task_id for submission
  // roots that only have tasks.root_thread_id. Earliest task owns a shared root.
  // Idempotent: never overwrites a non-NULL task_id.
  db.exec(
    `UPDATE threads SET task_id = (
       SELECT MIN(t.id) FROM tasks t WHERE t.root_thread_id = threads.id
     )
     WHERE task_id IS NULL
       AND EXISTS (SELECT 1 FROM tasks t WHERE t.root_thread_id = threads.id)`,
  );
  ensureColumns(db, "attention_alerts", {
    queue_generation: "INTEGER NOT NULL DEFAULT 0",
    claim_generation: "INTEGER NOT NULL DEFAULT 0",
  });
  backfillThreadRoots(db);
  backfillMemoryLogTaskId(db);
  return new SqliteDb(db);
}
