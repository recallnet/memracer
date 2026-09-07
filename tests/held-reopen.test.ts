// tests/held-reopen.test.ts — reversible closes: HELD state, hold/reopen
// mediator actions, correct trigger attribution, and the task-53-gated
// rescind_memory action (graceful degradation + enabled path).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { Queue, DEFAULT_LEASE_TTL_MS } from "../src/queue.js";
import { MediatorWorker } from "../src/mediator/worker.js";
import { registerPipelines } from "../src/mediator/pipelines.js";
import { FakeDriver } from "../src/mediator/fake.js";
import { MemoryStore } from "../src/mediator/memory.js";
import { openTestDb } from "./helpers/db.js";

async function setup() {
  const db = await openTestDb();
  await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
  const queue = new Queue(db);
  const worker = new MediatorWorker(db, { tickMs: 20, jobTimeoutMs: 2000 });
  registerPipelines({ db, queue, worker, driverFor: () => new FakeDriver() });
  worker.start();
  return { db, queue, worker };
}

let active: MediatorWorker | undefined;
afterEach(() => active?.stop());

describe("reversible closes: HELD + hold/reopen", () => {
  it("hold moves a QUEUED task to HELD with the trigger + reason recorded", async () => {
    const { db, queue, worker } = await setup();
    active = worker;
    const id = await queue.submit("p", "dana", { title: "later", body: "b", evidence: [] });
    const result = JSON.parse(
      (await worker.waitForJob(await worker.enqueue("p", "discuss", { message: `hold task ${id}: deferred to next sprint`, from: "andrew" }), 3000)).result!,
    );
    expect(result.applied).toEqual([{ action: "hold", task_id: id, reason: "deferred to next sprint" }]);
    expect(result.refused).toEqual([]);
    const brief = await queue.brief(id);
    expect(brief.state).toBe("HELD");
    expect(brief.hold_cause).toBe("explicit");
    // Attribution is the operator who directed it — never fabricated.
    expect(brief.result_summary).toBe("held (operator:andrew): deferred to next sprint");
    expect(await db.prepare("SELECT kind, task_id, rationale FROM decision_log").all()).toEqual([
      { kind: "hold", task_id: id, rationale: "deferred to next sprint" },
    ]);
  });

  it("hold releases a CLAIMED task's lease and resolves its open questions", async () => {
    const { db, queue, worker } = await setup();
    active = worker;
    const id = await queue.submit("p", "dana", { title: "in flight", body: "b", evidence: [] });
    await queue.claimNext("p", "cc-1", DEFAULT_LEASE_TTL_MS);
    await db.prepare(
      "INSERT INTO questions (project_id, task_id, asked_by, question, created_at) VALUES ('p', ?, 'cc-1', 'blocked?', 1)",
    ).run(id);
    await worker.waitForJob(await worker.enqueue("p", "discuss", { message: `hold task ${id}: pause it`, from: "andrew" }), 3000);
    const brief = await queue.brief(id);
    expect(brief.state).toBe("HELD");
    expect(brief.lease_agent).toBeNull();
    expect(brief.lease_expires_at).toBeNull();
    expect(await db.prepare("SELECT status FROM questions WHERE task_id=?").get(id)).toEqual({ status: "answered" });
  });

  it("a HELD task is never handed to a claiming coder", async () => {
    const { queue, worker } = await setup();
    active = worker;
    const id = await queue.submit("p", "dana", { title: "held work", body: "b", evidence: [] });
    await worker.waitForJob(await worker.enqueue("p", "discuss", { message: `hold task ${id}: not now`, from: "andrew" }), 3000);
    expect(await queue.claimNext("p", "cc-1", DEFAULT_LEASE_TTL_MS)).toBeNull();
  });

  it("hold refuses a DONE task (use reopen) and an already-HELD task", async () => {
    const { db, queue, worker } = await setup();
    active = worker;
    const done = await queue.submit("p", "dana", { title: "shipped", body: "b", evidence: [] });
    await queue.claimNext("p", "cc-1", DEFAULT_LEASE_TTL_MS);
    await queue.complete(done, "cc-1", "shipped", "https://github.com/x/y/pull/9");
    const held = await queue.submit("p", "dana", { title: "held", body: "b", evidence: [] });
    await worker.waitForJob(await worker.enqueue("p", "discuss", { message: `hold task ${held}: pause`, from: "andrew" }), 3000);

    const result = JSON.parse(
      (await worker.waitForJob(await worker.enqueue("p", "discuss", {
        message: `hold task ${done}: no\nhold task ${held}: again`, from: "andrew",
      }), 3000)).result!,
    );
    expect(result.applied).toEqual([]);
    expect(result.refused).toEqual([
      { action: "hold", task_id: done, reason: `task ${done} is DONE — use reopen` },
      { action: "hold", task_id: held, reason: `task ${held} is already HELD` },
    ]);
    void db;
  });

  it("reopen brings a HELD task back to QUEUED and clears its summary", async () => {
    const { db, queue, worker } = await setup();
    active = worker;
    const id = await queue.submit("p", "dana", { title: "revived", body: "b", evidence: [] });
    await worker.waitForJob(await worker.enqueue("p", "discuss", { message: `hold task ${id}: wait`, from: "andrew" }), 3000);
    const result = JSON.parse(
      (await worker.waitForJob(await worker.enqueue("p", "discuss", { message: `reopen task ${id}: unblocked now`, from: "andrew" }), 3000)).result!,
    );
    expect(result.applied).toEqual([{ action: "reopen", task_id: id, reason: "unblocked now" }]);
    const brief = await queue.brief(id);
    expect(brief.state).toBe("QUEUED");
    expect(brief.result_summary).toBeNull();
    expect(brief.queue_generation).toBe(2);
    expect(brief.queued_at).toBeGreaterThan(0);
    // reopened task is claimable again
    expect(await queue.claimNext("p", "cc-1", DEFAULT_LEASE_TTL_MS)).not.toBeNull();
    expect(await db.prepare("SELECT kind FROM decision_log ORDER BY id").all()).toEqual([
      { kind: "hold" }, { kind: "reopen" },
    ]);
  });

  it("reopen recovers a DONE task that never shipped a PR (a wrong close)", async () => {
    const { queue, worker } = await setup();
    active = worker;
    const id = await queue.submit("p", "dana", { title: "wrongly closed", body: "b", evidence: [] });
    // A close with no PR — exactly the #4/#11/#39 gate mistake.
    await worker.waitForJob(await worker.enqueue("p", "discuss", { message: `close task ${id}: mistaken`, from: "andrew" }), 3000);
    expect((await queue.brief(id)).state).toBe("DONE");
    const result = JSON.parse(
      (await worker.waitForJob(await worker.enqueue("p", "discuss", { message: `reopen task ${id}: closed by mistake`, from: "andrew" }), 3000)).result!,
    );
    expect(result.applied).toEqual([{ action: "reopen", task_id: id, reason: "closed by mistake" }]);
    expect(await queue.brief(id)).toMatchObject({ state: "QUEUED", queue_generation: 2 });
  });

  it("reopen refuses a genuine completion (DONE with a PR) and a non-held live task", async () => {
    const { queue, worker } = await setup();
    active = worker;
    const shipped = await queue.submit("p", "dana", { title: "real ship", body: "b", evidence: [] });
    await queue.claimNext("p", "cc-1", DEFAULT_LEASE_TTL_MS);
    await queue.complete(shipped, "cc-1", "done", "https://github.com/x/y/pull/42");
    const live = await queue.submit("p", "dana", { title: "queued", body: "b", evidence: [] });

    const result = JSON.parse(
      (await worker.waitForJob(await worker.enqueue("p", "discuss", {
        message: `reopen task ${shipped}: no\nreopen task ${live}: no`, from: "andrew",
      }), 3000)).result!,
    );
    expect(result.applied).toEqual([]);
    expect(result.refused).toEqual([
      { action: "reopen", task_id: shipped, reason: `task ${shipped} is DONE with a PR — a real completion, not reopenable` },
      { action: "reopen", task_id: live, reason: `task ${live} is QUEUED, not HELD` },
    ]);
  });

  it("attribution: a coder ask that closes its own task records coder:<agent>, never operator", async () => {
    const { queue, worker } = await setup();
    active = worker;
    const id = await queue.submit("p", "dana", { title: "gone upstream", body: "b", evidence: [] });
    await queue.claimNext("p", "cc-1", DEFAULT_LEASE_TTL_MS);
    await worker.waitForJob(await worker.enqueue("p", "answer", {
      taskId: id, question: `close task ${id}: endpoint removed upstream`, agent: "cc-1",
    }), 3000);
    const brief = await queue.brief(id);
    expect(brief.state).toBe("DONE");
    expect(brief.result_summary).toBe("closed (coder:cc-1): endpoint removed upstream");
    expect(brief.result_summary).not.toContain("operator");
  });
});

describe("rescind_memory (item 3 — task-53-gated)", () => {
  async function seedDoc(db: import("../src/db.js").Db) {
    const memory = new MemoryStore(db);
    await memory.upsert("p", {
      path: "learnings/stale.md",
      type: "Learning",
      title: "Stale learning",
      description: "no longer true",
      tags: ["x"],
      body: "outdated",
    });
    return memory;
  }

  it("graceful degradation: refuses with a clear 'unavailable — task 53' reason and leaves the doc intact", async () => {
    delete process.env.MEMRACER_MEMORY_RESCIND; // default: capability off
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
    const memory = await seedDoc(db);
    const queue = new Queue(db);
    const worker = new MediatorWorker(db, { tickMs: 20, jobTimeoutMs: 2000 });
    registerPipelines({ db, queue, worker, driverFor: () => new FakeDriver() });
    worker.start();
    active = worker;

    const result = JSON.parse(
      (await worker.waitForJob(await worker.enqueue("p", "discuss", { message: "rescind memory learnings/stale.md: wrong", from: "andrew" }), 3000)).result!,
    );
    expect(result.applied).toEqual([]);
    expect(result.refused).toEqual([
      { action: "rescind_memory", path: "learnings/stale.md", reason: "rescind_memory unavailable — task 53 (mediator memory-write tools) not landed" },
    ]);
    expect(await memory.get("p", "learnings/stale.md")).not.toBeNull();
  });

  it("enabled: removes the authored doc, logs it, and refuses an unknown path", async () => {
    process.env.MEMRACER_MEMORY_RESCIND = "1";
    try {
      const db = await openTestDb();
      await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
      const memory = await seedDoc(db);
      const queue = new Queue(db);
      const worker = new MediatorWorker(db, { tickMs: 20, jobTimeoutMs: 2000 });
      registerPipelines({ db, queue, worker, driverFor: () => new FakeDriver() });
      worker.start();
      active = worker;

      const result = JSON.parse(
        (await worker.waitForJob(await worker.enqueue("p", "discuss", {
          message: "rescind memory learnings/stale.md: superseded\nrescind memory learnings/ghost.md: nope",
          from: "andrew",
        }), 3000)).result!,
      );
      expect(result.applied).toEqual([{ action: "rescind_memory", path: "learnings/stale.md", reason: "superseded" }]);
      expect(result.refused).toEqual([
        { action: "rescind_memory", path: "learnings/ghost.md", reason: "memory doc learnings/ghost.md not found" },
      ]);
      expect(await memory.get("p", "learnings/stale.md")).toBeNull();
      const log = await db.prepare("SELECT entry FROM memory_log ORDER BY id DESC LIMIT 1").get<{ entry: string }>();
      expect(log?.entry).toContain("rescinded learnings/stale.md (operator:andrew)");
    } finally {
      delete process.env.MEMRACER_MEMORY_RESCIND;
    }
  });
});

describe("tasks.state CHECK migration (adds HELD)", () => {
  it("widens the state CHECK on a pre-HELD database so hold/HELD writes succeed", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "memracer-held-")), "mini.db");
    const old = new Database(path);
    // A pre-HELD tasks table: old CHECK, and columns in a different physical
    // order than canonical (result_summary before grooming_rationale, no
    // watermark/plan/pr columns) so the rebuild's named-column copy is exercised.
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
    // Pre-existing row survives the rebuild with its id intact.
    expect(await db.prepare("SELECT id, title, state FROM tasks").get()).toEqual({
      id: 1, title: "old task", state: "QUEUED",
    });
    // The widened CHECK now admits HELD.
    await db.prepare("UPDATE tasks SET state='HELD' WHERE id=1").run();
    expect(await db.prepare("SELECT state FROM tasks").get()).toEqual({ state: "HELD" });
    await db.close();

    // Reopening is idempotent — no second rebuild, data intact.
    const again = openDb(path);
    expect(await again.prepare("SELECT state FROM tasks").get()).toEqual({ state: "HELD" });
    await again.close();
  });
});
