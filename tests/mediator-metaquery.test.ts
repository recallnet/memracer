// tests/mediator-metaquery.test.ts
import { describe, expect, it } from "vitest";
import type { Db } from "../src/db.js";
import {
  META_QUERY_ROW_CAP,
  MetaQueryError,
  runMetaQuery,
} from "../src/mediator/metaQuery.js";
import { openTestDb } from "./helpers/db.js";

async function seed(): Promise<Db> {
  const db = await openTestDb();
  await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
  await db.prepare("INSERT INTO projects (id, name) VALUES ('q','Q')").run();
  return db;
}

async function addTask(
  db: Db,
  project: string,
  title: string,
  state: string,
  submittedBy: string,
  createdAt: number,
): Promise<number> {
  const row = (await db
    .prepare(
      "INSERT INTO tasks (project_id, title, body, state, submitted_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?) RETURNING id",
    )
    .get<{ id: number }>(project, title, "b", state, submittedBy, createdAt, createdAt)) as { id: number };
  return row.id;
}

describe("metaQuery capability boundary", () => {
  it("rejects a smuggled raw-SQL field (.strict boundary)", async () => {
    const db = await seed();
    await expect(
      runMetaQuery(db, "p", { entity: "tasks", sql: "DROP TABLE tasks" } as never),
    ).rejects.toBeInstanceOf(MetaQueryError);
  });

  it("rejects a cross-project override in the descriptor", async () => {
    const db = await seed();
    await expect(
      runMetaQuery(db, "p", { entity: "tasks", project_id: "q" } as never),
    ).rejects.toBeInstanceOf(MetaQueryError);
  });

  it("scopes every query to the server-supplied project (no cross-project leak)", async () => {
    const db = await seed();
    await addTask(db, "p", "mine", "QUEUED", "dana", 1000);
    await addTask(db, "q", "theirs", "QUEUED", "dana", 1000);
    const res = await runMetaQuery(db, "p", { entity: "tasks" });
    expect(res.rows.map((r) => r.title)).toEqual(["mine"]);
  });

  it("keeps injection strings inert bound params (table survives, zero rows)", async () => {
    const db = await seed();
    await addTask(db, "p", "real", "QUEUED", "dana", 1000);
    const res = await runMetaQuery(db, "p", {
      entity: "tasks",
      actor: "'; DROP TABLE tasks; --",
    });
    expect(res.rows).toEqual([]);
    // Table intact and still queryable.
    const still = await runMetaQuery(db, "p", { entity: "tasks" });
    expect(still.rows).toHaveLength(1);
  });

  it("row-caps results at META_QUERY_ROW_CAP regardless of requested limit", async () => {
    const db = await seed();
    for (let i = 0; i < META_QUERY_ROW_CAP + 10; i++) {
      await addTask(db, "p", `t${i}`, "QUEUED", "dana", 1000 + i);
    }
    const res = await runMetaQuery(db, "p", { entity: "tasks", limit: 1000 });
    expect(res.rows).toHaveLength(META_QUERY_ROW_CAP);
  });

  it("filters tasks by kind (state) and actor, harvesting citable task ids", async () => {
    const db = await seed();
    const done = await addTask(db, "p", "shipped", "DONE", "dana", 2000);
    await addTask(db, "p", "open", "QUEUED", "dana", 2001);
    await addTask(db, "p", "other", "DONE", "rui", 2002);
    const res = await runMetaQuery(db, "p", { entity: "tasks", kind: "DONE", actor: "dana" });
    expect(res.rows.map((r) => r.id)).toEqual([done]);
    expect(res.taskIds).toEqual([done]);
  });

  it("queries decisions by kind and time window, harvesting decision + task ids", async () => {
    const db = await seed();
    const t = await addTask(db, "p", "t", "DONE", "dana", 1000);
    await db
      .prepare(
        "INSERT INTO decision_log (project_id, task_id, kind, summary, rationale, created_at) VALUES (?,?,?,?,?,?)",
      )
      .run("p", t, "close", "closed it", "obsolete", 5000);
    await db
      .prepare(
        "INSERT INTO decision_log (project_id, task_id, kind, summary, rationale, created_at) VALUES (?,?,?,?,?,?)",
      )
      .run("p", t, "close", "old close", "old", 1000);
    const res = await runMetaQuery(db, "p", {
      entity: "decisions",
      kind: "close",
      since: new Date(4000).toISOString(),
    });
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].summary).toBe("closed it");
    expect(res.decisionIds).toHaveLength(1);
    expect(res.taskIds).toEqual([t]);
  });

  it("queries threads by actor, truncating content and scoping by project", async () => {
    const db = await seed();
    const t = await addTask(db, "p", "t", "DONE", "dana", 1000);
    const thread = (await db
      .prepare("INSERT INTO threads (project_id, kind, task_id, created_at) VALUES (?,?,?,?) RETURNING id")
      .get<{ id: number }>("p", "discuss", t, 1000)) as { id: number };
    await db
      .prepare(
        "INSERT INTO thread_messages (thread_id, role, author, content, created_at) VALUES (?,?,?,?,?)",
      )
      .run(thread.id, "human", "dana", "x".repeat(1000), 3000);
    const res = await runMetaQuery(db, "p", { entity: "threads", actor: "dana" });
    expect(res.rows).toHaveLength(1);
    expect((res.rows[0].content as string).length).toBeLessThan(1000);
    expect(res.taskIds).toEqual([t]);
  });

  it("rejects an actor filter on an entity without an actor dimension", async () => {
    const db = await seed();
    await expect(
      runMetaQuery(db, "p", { entity: "decisions", actor: "dana" }),
    ).rejects.toBeInstanceOf(MetaQueryError);
  });

  it("rejects an unparseable time bound", async () => {
    const db = await seed();
    await expect(
      runMetaQuery(db, "p", { entity: "tasks", since: "not-a-date" }),
    ).rejects.toBeInstanceOf(MetaQueryError);
  });
});
