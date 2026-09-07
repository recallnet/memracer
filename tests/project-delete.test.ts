import { afterEach, describe, expect, it } from "vitest";
import type { Db, Statement } from "../src/db.js";
import { deleteProject } from "../src/project-delete.js";
import { projectDeleteRowLockSql } from "../src/dashboard.js";
import { openTestDb } from "./helpers/db.js";

const opened: Db[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((db) => db.close()));
});

async function seeded(): Promise<Db> {
  const db = await openTestDb();
  opened.push(db);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS "organization" (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS "member" (
      id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, "userId" TEXT NOT NULL, role TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS "invitation" (
      id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, email TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS apikey (id TEXT PRIMARY KEY, metadata TEXT, "referenceId" TEXT);
  `);
  const now = Date.now();
  await db.prepare("INSERT INTO orgs (id, name, created_by, created_at) VALUES (?, ?, ?, ?)").run("o", "Team", "u", now);
  await db.prepare("INSERT INTO projects (id, name, org_id) VALUES (?, ?, ?)").run("p", "Target", "o");
  await db.prepare("INSERT INTO projects (id, name, org_id) VALUES (?, ?, ?)").run("q", "Sibling", "o");
  await db.prepare('INSERT INTO "user" (id, name) VALUES (?, ?)').run("u", "Ada");
  for (const id of ["p", "q"]) {
    await db.prepare('INSERT INTO "organization" (id, name) VALUES (?, ?)').run(id, id);
    await db.prepare('INSERT INTO "member" (id, "organizationId", "userId", role) VALUES (?, ?, ?, ?)').run(`m-${id}`, id, "u", "admin");
    await db.prepare('INSERT INTO "invitation" (id, "organizationId", email) VALUES (?, ?, ?)').run(`i-${id}`, id, `${id}@test`);
    await db.prepare('INSERT INTO apikey (id, metadata, "referenceId") VALUES (?, ?, ?)').run(`k-${id}`, JSON.stringify({ projectId: id }), "u");
  }
  await db.prepare('INSERT INTO apikey (id, metadata, "referenceId") VALUES (?, ?, ?)').run("k-bad", "not-json", "u");
  await db.prepare('INSERT INTO apikey (id, metadata, "referenceId") VALUES (?, ?, ?)').run("k-global", JSON.stringify({ scope: "global", projectId: "p" }), "u");
  await db.prepare('INSERT INTO apikey (id, metadata, "referenceId") VALUES (?, ?, ?)').run("k-user", JSON.stringify({ scope: "user", projectId: "p" }), "u");
  await db.prepare('INSERT INTO apikey (id, metadata, "referenceId") VALUES (?, ?, ?)').run("k-double", JSON.stringify(JSON.stringify({ scope: "project", projectId: "p" })), "u");

  const task = await db.prepare(
    "INSERT INTO tasks (project_id,title,body,submitted_by,created_at,updated_at) VALUES (?,?,?,?,?,?) RETURNING id",
  ).get<{ id: number }>("p", "task", "body", "u", now, now);
  const taskId = task!.id;
  const thread = await db.prepare(
    "INSERT INTO threads (project_id,kind,task_id,created_at) VALUES (?,?,?,?) RETURNING id",
  ).get<{ id: number }>("p", "submission", taskId, now);
  const threadId = thread!.id;
  await db.prepare("UPDATE tasks SET root_thread_id=? WHERE id=?").run(threadId, taskId);
  await db.prepare("INSERT INTO thread_messages (thread_id,role,author,content,created_at) VALUES (?,?,?,?,?)").run(threadId, "human", "u", "hello", now);
  const targetEvent = (await db.prepare("INSERT INTO session_events (project_id,session_id,thread_id,task_id,seq,type,role,author,content,start_time) VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id").get<{ id: number }>("p", threadId, threadId, taskId, 1, "request", "human", "u", "hello", now))!;
  await db.prepare("INSERT INTO evidence (task_id,kind,note) VALUES (?,?,?)").run(taskId, "code", "x");
  await db.prepare("INSERT INTO attempts (task_id,agent,outcome,created_at) VALUES (?,?,?,?)").run(taskId, "coder", "released", now);
  await db.prepare("INSERT INTO task_notes (task_id,agent,note,created_at) VALUES (?,?,?,?)").run(taskId, "coder", "n", now);
  await db.prepare("INSERT INTO steers (task_id,author,instruction,created_at) VALUES (?,?,?,?)").run(taskId, "u", "s", now);
  await db.prepare(
    "INSERT INTO attention_alerts (task_id,project_id,episode,episode_started_at,created_at,updated_at) VALUES (?,?,?,?,?,?)",
  ).run(taskId, "p", 1, now, now, now);
  const targetJob = (await db.prepare("INSERT INTO jobs (project_id,kind,payload,status,created_at,updated_at) VALUES (?,?,?,?,?,?) RETURNING id").get<{ id: number }>("p", "groom", "{}", "done", now, now))!;
  await db.prepare("INSERT INTO mediator_usage (job_id,project_id,kind,prompt_tokens,completion_tokens,completion_count,created_at) VALUES (?,?,?,?,?,?,?)").run(targetJob.id, "p", "groom", 10, 5, 1, now);
  await db.prepare("INSERT INTO job_policy_log (project_id,job_id,task_id,attempt,invocation,kind,model,effort,max_tokens,rollout_arm,outcome,started_at,finished_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("p", targetJob.id, taskId, 1, 1, "groom", "z-ai/glm-5.2", "high", 32768, "routed", "ok", now, now, now, now);
  const decision = await db.prepare("INSERT INTO decision_log (project_id,task_id,kind,summary,rationale,created_at) VALUES (?,?,?,?,?,?) RETURNING id").get<{ id: number }>("p", taskId, "create", "d", "r", now);
  await db.prepare("INSERT INTO questions (project_id,task_id,asked_by,question,created_at) VALUES (?,?,?,?,?)").run("p", taskId, "u", "q?", now);
  await db.prepare("INSERT INTO memory_docs (project_id,path,type,title,body,updated_at) VALUES (?,?,?,?,?,?)").run("p", "x.md", "Note", "X", "x", now);
  await db.prepare("INSERT INTO memory_log (project_id,task_id,entry,created_at) VALUES (?,?,?,?)").run("p", taskId, "log", now);
  await db.prepare("INSERT INTO catchup_watermarks (project_id,member,watermark_at) VALUES (?,?,?)").run("p", "u", now);
  const conversation = await db.prepare("INSERT INTO conversations (project_id,thread_id,topic,deadline,created_at) VALUES (?,?,?,?,?) RETURNING id").get<{ id: number }>("p", threadId, "topic", now + 1, now);
  const conversationId = conversation!.id;
  await db.prepare("INSERT INTO conversation_participants (conversation_id,member) VALUES (?,?)").run(conversationId, "u");
  await db.prepare("INSERT INTO conversation_tasks (conversation_id,task_id) VALUES (?,?)").run(conversationId, taskId);
  await db.prepare("INSERT INTO conversation_decisions (conversation_id,decision_id) VALUES (?,?)").run(conversationId, decision!.id);

  // A complete sibling graph proves every child-first selector stays scoped.
  const siblingTask = (await db.prepare(
    "INSERT INTO tasks (project_id,title,body,submitted_by,created_at,updated_at) VALUES (?,?,?,?,?,?) RETURNING id",
  ).get<{ id: number }>("q", "sibling task", "keep body", "u", now, now))!;
  const siblingThread = (await db.prepare(
    "INSERT INTO threads (project_id,kind,task_id,created_at) VALUES (?,?,?,?) RETURNING id",
  ).get<{ id: number }>("q", "submission", siblingTask.id, now))!;
  await db.prepare("UPDATE tasks SET parent_id=? WHERE id=?").run(taskId, siblingTask.id);
  const incomingThread = (await db.prepare(
    "INSERT INTO threads (project_id,kind,task_id,created_at,root_id) VALUES (?,?,?,?,?) RETURNING id",
  ).get<{ id: number }>("q", "review", taskId, now, threadId))!;
  await db.prepare("UPDATE tasks SET root_thread_id=? WHERE id=?").run(siblingThread.id, siblingTask.id);
  await db.prepare("INSERT INTO task_deps (task_id,depends_on) VALUES (?,?)").run(siblingTask.id, siblingTask.id);
  await db.prepare("INSERT INTO task_deps (task_id,depends_on) VALUES (?,?)").run(siblingTask.id, taskId);
  await db.prepare("INSERT INTO thread_messages (thread_id,role,author,content,created_at) VALUES (?,?,?,?,?)").run(siblingThread.id, "human", "u", "keep message", now);
  await db.prepare("INSERT INTO session_events (project_id,session_id,parent_id,thread_id,task_id,seq,type,role,author,content,start_time) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run("q", siblingThread.id, targetEvent.id, siblingThread.id, siblingTask.id, 1, "request", "human", "u", "keep event", now);
  await db.prepare("INSERT INTO session_events (project_id,session_id,thread_id,task_id,seq,type,role,author,content,start_time) VALUES (?,?,?,?,?,?,?,?,?,?)").run("q", threadId, incomingThread.id, taskId, 2, "request", "human", "u", "doomed cross event", now + 1);
  await db.prepare("INSERT INTO evidence (task_id,kind,note) VALUES (?,?,?)").run(siblingTask.id, "code", "keep evidence");
  await db.prepare("INSERT INTO attempts (task_id,agent,outcome,created_at) VALUES (?,?,?,?)").run(siblingTask.id, "coder", "released", now);
  await db.prepare("INSERT INTO task_notes (task_id,agent,note,created_at) VALUES (?,?,?,?)").run(siblingTask.id, "coder", "keep note", now);
  await db.prepare("INSERT INTO steers (task_id,author,instruction,created_at) VALUES (?,?,?,?)").run(siblingTask.id, "u", "keep steer", now);
  await db.prepare(
    "INSERT INTO attention_alerts (task_id,project_id,episode,episode_started_at,created_at,updated_at) VALUES (?,?,?,?,?,?)",
  ).run(siblingTask.id, "q", 1, now, now, now);
  const siblingJob = (await db.prepare("INSERT INTO jobs (project_id,kind,payload,status,created_at,updated_at) VALUES (?,?,?,?,?,?) RETURNING id").get<{ id: number }>("q", "groom", "{}", "done", now, now))!;
  await db.prepare("INSERT INTO mediator_usage (job_id,project_id,kind,prompt_tokens,completion_tokens,completion_count,created_at) VALUES (?,?,?,?,?,?,?)").run(siblingJob.id, "q", "groom", 20, 8, 2, now);
  await db.prepare("INSERT INTO job_policy_log (project_id,job_id,task_id,attempt,invocation,kind,model,effort,max_tokens,rollout_arm,outcome,started_at,finished_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("q", siblingJob.id, siblingTask.id, 1, 1, "groom", "z-ai/glm-5.2", "high", 32768, "routed", "ok", now, now, now, now);
  const siblingDecision = (await db.prepare("INSERT INTO decision_log (project_id,task_id,kind,summary,rationale,created_at) VALUES (?,?,?,?,?,?) RETURNING id").get<{ id: number }>("q", siblingTask.id, "create", "keep decision", "r", now))!;
  await db.prepare("INSERT INTO decision_log (project_id,task_id,kind,summary,rationale,created_at) VALUES (?,?,?,?,?,?)").run("q", taskId, "update", "detached decision", "r", now);
  await db.prepare("INSERT INTO questions (project_id,task_id,asked_by,question,created_at) VALUES (?,?,?,?,?)").run("q", siblingTask.id, "u", "keep question?", now);
  await db.prepare("INSERT INTO questions (project_id,task_id,asked_by,question,created_at) VALUES (?,?,?,?,?)").run("q", taskId, "u", "detached question?", now);
  await db.prepare("INSERT INTO memory_docs (project_id,path,type,title,body,updated_at) VALUES (?,?,?,?,?,?)").run("q", "keep.md", "Note", "Keep", "keep memory", now);
  await db.prepare("INSERT INTO memory_log (project_id,task_id,entry,created_at) VALUES (?,?,?,?)").run("q", siblingTask.id, "keep log", now);
  await db.prepare("INSERT INTO memory_log (project_id,task_id,entry,created_at) VALUES (?,?,?,?)").run("q", taskId, "detached log", now);
  await db.prepare("INSERT INTO catchup_watermarks (project_id,member,watermark_at) VALUES (?,?,?)").run("q", "u", now);
  const siblingConversation = (await db.prepare("INSERT INTO conversations (project_id,thread_id,topic,deadline,created_at) VALUES (?,?,?,?,?) RETURNING id").get<{ id: number }>("q", siblingThread.id, "keep topic", now + 1, now))!;
  await db.prepare("INSERT INTO conversation_participants (conversation_id,member) VALUES (?,?)").run(siblingConversation.id, "u");
  await db.prepare("INSERT INTO conversation_tasks (conversation_id,task_id) VALUES (?,?)").run(siblingConversation.id, siblingTask.id);
  await db.prepare("INSERT INTO conversation_tasks (conversation_id,task_id) VALUES (?,?)").run(siblingConversation.id, taskId);
  await db.prepare("INSERT INTO conversation_decisions (conversation_id,decision_id) VALUES (?,?)").run(siblingConversation.id, siblingDecision.id);
  await db.prepare("INSERT INTO conversation_decisions (conversation_id,decision_id) VALUES (?,?)").run(siblingConversation.id, decision!.id);
  const doomedConversation = (await db.prepare("INSERT INTO conversations (project_id,thread_id,topic,deadline,created_at) VALUES (?,?,?,?,?) RETURNING id").get<{ id: number }>("q", threadId, "doomed incoming thread", now + 1, now))!;
  await db.prepare("INSERT INTO conversation_participants (conversation_id,member) VALUES (?,?)").run(doomedConversation.id, "u");
  await db.prepare("INSERT INTO conversation_tasks (conversation_id,task_id) VALUES (?,?)").run(doomedConversation.id, siblingTask.id);
  await db.prepare("INSERT INTO conversation_decisions (conversation_id,decision_id) VALUES (?,?)").run(doomedConversation.id, siblingDecision.id);
  return db;
}

describe("deleteProject", () => {
  it("locks admin membership and project reads on Postgres while SQLite relies on BEGIN IMMEDIATE", () => {
    const query = "SELECT name FROM projects WHERE id = ?";
    expect(projectDeleteRowLockSql("postgres", query)).toBe(`${query} FOR UPDATE`);
    expect(projectDeleteRowLockSql("sqlite", query)).toBe(query);
  });
  it("purges every target-owned application and auth row while preserving its team, sibling, and users", async () => {
    const db = await seeded();
    await deleteProject(db, "p");
    const expectedCounts: Record<string, number> = {
      tasks: 1, threads: 2, thread_messages: 1, session_events: 1, evidence: 1, attempts: 1, jobs: 1, mediator_usage: 1, job_policy_log: 1,
      decision_log: 2, questions: 2, memory_docs: 1, memory_log: 2, task_notes: 1, steers: 1,
      catchup_watermarks: 1, conversations: 1, conversation_participants: 1, conversation_tasks: 1,
      conversation_decisions: 1, attention_alerts: 1,
    };
    for (const [table, expected] of Object.entries(expectedCounts)) {
      const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get<{ n: number }>();
      expect(row?.n, table).toBe(expected);
    }
    expect((await db.prepare("SELECT COUNT(*) AS n FROM task_deps").get<{ n: number }>())?.n).toBe(1);
    expect(await db.prepare("SELECT title, body FROM tasks WHERE project_id=?").get("q")).toEqual({ title: "sibling task", body: "keep body" });
    expect(await db.prepare("SELECT content FROM thread_messages").get()).toEqual({ content: "keep message" });
    expect(await db.prepare("SELECT summary FROM decision_log WHERE project_id=?").get("q")).toEqual({ summary: "keep decision" });
    expect(await db.prepare("SELECT body FROM memory_docs WHERE project_id=?").get("q")).toEqual({ body: "keep memory" });
    expect(await db.prepare("SELECT parent_id FROM tasks WHERE project_id=?").get("q")).toEqual({ parent_id: null });
    expect(await db.prepare("SELECT task_id, root_id FROM threads WHERE project_id=? AND kind=?").get("q", "review")).toEqual({ task_id: null, root_id: null });
    expect(await db.prepare("SELECT parent_id FROM session_events WHERE project_id=?").get("q")).toEqual({ parent_id: null });
    expect(await db.prepare("SELECT task_id FROM decision_log WHERE summary=?").get("detached decision")).toEqual({ task_id: null });
    expect(await db.prepare("SELECT task_id FROM questions WHERE question=?").get("detached question?")).toEqual({ task_id: null });
    expect(await db.prepare("SELECT task_id FROM memory_log WHERE entry=?").get("detached log")).toEqual({ task_id: null });
    expect(await db.prepare("SELECT id FROM projects WHERE id=?").get("q")).toBeTruthy();
    expect(await db.prepare("SELECT id FROM orgs WHERE id=?").get("o")).toBeTruthy();
    expect(await db.prepare('SELECT id FROM "user" WHERE id=?').get("u")).toBeTruthy();
    expect(await db.prepare('SELECT id FROM "organization" WHERE id=?').get("p")).toBeUndefined();
    expect(await db.prepare('SELECT id FROM "organization" WHERE id=?').get("q")).toBeTruthy();
    expect(await db.prepare('SELECT id FROM "member" WHERE "organizationId"=?').get("p")).toBeUndefined();
    expect(await db.prepare('SELECT id FROM "member" WHERE "organizationId"=?').get("q")).toBeTruthy();
    expect(await db.prepare('SELECT id FROM "invitation" WHERE "organizationId"=?').get("p")).toBeUndefined();
    expect(await db.prepare('SELECT id FROM "invitation" WHERE "organizationId"=?').get("q")).toBeTruthy();
    expect(await db.prepare("SELECT id FROM apikey WHERE id=?").get("k-p")).toBeUndefined();
    expect(await db.prepare("SELECT id FROM apikey WHERE id=?").get("k-q")).toBeTruthy();
    expect(await db.prepare("SELECT id FROM apikey WHERE id=?").get("k-bad")).toBeTruthy();
    expect(await db.prepare("SELECT id FROM apikey WHERE id=?").get("k-global")).toBeTruthy();
    expect(await db.prepare("SELECT id FROM apikey WHERE id=?").get("k-user")).toBeTruthy();
    expect(await db.prepare("SELECT id FROM apikey WHERE id=?").get("k-double")).toBeUndefined();
  });

  it("rolls the entire purge back when the final project delete fails", async () => {
    const db = await seeded();
    const tables = [
      "projects", "tasks", "threads", "thread_messages", "session_events", "evidence", "attempts", "jobs", "mediator_usage", "job_policy_log",
      "decision_log", "questions", "memory_docs", "memory_log", "task_notes", "steers", "catchup_watermarks",
      "attention_alerts",
      "conversations", "conversation_participants", "conversation_tasks", "conversation_decisions", "organization",
      "member", "invitation", "apikey",
    ];
    const counts = async () => Object.fromEntries(await Promise.all(tables.map(async (table) => [
      table,
      (await db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get<{ n: number }>())!.n,
    ])));
    const before = await counts();
    const wrapped: Db = {
      ...db,
      dialect: db.dialect,
      authDatabase: () => db.authDatabase(),
      exec: (sql) => db.exec(sql),
      transaction: (fn) => db.transaction(fn),
      isInTransaction: () => db.isInTransaction(),
      close: () => db.close(),
      prepare(sql: string): Statement {
        if (/^DELETE FROM projects/.test(sql)) {
          return { get: async () => undefined, all: async () => [], run: async () => { throw new Error("injected failure"); } };
        }
        return db.prepare(sql);
      },
    };
    await expect(deleteProject(wrapped, "p")).rejects.toThrow("injected failure");
    expect(await counts()).toEqual(before);
  });

  it("rejects a zero-row final delete instead of reporting false success", async () => {
    const db = await seeded();
    await expect(deleteProject(db, "missing")).rejects.toThrow("project missing was concurrently removed");
    expect(await db.prepare("SELECT id FROM projects WHERE id=?").get("p")).toBeTruthy();
    expect(await db.prepare("SELECT id FROM projects WHERE id=?").get("q")).toBeTruthy();
  });
});
