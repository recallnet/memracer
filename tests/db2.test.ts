import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openDb, renderSchema } from "../src/db.js";
import { openTestDb, testDialect } from "./helpers/db.js";

describe("stage-2 schema", () => {
  it("postgres replaces the legacy verification state CHECK and normalizes rows", async () => {
    if (testDialect() !== "postgres") return;
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
    await db.exec(`
      ALTER TABLE tasks DROP CONSTRAINT tasks_state_check;
      ALTER TABLE tasks ADD CONSTRAINT tasks_state_check
        CHECK (state IN ('INCUBATING','QUEUED','CLAIMED','PLANNED','EXECUTING','PENDING_VERIFICATION','DONE','BLOCKED','PARKED','HELD'));
      INSERT INTO tasks (project_id, title, body, submitted_by, state,
                         pr_verification, pr_verification_etag, created_at, updated_at)
        VALUES ('p','legacy','b','dana','PENDING_VERIFICATION','verified-open','etag',1,1);
    `);

    await db.exec(renderSchema("postgres"));

    expect(await db.prepare(
      "SELECT state, pr_verification, pr_verification_etag FROM tasks WHERE title='legacy'",
    ).get()).toEqual({ state: "DONE", pr_verification: null, pr_verification_etag: null });
    expect(await db.prepare(
      "SELECT COUNT(*) AS n FROM task_transitions WHERE from_state = 'PENDING_VERIFICATION' OR to_state = 'PENDING_VERIFICATION'",
    ).get()).toEqual({ n: 0 });
    await expect(db.prepare(
      "INSERT INTO tasks (project_id, title, body, submitted_by, state, created_at, updated_at) VALUES ('p','bad','b','dana','PENDING_VERIFICATION',2,2)",
    ).run()).rejects.toThrow();
    await db.exec(renderSchema("postgres"));
  });

  it("has mediator tables and new task/project columns", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
    const model = (await db.prepare("SELECT mediator_model FROM projects WHERE id='p'").get()) as {
      mediator_model: string;
    };
    expect(model.mediator_model).toBe("z-ai/glm-5.2");

    const now = Date.now();
    await db.prepare(
      `INSERT INTO tasks (project_id, title, body, submitted_by, grooming_rationale, parent_id, created_at, updated_at)
       VALUES ('p','t','b','dana','because',NULL,?,?)`,
    ).run(now, now);

    await db.prepare(
      "INSERT INTO jobs (project_id, kind, payload, created_at, updated_at) VALUES ('p','groom','{}',?,?)",
    ).run(now, now);
    const job = (await db.prepare("SELECT status, attempts FROM jobs").get()) as {
      status: string;
      attempts: number;
    };
    expect(job).toEqual({ status: "pending", attempts: 0 });

    await db.prepare(
      "INSERT INTO threads (project_id, kind, task_id, created_at) VALUES ('p','groom',1,?)",
    ).run(now);
    await db.prepare(
      "INSERT INTO thread_messages (thread_id, role, author, content, created_at) VALUES (1,'mediator','mediator','hi',?)",
    ).run(now);
    await db.prepare(
      "INSERT INTO decision_log (project_id, task_id, kind, summary, rationale, created_at) VALUES ('p',1,'create','made task','why',?)",
    ).run(now);
    await db.prepare(
      "INSERT INTO questions (project_id, task_id, asked_by, question, created_at) VALUES ('p',1,'mediator','what?',?)",
    ).run(now);
    await db.prepare(
      "INSERT INTO steers (task_id, author, instruction, created_at) VALUES (1,'dana','go left',?)",
    ).run(now);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM decision_log").get()).toEqual({ n: 1 });
  });

  it("migrates legacy task-only questions to nullable task scope", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "memracer-questions-mig-")), "mini.db");
    const old = new Database(path);
    old.exec(renderSchema("sqlite"));
    old.exec(`
      DROP INDEX idx_questions_project_open_text;
      DROP INDEX idx_questions_project_open_domain;
      DROP TABLE questions;
      CREATE TABLE questions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES projects(id),
        task_id INTEGER NOT NULL REFERENCES tasks(id),
        asked_by TEXT NOT NULL,
        question TEXT NOT NULL,
        answer TEXT,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered')),
        created_at INTEGER NOT NULL
      );
      INSERT INTO projects (id, name) VALUES ('p','P');
      INSERT INTO tasks (project_id, title, body, submitted_by, created_at, updated_at)
        VALUES ('p','t','b','dana',1,1);
      INSERT INTO questions (project_id, task_id, asked_by, question, created_at)
        VALUES ('p',1,'mediator','legacy?',1);
    `);
    old.close();

    const db = openDb(path);
    expect(await db.prepare("SELECT id, task_id, question FROM questions WHERE id=1").get()).toEqual({
      id: 1,
      task_id: 1,
      question: "legacy?",
    });
    await db
      .prepare(
        "INSERT INTO questions (project_id, task_id, asked_by, question, created_at) VALUES ('p',NULL,'mediator','project?',2)",
      )
      .run();
    expect(await db.prepare("SELECT task_id FROM questions WHERE id=2").get()).toEqual({ task_id: null });
    await db.close();
  });

  it("has mediator memory tables", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
    const now = Date.now();
    await db.prepare(
      `INSERT INTO memory_docs (project_id, path, type, title, description, tags, body, updated_at)
       VALUES ('p','learnings/x.md','Learning','X','desc','["a"]','body',?)`,
    ).run(now);
    // same primary key overwrites via upsert semantics at the store layer; raw insert conflicts
    await expect(
      db.prepare(
        `INSERT INTO memory_docs (project_id, path, type, title, description, tags, body, updated_at)
         VALUES ('p','learnings/x.md','Learning','X2','d','[]','b',?)`,
      ).run(now),
    ).rejects.toThrow();
    // type must be non-empty
    await expect(
      db.prepare(
        `INSERT INTO memory_docs (project_id, path, type, title, description, tags, body, updated_at)
         VALUES ('p','learnings/y.md','','Y','d','[]','b',?)`,
      ).run(now),
    ).rejects.toThrow();
    // description and tags default
    await db.prepare(
      "INSERT INTO memory_docs (project_id, path, type, title, body, updated_at) VALUES ('p','learnings/z.md','Learning','Z','b',?)",
    ).run(now);
    expect(await db.prepare("SELECT description, tags FROM memory_docs WHERE path='learnings/z.md'").get()).toEqual({
      description: "",
      tags: "[]",
    });
    await db.prepare("INSERT INTO memory_log (project_id, entry, created_at) VALUES ('p','did a thing',?)").run(now);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM memory_log").get()).toEqual({ n: 1 });
  });

  it("rejects invalid job kind and question status", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
    await expect(
      db
        .prepare("INSERT INTO jobs (project_id, kind, payload, created_at, updated_at) VALUES ('p','dance','{}',1,1)")
        .run(),
    ).rejects.toThrow();
  });

  it("accepts curate, discuss, and reconcile job kinds", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
    await db.prepare("INSERT INTO jobs (project_id, kind, payload, created_at, updated_at) VALUES ('p','curate','{}',1,1)").run();
    await db.prepare("INSERT INTO jobs (project_id, kind, payload, created_at, updated_at) VALUES ('p','discuss','{}',1,1)").run();
    await db.prepare("INSERT INTO jobs (project_id, kind, payload, created_at, updated_at) VALUES ('p','reconcile','{}',1,1)").run();
    expect(await db.prepare("SELECT kind FROM jobs ORDER BY id").all()).toEqual([
      { kind: "curate" }, { kind: "discuss" }, { kind: "reconcile" },
    ]);
  });

  it("migrates a jobs table that has 'discuss' but lacks 'reconcile'", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "memracer-mig-")), "mini.db");
    // The live mini's post-discuss, pre-reconcile schema.
    const old = new Database(path);
    old.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, repo TEXT,
        mediator_model TEXT NOT NULL DEFAULT 'z-ai/glm-5.2'
      );
      CREATE TABLE jobs (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES projects(id),
        kind       TEXT NOT NULL CHECK (kind IN ('groom','review','answer','curate','discuss')),
        payload    TEXT NOT NULL,
        status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
        attempts   INTEGER NOT NULL DEFAULT 0,
        result     TEXT,
        error      TEXT,
        started_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_jobs_status ON jobs (status, id);
      INSERT INTO projects (id, name) VALUES ('p','P');
      INSERT INTO jobs (project_id, kind, payload, status, created_at, updated_at)
        VALUES ('p','discuss','{}','done',10,20);
    `);
    old.close();

    const db = openDb(path);
    expect(await db.prepare("SELECT id, kind FROM jobs").get()).toEqual({ id: 1, kind: "discuss" });
    await db.prepare("INSERT INTO jobs (project_id, kind, payload, created_at, updated_at) VALUES ('p','reconcile','{}',1,1)").run();
    expect(await db.prepare("SELECT id, kind FROM jobs WHERE kind='reconcile'").get()).toEqual({ id: 2, kind: "reconcile" });
    await db.close();
  });

  it("migrates the pre-refresh jobs CHECK to accept refresh without losing rows", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "memracer-mig-")), "mini.db");
    const old = new Database(path);
    old.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, repo TEXT,
        mediator_model TEXT NOT NULL DEFAULT 'z-ai/glm-5.2'
      );
      CREATE TABLE jobs (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES projects(id),
        kind       TEXT NOT NULL CHECK (kind IN ('groom','review','answer','curate','discuss','reconcile','catchup','seal','enhance','conciliate','consolidate')),
        payload    TEXT NOT NULL,
        status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
        attempts   INTEGER NOT NULL DEFAULT 0,
        result     TEXT,
        error      TEXT,
        started_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_jobs_status ON jobs (status, id);
      INSERT INTO projects (id, name) VALUES ('p','P');
      INSERT INTO jobs (id, project_id, kind, payload, status, attempts, result, created_at, updated_at)
        VALUES (7,'p','conciliate','{"keep":true}','done',2,'preserved',10,20);
    `);
    old.close();

    const migrated = openDb(path);
    expect(await migrated.prepare("SELECT * FROM jobs WHERE id=7").get()).toMatchObject({
      id: 7,
      project_id: "p",
      kind: "conciliate",
      payload: '{"keep":true}',
      status: "done",
      attempts: 2,
      result: "preserved",
      created_at: 10,
      updated_at: 20,
    });
    await migrated.prepare(
      "INSERT INTO jobs (project_id, kind, payload, created_at, updated_at) VALUES ('p','refresh','{}',30,30)",
    ).run();
    expect(migrated.pragma("index_list(jobs)")).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "idx_jobs_status" })]),
    );
    await migrated.close();

    const reopened = openDb(path);
    expect(await reopened.prepare("SELECT id, kind FROM jobs ORDER BY id").all()).toEqual([
      { id: 7, kind: "conciliate" },
      { id: 8, kind: "refresh" },
    ]);
    await reopened.close();
  });

  it("accepts close and update decision kinds", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
    await db.prepare(
      "INSERT INTO decision_log (project_id, task_id, kind, summary, rationale, created_at) VALUES ('p',NULL,'close','closed',  'r',1)",
    ).run();
    await db.prepare(
      "INSERT INTO decision_log (project_id, task_id, kind, summary, rationale, created_at) VALUES ('p',NULL,'update','updated','r',1)",
    ).run();
    expect(await db.prepare("SELECT kind FROM decision_log ORDER BY id").all()).toEqual([{ kind: "close" }, { kind: "update" }]);
  });

  it("has plan-window and PR-number task columns on a fresh db", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
    const now = Date.now();
    await db.prepare(
      `INSERT INTO tasks (project_id, title, body, submitted_by, plan_deadline, plan, plan_approved_at, result_pr_number, created_at, updated_at)
       VALUES ('p','t','b','dana',?, 'the plan', ?, 42, ?, ?)`,
    ).run(now + 1000, now, now, now);
    expect(await db.prepare("SELECT plan_deadline, plan, plan_approved_at, result_pr_number FROM tasks").get()).toEqual({
      plan_deadline: now + 1000, plan: "the plan", plan_approved_at: now, result_pr_number: 42,
    });
  });

  it("accepts plan_window_expired and released attempt outcomes", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
    await db.prepare(
      "INSERT INTO tasks (project_id, title, body, submitted_by, created_at, updated_at) VALUES ('p','t','b','dana',1,1)",
    ).run();
    const ins = db.prepare("INSERT INTO attempts (task_id, agent, outcome, notes, created_at) VALUES (1,'a',?,NULL,1)");
    await ins.run("plan_window_expired");
    await ins.run("released");
    await expect(ins.run("vanished")).rejects.toThrow();
    expect(await db.prepare("SELECT outcome FROM attempts ORDER BY id").all()).toEqual([
      { outcome: "plan_window_expired" }, { outcome: "released" },
    ]);
  });

  it("adds missing task columns to a pre-plan-window db (ensureColumns)", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "memracer-mig-")), "mini.db");
    // The live mini's pre-plan-window tasks table.
    const old = new Database(path);
    old.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, repo TEXT,
        mediator_model TEXT NOT NULL DEFAULT 'z-ai/glm-5.2'
      );
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL, body TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 2,
        state TEXT NOT NULL DEFAULT 'QUEUED'
          CHECK (state IN ('QUEUED','CLAIMED','PLANNED','EXECUTING','DONE','BLOCKED','PARKED')),
        base_sha TEXT, repo TEXT, submitted_by TEXT NOT NULL,
        lease_agent TEXT, lease_expires_at INTEGER,
        result_summary TEXT, result_pr_url TEXT,
        grooming_rationale TEXT, parent_id INTEGER REFERENCES tasks(id),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      INSERT INTO projects (id, name) VALUES ('p','P');
      INSERT INTO tasks (project_id, title, body, submitted_by, created_at, updated_at)
        VALUES ('p','old task','b','dana',10,20);
    `);
    old.close();

    const db = openDb(path);
    // pre-existing row survives; new columns default NULL
    expect(
      await db.prepare("SELECT title, plan_deadline, plan, plan_approved_at, result_pr_number FROM tasks").get(),
    ).toEqual({ title: "old task", plan_deadline: null, plan: null, plan_approved_at: null, result_pr_number: null });
    await db.prepare("UPDATE tasks SET plan='p', plan_deadline=1, plan_approved_at=2, result_pr_number=7 WHERE id=1").run();
    await db.close();

    // reopening again is a no-op (migration is idempotent)
    const again = openDb(path);
    expect(await again.prepare("SELECT plan, result_pr_number FROM tasks").get()).toEqual({ plan: "p", result_pr_number: 7 });
    await again.close();
  });

  it("adds memory_log.task_id and backfills curate entries to their decision's task (#86)", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "memracer-mig-")), "mini.db");
    // A pre-#86 memory_log with no task_id column, plus decisions to map against.
    const old = new Database(path);
    old.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, repo TEXT,
        mediator_model TEXT NOT NULL DEFAULT 'z-ai/glm-5.2'
      );
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL, body TEXT NOT NULL,
        submitted_by TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE decision_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES projects(id),
        task_id INTEGER REFERENCES tasks(id),
        kind TEXT NOT NULL, summary TEXT NOT NULL, rationale TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE memory_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES projects(id),
        entry TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO projects (id, name) VALUES ('p','P');
      INSERT INTO tasks (id, project_id, title, body, submitted_by, created_at, updated_at)
        VALUES (7,'p','seven','b','dana',1,1), (9,'p','nine','b','dana',1,1);
      INSERT INTO decision_log (id, project_id, task_id, kind, summary, rationale, created_at)
        VALUES (41,'p',7,'create','s','r',1), (55,'p',9,'create','s','r',2), (60,'p',NULL,'merge','s','r',3);
      INSERT INTO memory_log (project_id, entry, created_at) VALUES
        ('p','curated@41: learned about seven',10),
        ('p','curated@55: learned about nine',20),
        ('p','curated@60: project-level, no task',30),
        ('p','curated@999: decision does not exist',40),
        ('p','skipped invalid op x.md',50);
    `);
    old.close();

    const db = openDb(path);
    const rows = await db
      .prepare("SELECT entry, task_id FROM memory_log ORDER BY id")
      .all<{ entry: string; task_id: number | null }>();
    expect(rows).toEqual([
      { entry: "curated@41: learned about seven", task_id: 7 }, // mapped
      { entry: "curated@55: learned about nine", task_id: 9 }, // mapped
      { entry: "curated@60: project-level, no task", task_id: null }, // decision has no task
      { entry: "curated@999: decision does not exist", task_id: null }, // unmappable
      { entry: "skipped invalid op x.md", task_id: null }, // not a curate entry
    ]);
    await db.close();

    // reopening is a no-op (backfill only touches NULL rows; column already present)
    const again = openDb(path);
    expect(
      await again.prepare("SELECT task_id FROM memory_log WHERE entry LIKE 'curated@41:%'").get(),
    ).toEqual({ task_id: 7 });
    await again.close();
  });

  it("migrates an existing attempts table whose CHECK lacks the new outcomes", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "memracer-mig-")), "mini.db");
    // The live mini's pre-plan-window attempts schema.
    const old = new Database(path);
    old.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, repo TEXT,
        mediator_model TEXT NOT NULL DEFAULT 'z-ai/glm-5.2'
      );
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL, body TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 2,
        state TEXT NOT NULL DEFAULT 'QUEUED'
          CHECK (state IN ('QUEUED','CLAIMED','PLANNED','EXECUTING','DONE','BLOCKED','PARKED')),
        base_sha TEXT, repo TEXT, submitted_by TEXT NOT NULL,
        lease_agent TEXT, lease_expires_at INTEGER,
        result_summary TEXT, result_pr_url TEXT,
        grooming_rationale TEXT, parent_id INTEGER REFERENCES tasks(id),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE attempts (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id    INTEGER NOT NULL REFERENCES tasks(id),
        agent      TEXT NOT NULL,
        outcome    TEXT NOT NULL CHECK (outcome IN ('lease_expired','completed','blocked')),
        notes      TEXT,
        created_at INTEGER NOT NULL
      );
      INSERT INTO projects (id, name) VALUES ('p','P');
      INSERT INTO tasks (project_id, title, body, submitted_by, created_at, updated_at)
        VALUES ('p','t','b','dana',10,20);
      INSERT INTO attempts (task_id, agent, outcome, notes, created_at)
        VALUES (1,'cc-1','blocked','stuck',10);
    `);
    old.close();

    const db = openDb(path);
    // pre-existing row survives with all columns intact
    expect(await db.prepare("SELECT id, task_id, agent, outcome, notes, created_at FROM attempts").get()).toEqual({
      id: 1, task_id: 1, agent: "cc-1", outcome: "blocked", notes: "stuck", created_at: 10,
    });
    // new outcomes insertable, AUTOINCREMENT continues
    await db.prepare("INSERT INTO attempts (task_id, agent, outcome, notes, created_at) VALUES (1,'a','plan_window_expired',NULL,1)").run();
    await db.prepare("INSERT INTO attempts (task_id, agent, outcome, notes, created_at) VALUES (1,'a','released','why',1)").run();
    expect(await db.prepare("SELECT id, outcome FROM attempts WHERE id > 1 ORDER BY id").all()).toEqual([
      { id: 2, outcome: "plan_window_expired" }, { id: 3, outcome: "released" },
    ]);
    // old CHECK still enforced otherwise
    await expect(
      db.prepare("INSERT INTO attempts (task_id, agent, outcome, notes, created_at) VALUES (1,'a','dance',NULL,1)").run(),
    ).rejects.toThrow();
    await db.close();

    // reopening again is a no-op (migration is idempotent)
    const again = openDb(path);
    expect(await again.prepare("SELECT COUNT(*) AS n FROM attempts").get()).toEqual({ n: 3 });
    await again.close();
  });

  it("migrates an existing jobs table whose CHECK lacks 'curate'", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "memracer-mig-")), "mini.db");
    // Build the live mini's pre-curate schema by hand.
    const old = new Database(path);
    old.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, repo TEXT,
        mediator_model TEXT NOT NULL DEFAULT 'z-ai/glm-5.2'
      );
      CREATE TABLE jobs (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES projects(id),
        kind       TEXT NOT NULL CHECK (kind IN ('groom','review','answer')),
        payload    TEXT NOT NULL,
        status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
        attempts   INTEGER NOT NULL DEFAULT 0,
        result     TEXT,
        error      TEXT,
        started_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_jobs_status ON jobs (status, id);
      INSERT INTO projects (id, name) VALUES ('p','P');
      INSERT INTO jobs (project_id, kind, payload, status, result, created_at, updated_at)
        VALUES ('p','groom','{"taskId":1}','done','{"action":"accept"}',10,20);
    `);
    old.close();

    const db = openDb(path);
    // pre-existing row survives with all columns intact
    expect(await db.prepare("SELECT id, kind, payload, status, result, created_at, updated_at FROM jobs").get()).toEqual({
      id: 1, kind: "groom", payload: '{"taskId":1}', status: "done",
      result: '{"action":"accept"}', created_at: 10, updated_at: 20,
    });
    // curate and discuss are now insertable, AUTOINCREMENT continues
    await db.prepare("INSERT INTO jobs (project_id, kind, payload, created_at, updated_at) VALUES ('p','curate','{}',1,1)").run();
    expect(await db.prepare("SELECT id, kind FROM jobs WHERE kind='curate'").get()).toEqual({ id: 2, kind: "curate" });
    await db.prepare("INSERT INTO jobs (project_id, kind, payload, created_at, updated_at) VALUES ('p','discuss','{}',1,1)").run();
    expect(await db.prepare("SELECT id, kind FROM jobs WHERE kind='discuss'").get()).toEqual({ id: 3, kind: "discuss" });
    // old CHECK still enforced otherwise
    await expect(
      db.prepare("INSERT INTO jobs (project_id, kind, payload, created_at, updated_at) VALUES ('p','dance','{}',1,1)").run(),
    ).rejects.toThrow();
    await db.close();

    // reopening again is a no-op (migration is idempotent)
    const again = openDb(path);
    expect(await again.prepare("SELECT COUNT(*) AS n FROM jobs").get()).toEqual({ n: 3 });
    await again.close();
  });

  it("migrates a jobs table that has 'curate' but lacks 'discuss'", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "memracer-mig-")), "mini.db");
    // The live mini's post-curate, pre-discuss schema.
    const old = new Database(path);
    old.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, repo TEXT,
        mediator_model TEXT NOT NULL DEFAULT 'z-ai/glm-5.2'
      );
      CREATE TABLE jobs (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES projects(id),
        kind       TEXT NOT NULL CHECK (kind IN ('groom','review','answer','curate')),
        payload    TEXT NOT NULL,
        status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
        attempts   INTEGER NOT NULL DEFAULT 0,
        result     TEXT,
        error      TEXT,
        started_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_jobs_status ON jobs (status, id);
      INSERT INTO projects (id, name) VALUES ('p','P');
      INSERT INTO jobs (project_id, kind, payload, status, created_at, updated_at)
        VALUES ('p','curate','{}','done',10,20);
    `);
    old.close();

    const db = openDb(path);
    expect(await db.prepare("SELECT id, kind FROM jobs").get()).toEqual({ id: 1, kind: "curate" });
    await db.prepare("INSERT INTO jobs (project_id, kind, payload, created_at, updated_at) VALUES ('p','discuss','{}',1,1)").run();
    expect(await db.prepare("SELECT id, kind FROM jobs WHERE kind='discuss'").get()).toEqual({ id: 2, kind: "discuss" });
    await db.close();
  });

  it("migrates an existing decision_log whose CHECK lacks 'close'/'update'", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "memracer-mig-")), "mini.db");
    // The live mini's pre-discuss decision_log schema.
    const old = new Database(path);
    old.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, repo TEXT,
        mediator_model TEXT NOT NULL DEFAULT 'z-ai/glm-5.2'
      );
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL, body TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 2,
        state TEXT NOT NULL DEFAULT 'QUEUED'
          CHECK (state IN ('QUEUED','CLAIMED','PLANNED','EXECUTING','DONE','BLOCKED','PARKED')),
        base_sha TEXT, repo TEXT, submitted_by TEXT NOT NULL,
        lease_agent TEXT, lease_expires_at INTEGER,
        result_summary TEXT, result_pr_url TEXT,
        grooming_rationale TEXT, parent_id INTEGER REFERENCES tasks(id),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE decision_log (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES projects(id),
        task_id    INTEGER REFERENCES tasks(id),
        kind       TEXT NOT NULL CHECK (kind IN ('create','merge','clarify','priority','approve','revise','answer','escalate')),
        summary    TEXT NOT NULL,
        rationale  TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO projects (id, name) VALUES ('p','P');
      INSERT INTO decision_log (project_id, task_id, kind, summary, rationale, created_at)
        VALUES ('p',NULL,'answer','answered coder question','from context',10);
    `);
    old.close();

    const db = openDb(path);
    // pre-existing row survives with all columns intact
    expect(await db.prepare("SELECT id, project_id, task_id, kind, summary, rationale, created_at FROM decision_log").get()).toEqual({
      id: 1, project_id: "p", task_id: null, kind: "answer",
      summary: "answered coder question", rationale: "from context", created_at: 10,
    });
    // close/update are now insertable, AUTOINCREMENT continues
    await db.prepare(
      "INSERT INTO decision_log (project_id, task_id, kind, summary, rationale, created_at) VALUES ('p',NULL,'close','c','r',1)",
    ).run();
    await db.prepare(
      "INSERT INTO decision_log (project_id, task_id, kind, summary, rationale, created_at) VALUES ('p',NULL,'update','u','r',1)",
    ).run();
    expect(await db.prepare("SELECT id, kind FROM decision_log WHERE kind IN ('close','update') ORDER BY id").all()).toEqual([
      { id: 2, kind: "close" }, { id: 3, kind: "update" },
    ]);
    // old CHECK still enforced otherwise
    await expect(
      db.prepare(
        "INSERT INTO decision_log (project_id, task_id, kind, summary, rationale, created_at) VALUES ('p',NULL,'dance','d','r',1)",
      ).run(),
    ).rejects.toThrow();
    await db.close();

    // reopening again is a no-op (migration is idempotent)
    const again = openDb(path);
    expect(await again.prepare("SELECT COUNT(*) AS n FROM decision_log").get()).toEqual({ n: 3 });
    await again.close();
  });

  it("fresh db: evidence accepts kind 'research'", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
    const now = Date.now();
    await db.prepare(
      "INSERT INTO tasks (project_id, title, body, submitted_by, created_at, updated_at) VALUES ('p','t','b','dana',?,?)",
    ).run(now, now);
    await db.prepare("INSERT INTO evidence (task_id, kind, note) VALUES (1,'research','compared yjs vs automerge')").run();
    expect(await db.prepare("SELECT kind, note FROM evidence WHERE task_id=1").get()).toEqual({
      kind: "research", note: "compared yjs vs automerge",
    });
    // CHECK still enforced otherwise
    await expect(db.prepare("INSERT INTO evidence (task_id, kind) VALUES (1,'vibes')").run()).rejects.toThrow();
  });

  it("migrates an existing evidence table whose CHECK lacks 'research'", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "memracer-mig-")), "mini.db");
    // The live mini's pre-research evidence schema.
    const old = new Database(path);
    old.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, repo TEXT,
        mediator_model TEXT NOT NULL DEFAULT 'z-ai/glm-5.2'
      );
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL, body TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 2,
        state TEXT NOT NULL DEFAULT 'QUEUED'
          CHECK (state IN ('QUEUED','CLAIMED','PLANNED','EXECUTING','DONE','BLOCKED','PARKED')),
        base_sha TEXT, repo TEXT, submitted_by TEXT NOT NULL,
        lease_agent TEXT, lease_expires_at INTEGER,
        result_summary TEXT, result_pr_url TEXT,
        grooming_rationale TEXT, parent_id INTEGER REFERENCES tasks(id),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE evidence (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL REFERENCES tasks(id),
        kind    TEXT NOT NULL CHECK (kind IN ('code','stacktrace','log','link')),
        path    TEXT,
        lines   TEXT,
        snippet TEXT,
        note    TEXT
      );
      INSERT INTO projects (id, name) VALUES ('p','P');
      INSERT INTO tasks (project_id, title, body, submitted_by, created_at, updated_at)
        VALUES ('p','t','b','dana',10,10);
      INSERT INTO evidence (task_id, kind, path, lines, snippet, note)
        VALUES (1,'code','src/a.ts','1-3','snip','n');
    `);
    old.close();

    const db = openDb(path);
    // pre-existing row survives with all columns intact
    expect(await db.prepare("SELECT id, task_id, kind, path, lines, snippet, note FROM evidence").get()).toEqual({
      id: 1, task_id: 1, kind: "code", path: "src/a.ts", lines: "1-3", snippet: "snip", note: "n",
    });
    // research is now insertable, AUTOINCREMENT continues
    await db.prepare("INSERT INTO evidence (task_id, kind, note) VALUES (1,'research','survey')").run();
    expect(await db.prepare("SELECT id, kind FROM evidence WHERE kind='research'").get()).toEqual({ id: 2, kind: "research" });
    // old CHECK still enforced otherwise
    await expect(db.prepare("INSERT INTO evidence (task_id, kind) VALUES (1,'vibes')").run()).rejects.toThrow();
    await db.close();

    // reopening again is a no-op (migration is idempotent)
    const again = openDb(path);
    expect(await again.prepare("SELECT COUNT(*) AS n FROM evidence").get()).toEqual({ n: 2 });
    await again.close();
  });

  it("fresh db: threads has root_id/summary, tasks has root_thread_id, kind 'submission' accepted", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
    const now = Date.now();
    await db.prepare(
      "INSERT INTO threads (project_id, kind, task_id, root_id, summary, created_at) VALUES ('p','submission',NULL,NULL,NULL,?)",
    ).run(now);
    await db.prepare(
      `INSERT INTO tasks (project_id, title, body, submitted_by, root_thread_id, created_at, updated_at)
       VALUES ('p','t','b','dana',1,?,?)`,
    ).run(now, now);
    await db.prepare(
      "INSERT INTO threads (project_id, kind, task_id, root_id, summary, created_at) VALUES ('p','groom',1,1,'groom → accept',?)",
    ).run(now);
    expect(await db.prepare("SELECT root_id, summary FROM threads WHERE id=2").get()).toEqual({
      root_id: 1, summary: "groom → accept",
    });
    expect(await db.prepare("SELECT root_thread_id FROM tasks WHERE id=1").get()).toEqual({ root_thread_id: 1 });
    // old CHECK still enforced otherwise
    await expect(
      db.prepare("INSERT INTO threads (project_id, kind, created_at) VALUES ('p','banter',1)").run(),
    ).rejects.toThrow();
  });

  it("migrates a live pre-topology db: columns added, CHECK widened, roots backfilled", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "memracer-mig-")), "mini.db");
    // The live mini's pre-session-topology schema: threads without
    // root_id/summary and without 'submission' in the kind CHECK.
    const old = new Database(path);
    old.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, repo TEXT,
        mediator_model TEXT NOT NULL DEFAULT 'z-ai/glm-5.2'
      );
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL, body TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 2,
        state TEXT NOT NULL DEFAULT 'QUEUED'
          CHECK (state IN ('QUEUED','CLAIMED','PLANNED','EXECUTING','DONE','BLOCKED','PARKED')),
        base_sha TEXT, repo TEXT, submitted_by TEXT NOT NULL,
        lease_agent TEXT, lease_expires_at INTEGER,
        result_summary TEXT, result_pr_url TEXT, result_pr_number INTEGER,
        result_pr_description TEXT, pr_verification TEXT, pr_verification_etag TEXT,
        grooming_rationale TEXT, parent_id INTEGER REFERENCES tasks(id),
        plan TEXT, plan_deadline INTEGER, plan_approved_at INTEGER,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE threads (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES projects(id),
        kind       TEXT NOT NULL CHECK (kind IN ('groom','review','answer','discuss')),
        task_id    INTEGER REFERENCES tasks(id),
        created_at INTEGER NOT NULL
      );
      CREATE TABLE thread_messages (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id  INTEGER NOT NULL REFERENCES threads(id),
        role       TEXT NOT NULL CHECK (role IN ('human','coder','mediator','system')),
        author     TEXT NOT NULL,
        content    TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO projects (id, name) VALUES ('p','P');
      INSERT INTO tasks (project_id, title, body, submitted_by, created_at, updated_at)
        VALUES ('p','t1','b1','dana',1,1);
      INSERT INTO threads (project_id, kind, task_id, created_at) VALUES
        ('p','groom',1,10), ('p','review',1,20), ('p','answer',1,30), ('p','discuss',NULL,40);
      INSERT INTO thread_messages (thread_id, role, author, content, created_at) VALUES
        (1,'human','dana','t1\nb1',10), (1,'mediator','mediator','{"action":"accept"}',10),
        (2,'coder','cc-1','plan',20), (2,'mediator','mediator','{"verdict":"approved"}',20);
    `);
    old.close();

    const db = openDb(path);
    // 'submission' kind is now insertable
    await db.prepare("INSERT INTO threads (project_id, kind, created_at) VALUES ('p','submission',50)").run();
    // backfill: earliest groom thread is the root surrogate — its own root_id stays NULL
    expect(await db.prepare("SELECT root_thread_id FROM tasks WHERE id=1").get()).toEqual({ root_thread_id: 1 });
    expect(await db.prepare("SELECT id, root_id FROM threads ORDER BY id").all()).toEqual([
      { id: 1, root_id: null },
      { id: 2, root_id: 1 },
      { id: 3, root_id: 1 },
      { id: 4, root_id: null }, // task-less project discussion stays a root
      { id: 5, root_id: null },
    ]);
    // live rows survive the CHECK-widening rebuild intact
    expect(await db.prepare("SELECT COUNT(*) AS n FROM thread_messages").get()).toEqual({ n: 4 });
    expect(await db.prepare("SELECT content FROM thread_messages WHERE id=3").get()).toEqual({ content: "plan" });
    await db.close();

    // reopening again is a no-op (migration + backfill are idempotent)
    const again = openDb(path);
    expect(await again.prepare("SELECT COUNT(*) AS n FROM threads").get()).toEqual({ n: 5 });
    expect(await again.prepare("SELECT root_id FROM threads WHERE id=1").get()).toEqual({ root_id: null });
    await again.close();
  });

  it("backfill falls back to the earliest thread when a task has no groom thread", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "memracer-mig-")), "mini.db");
    const old = new Database(path);
    old.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, repo TEXT,
        mediator_model TEXT NOT NULL DEFAULT 'z-ai/glm-5.2');
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL, body TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 2, state TEXT NOT NULL DEFAULT 'QUEUED',
        submitted_by TEXT NOT NULL, parent_id INTEGER REFERENCES tasks(id),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE threads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES projects(id),
        kind TEXT NOT NULL CHECK (kind IN ('groom','review','answer','discuss')),
        task_id INTEGER REFERENCES tasks(id),
        created_at INTEGER NOT NULL
      );
      CREATE TABLE thread_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id INTEGER NOT NULL REFERENCES threads(id),
        role TEXT NOT NULL, author TEXT NOT NULL, content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO projects (id, name) VALUES ('p','P');
      INSERT INTO tasks (project_id, title, body, submitted_by, created_at, updated_at)
        VALUES ('p','t1','b1','dana',1,1);
      INSERT INTO threads (project_id, kind, task_id, created_at) VALUES
        ('p','answer',1,10), ('p','review',1,20);
    `);
    old.close();

    const db = openDb(path);
    expect(await db.prepare("SELECT root_thread_id FROM tasks WHERE id=1").get()).toEqual({ root_thread_id: 1 });
    expect(await db.prepare("SELECT id, root_id FROM threads ORDER BY id").all()).toEqual([
      { id: 1, root_id: null },
      { id: 2, root_id: 1 },
    ]);
    await db.close();
  });
});
