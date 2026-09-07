// Driver-contract suite: the same behavioral contract, executed against both
// backends. SQLite runs unconditionally; the Postgres side runs on PGlite
// (real Postgres compiled to WASM) so the dialect path needs no server.
import { describe, expect, it } from "vitest";
import { openDb, openPostgresDb, renderSchema, type Db } from "../src/db.js";
import { toPgPlaceholders } from "../src/db/postgres.js";
import { openPgliteDb } from "./helpers/pglite.js";

const backends: { name: string; open: () => Promise<Db> }[] = [
  { name: "sqlite", open: async () => openDb(":memory:") },
  { name: "postgres", open: () => openPgliteDb() },
];

// Optional third backend: a REAL Postgres through the production `pg` pool
// adapter. Point MEMRACER_TEST_PG_URL at a DISPOSABLE database — the suite
// drops and recreates its public schema per test.
const realPgUrl = process.env.MEMRACER_TEST_PG_URL;
if (realPgUrl) {
  backends.push({
    name: "postgres-real",
    open: async () => {
      const db = await openPostgresDb(realPgUrl);
      await db.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
      await db.exec(renderSchema("postgres"));
      return db;
    },
  });
}

describe("placeholder rewriting", () => {
  it("numbers ? placeholders and leaves quoted literals alone", () => {
    expect(toPgPlaceholders("SELECT * FROM t WHERE a = ? AND b = ?")).toBe(
      "SELECT * FROM t WHERE a = $1 AND b = $2",
    );
    expect(toPgPlaceholders("SELECT * FROM t WHERE a = '?' AND b = ?")).toBe(
      "SELECT * FROM t WHERE a = '?' AND b = $1",
    );
    expect(toPgPlaceholders("SELECT 'it''s ?', \"a?\", ? FROM t")).toBe(
      "SELECT 'it''s ?', \"a?\", $1 FROM t",
    );
    expect(toPgPlaceholders("SELECT ? -- is this ? a comment\n, ?")).toBe(
      "SELECT $1 -- is this ? a comment\n, $2",
    );
  });
});

describe.each(backends)("db driver contract ($name)", ({ open }) => {
  it("installs dashboard read indexes", async () => {
    const db = await open();
    const rows = db.dialect === "sqlite"
      ? await db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all<{ name: string }>()
      : await db.prepare("SELECT indexname AS name FROM pg_indexes WHERE schemaname = current_schema()").all<{ name: string }>();
    const names = new Set(rows.map((row) => row.name));
    for (const name of ["idx_threads_project", "idx_thread_messages_thread", "idx_evidence_task", "idx_attempts_task"]) {
      expect(names.has(name), `${name} missing on ${db.dialect}`).toBe(true);
    }
    await db.close();
  });

  it("creates the schema and round-trips typed rows", async () => {
    const db = await open();
    await db.prepare("INSERT INTO projects (id, name, repo) VALUES (?, ?, ?)").run("p", "P", "o/r");
    const row = await db
      .prepare("SELECT id, name, repo, mediator_model FROM projects WHERE id = ?")
      .get<{ id: string; name: string; repo: string; mediator_model: string }>("p");
    expect(row).toEqual({ id: "p", name: "P", repo: "o/r", mediator_model: "z-ai/glm-5.2" });
    await db.close();
  });

  it("repairs dangling task metadata references idempotently at boot", async () => {
    const db = await open();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P'), ('q','Q')").run();
    const now = Date.now();
    const local = await db.prepare(
      `INSERT INTO tasks (project_id, title, body, submitted_by, created_at, updated_at)
       VALUES ('p','local','body','dana',?,?) RETURNING id`,
    ).get<{ id: number }>(now, now);
    const foreign = await db.prepare(
      `INSERT INTO tasks (project_id, title, body, submitted_by, created_at, updated_at)
       VALUES ('q','foreign','body','rui',?,?) RETURNING id`,
    ).get<{ id: number }>(now, now);
    for (const [key, taskId] of [
      ["valid", local!.id],
      ["missing", 999_999],
      ["wrong-project", foreign!.id],
      ["pending", null],
    ] as const) {
      await db.prepare(
        `INSERT INTO submission_idempotency
           (project_id, submitted_by, idempotency_key, task_id, created_at)
         VALUES ('p','dana',?,?,?)`,
      ).run(key, taskId, now);
    }
    for (const [path, sourceTask] of [
      ["valid.md", local!.id],
      ["missing.md", 999_999],
      ["wrong-project.md", foreign!.id],
      ["taskless.md", null],
    ] as const) {
      await db.prepare(
        `INSERT INTO memory_docs
           (project_id, path, type, title, body, updated_at, source_task)
         VALUES ('p',?,'Learning',?,'body',?,?)`,
      ).run(path, path, now, sourceTask);
    }

    await db.exec(renderSchema(db.dialect));
    await db.exec(renderSchema(db.dialect));

    expect(await db.prepare(
      "SELECT idempotency_key, task_id FROM submission_idempotency ORDER BY idempotency_key",
    ).all()).toEqual([
      { idempotency_key: "valid", task_id: local!.id },
    ]);
    expect(await db.prepare(
      "SELECT path, source_task FROM memory_docs ORDER BY path",
    ).all()).toEqual([
      { path: "missing.md", source_task: null },
      { path: "taskless.md", source_task: null },
      { path: "valid.md", source_task: local!.id },
      { path: "wrong-project.md", source_task: null },
    ]);
    await db.close();
  });

  it("stores project-scoped questions without a task", async () => {
    const db = await open();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
    await db
      .prepare(
        `INSERT INTO questions (project_id, task_id, asked_by, question, created_at)
         VALUES ('p', NULL, 'mediator', 'Who uses this product?', 1)`,
      )
      .run();
    expect(await db.prepare("SELECT task_id, status FROM questions").get()).toEqual({
      task_id: null,
      status: "open",
    });
    await db.close();
  });

  it("returns numbers for ids, counts, and ms timestamps", async () => {
    const db = await open();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
    const now = Date.now();
    const inserted = await db
      .prepare(
        `INSERT INTO tasks (project_id, title, body, submitted_by, created_at, updated_at)
         VALUES ('p','t','b','dana',?,?) RETURNING id`,
      )
      .get<{ id: number }>(now, now);
    expect(inserted?.id).toBe(1);
    expect(typeof inserted?.id).toBe("number");
    const task = await db
      .prepare("SELECT created_at FROM tasks WHERE id = ?")
      .get<{ created_at: number }>(inserted!.id);
    expect(task?.created_at).toBe(now);
    const count = await db.prepare("SELECT COUNT(*) AS n FROM tasks").get<{ n: number }>();
    expect(count?.n).toBe(1);
    expect(typeof count?.n).toBe("number");
    await db.close();
  });

  it("run() reports changed row counts", async () => {
    const db = await open();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
    const now = Date.now();
    for (const t of ["a", "b"]) {
      await db
        .prepare(
          `INSERT INTO tasks (project_id, title, body, submitted_by, created_at, updated_at)
           VALUES ('p',?,?,'dana',?,?)`,
        )
        .run(t, t, now, now);
    }
    const upd = await db.prepare("UPDATE tasks SET priority = 0 WHERE project_id = 'p'").run();
    expect(upd.changes).toBe(2);
    const noop = await db.prepare("UPDATE tasks SET priority = 0 WHERE id = 999").run();
    expect(noop.changes).toBe(0);
    await db.close();
  });

  it("enforces CHECK constraints and primary keys", async () => {
    const db = await open();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
    const now = Date.now();
    // CHECK: tasks.state is a constrained enum.
    await expect(
      db
        .prepare(
          `INSERT INTO tasks (project_id, title, body, submitted_by, state, created_at, updated_at)
           VALUES ('p','t','t','dana','WIZARD',?,?)`,
        )
        .run(now, now),
    ).rejects.toThrow();
    // PRIMARY KEY: task_deps (task_id, depends_on) is composite — a duplicate throws.
    await db
      .prepare(
        `INSERT INTO tasks (project_id, title, body, submitted_by, created_at, updated_at)
         VALUES ('p','t','t','dana',?,?)`,
      )
      .run(now, now);
    const { id } = (await db
      .prepare("SELECT id FROM tasks WHERE project_id='p'")
      .get<{ id: number }>()) as { id: number };
    await db.prepare("INSERT INTO task_deps (task_id, depends_on) VALUES (?, ?)").run(id, id);
    await expect(
      db.prepare("INSERT INTO task_deps (task_id, depends_on) VALUES (?, ?)").run(id, id),
    ).rejects.toThrow();
    await db.close();
  });

  it("commits a transaction atomically and rolls back on error", async () => {
    const db = await open();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
    const now = Date.now();
    const id = await db.transaction(async () => {
      const row = await db
        .prepare(
          `INSERT INTO tasks (project_id, title, body, submitted_by, created_at, updated_at)
           VALUES ('p','t','b','dana',?,?) RETURNING id`,
        )
        .get<{ id: number }>(now, now);
      await db
        .prepare("INSERT INTO task_notes (task_id, agent, note, created_at) VALUES (?, 'a', 'n', ?)")
        .run(row!.id, now);
      return row!.id;
    });
    expect(id).toBe(1);
    const notes = await db.prepare("SELECT COUNT(*) AS n FROM task_notes").get<{ n: number }>();
    expect(notes?.n).toBe(1);

    await expect(
      db.transaction(async () => {
        await db
          .prepare(
            `INSERT INTO tasks (project_id, title, body, submitted_by, created_at, updated_at)
             VALUES ('p','doomed','b','dana',?,?)`,
          )
          .run(now, now);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const tasks = await db.prepare("SELECT COUNT(*) AS n FROM tasks").get<{ n: number }>();
    expect(tasks?.n).toBe(1);
    await db.close();
  });

  it("keeps concurrent single statements out of an open transaction", async () => {
    const db = await open();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
    const now = Date.now();
    // The transaction inserts then fails; a concurrent outside insert must survive.
    const doomed = db
      .transaction(async () => {
        await db
          .prepare(
            `INSERT INTO tasks (project_id, title, body, submitted_by, created_at, updated_at)
             VALUES ('p','inside-tx','b','dana',?,?)`,
          )
          .run(now, now);
        await new Promise((r) => setTimeout(r, 20));
        throw new Error("rollback");
      })
      .catch(() => "rolled back");
    const outside = db
      .prepare(
        `INSERT INTO tasks (project_id, title, body, submitted_by, created_at, updated_at)
         VALUES ('p','outside','b','dana',?,?)`,
      )
      .run(now, now);
    await Promise.all([doomed, outside]);
    const titles = (
      await db.prepare("SELECT title FROM tasks ORDER BY title").all<{ title: string }>()
    ).map((r) => r.title);
    expect(titles).toEqual(["outside"]);
    await db.close();
  });

  it("supports upsert via ON CONFLICT ... DO UPDATE", async () => {
    const db = await open();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
    const upsert = db.prepare(
      `INSERT INTO memory_docs (project_id, path, type, title, description, tags, body, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_id, path) DO UPDATE SET
         type=excluded.type, title=excluded.title, description=excluded.description,
         tags=excluded.tags, body=excluded.body, updated_at=excluded.updated_at`,
    );
    await upsert.run("p", "a.md", "Learning", "A", "", "[]", "v1", 1);
    await upsert.run("p", "a.md", "Learning", "A", "", "[]", "v2", 2);
    const row = await db
      .prepare("SELECT body, updated_at FROM memory_docs WHERE project_id='p' AND path='a.md'")
      .get<{ body: string; updated_at: number }>();
    expect(row).toEqual({ body: "v2", updated_at: 2 });
    await db.close();
  });

  it("handles dynamic IN (...) placeholder lists", async () => {
    const db = await open();
    for (const [id, name] of [["a", "A"], ["b", "B"], ["c", "C"]]) {
      await db.prepare("INSERT INTO projects (id, name) VALUES (?, ?)").run(id, name);
    }
    const ids = ["a", "c"];
    const rows = await db
      .prepare(`SELECT id FROM projects WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY id`)
      .all<{ id: string }>(...ids);
    expect(rows.map((r) => r.id)).toEqual(["a", "c"]);
    await db.close();
  });
});
