// tests/queue-submit.test.ts
import { describe, expect, it } from "vitest";
import { Queue, DEDUP_WINDOW_MS } from "../src/queue.js";
import { openTestDb } from "./helpers/db.js";

async function makeQueue() {
  const db = await openTestDb();
  await db.prepare("INSERT INTO projects (id, name) VALUES ('demo','Demo')").run();
  const q = new Queue(db);
  return Object.assign(q, { db });
}

describe("Queue.submit / status", () => {
  it("enqueues a task with evidence and returns its id", async () => {
    const q = await makeQueue();
    const id = await q.submit("demo", "dana", {
      title: "Add rate limiting to /api/ingest",
      body: "429 + Retry-After on >100 req/min/key",
      priority: 0,
      repo: "recallnet/ingest-svc",
      baseSha: "e3f9c1",
      evidence: [
        { kind: "code", path: "middleware/ingest.ts", lines: "40-52", snippet: "app.use(rawIngest)", note: "no limiter" },
      ],
    });
    expect(id).toBeGreaterThan(0);
    const status = await q.status("demo");
    expect(status.tasks).toHaveLength(1);
    expect(status.tasks[0]).toMatchObject({
      id,
      title: "Add rate limiting to /api/ingest",
      state: "QUEUED",
      priority: 0,
      submitted_by: "dana",
    });
  });

  it("round-trips 'research' evidence through submit and brief", async () => {
    const q = await makeQueue();
    const id = await q.submit("demo", "dana", {
      title: "Add realtime collab",
      body: "feature work backed by research",
      evidence: [{ kind: "research", note: "compared yjs vs automerge; yjs wins on ecosystem" }],
    });
    expect((await q.brief(id)).evidence).toEqual([
      { id: expect.any(Number), kind: "research", path: null, lines: null, snippet: null, note: "compared yjs vs automerge; yjs wins on ecosystem" },
    ]);
  });

  it("orders status by priority then insertion", async () => {
    const q = await makeQueue();
    const low = await q.submit("demo", "dana", { title: "low", body: "b", priority: 2, evidence: [] });
    const hi = await q.submit("demo", "dana", { title: "hi", body: "b", priority: 0, evidence: [] });
    const ids = (await q.status("demo")).tasks.map((t) => t.id);
    expect(ids).toEqual([hi, low]);
  });

  it("submit creates a root submission thread whose first human message carries the prompt", async () => {
    const q = await makeQueue();
    const id = await q.submit("demo", "dana", {
      title: "Add limiter",
      body: "429 on abuse",
      evidence: [{ kind: "code", path: "mw/ingest.ts", lines: "40-52", note: "no limiter" }],
    });
    const task = (await q.db
      .prepare("SELECT root_thread_id FROM tasks WHERE id=?")
      .get<{ root_thread_id: number }>(id)) as { root_thread_id: number };
    expect(task.root_thread_id).toBeGreaterThan(0);
    const root = await q.db
      .prepare("SELECT kind, task_id, root_id FROM threads WHERE id=?")
      .get(task.root_thread_id);
    expect(root).toEqual({ kind: "submission", task_id: id, root_id: null });
    const msg = (await q.db
      .prepare("SELECT role, author, content FROM thread_messages WHERE thread_id=?")
      .get<{ role: string; author: string; content: string }>(task.root_thread_id)) as {
      role: string; author: string; content: string;
    };
    expect(msg.role).toBe("human");
    expect(msg.author).toBe("dana");
    expect(msg.content).toContain("Add limiter");
    expect(msg.content).toContain("429 on abuse");
    expect(msg.content).toContain("mw/ingest.ts");
  });

  it("a follow-up child inherits the parent's root thread (fan-out ready)", async () => {
    const q = await makeQueue();
    const parent = await q.submit("demo", "dana", { title: "parent", body: "b", evidence: [] });
    const child = await q.submit("demo", "dana", { title: "child", body: "b", evidence: [], parentId: parent });
    const roots = await q.db
      .prepare("SELECT id, root_thread_id FROM tasks ORDER BY id")
      .all<{ id: number; root_thread_id: number }>();
    expect(roots[0].root_thread_id).toBe(roots[1].root_thread_id);
    expect(roots.map((r) => r.id)).toEqual([parent, child]);
    // only one submission thread exists — the shared root
    expect(await q.db.prepare("SELECT COUNT(*) AS n FROM threads WHERE kind='submission'").get()).toEqual({ n: 1 });
    // Shared root stays owned by the parent task, not reassigned to the child.
    expect(
      await q.db.prepare("SELECT task_id FROM threads WHERE id=?").get(roots[0].root_thread_id),
    ).toEqual({ task_id: parent });
  });

  it("a follow-up child credits the parent author, not the filing agent", async () => {
    const q = await makeQueue();
    const parent = await q.submit("demo", "Aaron", {
      title: "org switcher",
      body: "ship org switcher",
      evidence: [],
    });
    // Filer is andrew; origin work is Aaron's.
    const child = await q.submit("demo", "andrew", {
      title: "polish switcher",
      body: "followup polish",
      evidence: [],
      parentId: parent,
    });
    const rows = await q.db
      .prepare("SELECT id, submitted_by, parent_id FROM tasks ORDER BY id")
      .all<{ id: number; submitted_by: string; parent_id: number | null }>();
    expect(rows).toEqual([
      { id: parent, submitted_by: "Aaron", parent_id: null },
      { id: child, submitted_by: "Aaron", parent_id: parent },
    ]);
  });
});

describe("Queue watermark + findDuplicate (submission dedup)", () => {
  it("watermark is deterministic and ignores case/whitespace/punctuation", () => {
    const a = Queue.watermark("Fix the login bug", "Users can't log in — 500 error.");
    const b = Queue.watermark("  fix   the LOGIN bug  ", "users can't log in   500 error");
    expect(a).toEqual(b);
    expect(a).not.toEqual(Queue.watermark("Fix the logout bug", "Users can't log in."));
  });

  it("stores a watermark on the task at submit", async () => {
    const q = await makeQueue();
    const id = await q.submit("demo", "dana", { title: "T", body: "body here", evidence: [] });
    const row = (await q.db.prepare("SELECT watermark FROM tasks WHERE id=?").get<{ watermark: string }>(id)) as {
      watermark: string;
    };
    expect(row.watermark).toEqual(Queue.watermark("T", "body here"));
  });

  it("finds a same-submitter, in-window duplicate by normalized content", async () => {
    const q = await makeQueue();
    const first = await q.submit("demo", "dana", { title: "Add rate limiting", body: "429 on abuse", evidence: [] });
    const dup = await q.findDuplicate("demo", "dana", "  add   RATE limiting ", "429 on abuse!!");
    expect(dup?.id).toBe(first);
  });

  it("does not dedup across a different submitter", async () => {
    const q = await makeQueue();
    await q.submit("demo", "dana", { title: "Add rate limiting", body: "429 on abuse", evidence: [] });
    expect(await q.findDuplicate("demo", "rui", "Add rate limiting", "429 on abuse")).toBeNull();
  });

  it("does not dedup outside the 10-minute window (window-miss)", async () => {
    const q = await makeQueue();
    const first = await q.submit("demo", "dana", { title: "Add rate limiting", body: "429 on abuse", evidence: [] });
    // age the task past the dedup window
    await q.db
      .prepare("UPDATE tasks SET created_at=? WHERE id=?")
      .run(Date.now() - DEDUP_WINDOW_MS - 1000, first);
    expect(await q.findDuplicate("demo", "dana", "Add rate limiting", "429 on abuse")).toBeNull();
  });

  it("does not dedup against a DONE task", async () => {
    const q = await makeQueue();
    const first = await q.submit("demo", "dana", { title: "Add rate limiting", body: "429 on abuse", evidence: [] });
    await q.db.prepare("UPDATE tasks SET state='DONE' WHERE id=?").run(first);
    expect(await q.findDuplicate("demo", "dana", "Add rate limiting", "429 on abuse")).toBeNull();
  });

  it("surfaces a pending mediator question, and only that", async () => {
    const q = await makeQueue();
    const id = await q.submit("demo", "dana", { title: "T", body: "b", evidence: [] });
    expect(await q.pendingMediatorQuestion(id)).toBeNull();
    const inserted = (await q.db
      .prepare(
        "INSERT INTO questions (project_id, task_id, asked_by, question, created_at) VALUES ('demo', ?, 'mediator', 'which region?', ?) RETURNING id",
      )
      .get<{ id: number }>(id, Date.now())) as { id: number };
    // a coder question on the same task must not be mistaken for a clarify
    await q.db
      .prepare(
        "INSERT INTO questions (project_id, task_id, asked_by, question, created_at) VALUES ('demo', ?, 'rui', 'blocked?', ?)",
      )
      .run(id, Date.now());
    expect(await q.pendingMediatorQuestion(id)).toEqual({ id: inserted.id, question: "which region?" });
    // answered questions stop being pending
    await q.db.prepare("UPDATE questions SET status='answered', answer='eu' WHERE id=?").run(inserted.id);
    expect(await q.pendingMediatorQuestion(id)).toBeNull();
  });
});
