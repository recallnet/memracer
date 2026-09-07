// tests/queue-incubation.test.ts
//
// Warming period (#61): a warm_for submission is born INCUBATING with a
// graduation clock, invisible to coders; graduate()/sealEarly() flip it to
// QUEUED and wake a parked waiter; extendIncubation() pushes the clock; and the
// SQLite state-CHECK rebuild lets an INCUBATING insert land on a pre-#61 DB.
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Queue, DEFAULT_LEASE_TTL_MS, parseWarmFor } from "../src/queue.js";
import { openDb } from "../src/db.js";
import { openTestDb } from "./helpers/db.js";

async function makeQueue() {
  const db = await openTestDb();
  await db.prepare("INSERT INTO projects (id, name) VALUES ('demo','Demo')").run();
  return { db, q: new Queue(db) };
}

const HOUR = 60 * 60 * 1000;

describe("warming period — INCUBATING lifecycle", () => {
  it("a warm submission is born INCUBATING with incubate_until ~ now + warmForMs", async () => {
    const { q, db } = await makeQueue();
    const before = Date.now();
    const id = await q.submit("demo", "dana", { title: "A", body: "b", evidence: [], warmForMs: HOUR });
    const row = await db
      .prepare("SELECT state, incubate_until FROM tasks WHERE id=?")
      .get<{ state: string; incubate_until: number }>(id);
    expect(row?.state).toBe("INCUBATING");
    expect(row?.incubate_until).toBeGreaterThanOrEqual(before + HOUR);
    expect(row?.incubate_until).toBeLessThanOrEqual(Date.now() + HOUR);
  });

  it("a plain submission is QUEUED with no clock (unchanged behaviour)", async () => {
    const { q, db } = await makeQueue();
    const id = await q.submit("demo", "dana", { title: "A", body: "b", evidence: [] });
    const row = await db
      .prepare("SELECT state, incubate_until FROM tasks WHERE id=?")
      .get<{ state: string; incubate_until: number | null }>(id);
    expect(row?.state).toBe("QUEUED");
    expect(row?.incubate_until).toBeNull();
  });

  it("claimNext never returns an INCUBATING task, even beside a claimable one", async () => {
    const { q } = await makeQueue();
    const warm = await q.submit("demo", "dana", { title: "warm", body: "b", evidence: [], warmForMs: HOUR });
    const ready = await q.submit("demo", "dana", { title: "ready", body: "b", evidence: [] });
    const first = await q.claimNext("demo", "agent-1", DEFAULT_LEASE_TTL_MS);
    expect(first?.id).toBe(ready);
    const second = await q.claimNext("demo", "agent-2", DEFAULT_LEASE_TTL_MS);
    expect(second).toBeNull();
    // the warm task is still incubating, never leased
    expect(second?.id).not.toBe(warm);
  });

  it("graduate() flips INCUBATING -> QUEUED and it becomes claimable", async () => {
    const { q, db } = await makeQueue();
    const id = await q.submit("demo", "dana", { title: "A", body: "b", evidence: [], warmForMs: HOUR });
    expect(await q.claimNext("demo", "agent-1", DEFAULT_LEASE_TTL_MS)).toBeNull();
    expect(await q.graduate(id)).toBe(true);
    const graduated = await q.brief(id);
    expect(graduated.queued_at).toBeGreaterThan(0);
    expect(graduated.queue_generation).toBe(1);
    const row = await db.prepare("SELECT state, incubate_until FROM tasks WHERE id=?").get<{ state: string; incubate_until: number | null }>(id);
    expect(row?.state).toBe("QUEUED");
    expect(row?.incubate_until).toBeNull();
    const claimed = await q.claimNext("demo", "agent-1", DEFAULT_LEASE_TTL_MS);
    expect(claimed?.id).toBe(id);
    // graduating a non-incubating task is a no-op
    expect(await q.graduate(id)).toBe(false);
  });

  it("graduation wakes a parked coder availability check", async () => {
    const { q } = await makeQueue();
    const id = await q.submit("demo", "dana", { title: "A", body: "b", evidence: [], warmForMs: HOUR });
    const waiting = q.checkWork("demo", "agent-2", 5);
    await q.graduate(id);
    const woke = await waiting;
    expect(woke.available_count).toBe(1);
    expect((await q.claimNext("demo", "agent-2", DEFAULT_LEASE_TTL_MS))?.id).toBe(id);
  });

  it("sealEarly() graduates before the clock; dueIncubations reflects the clock", async () => {
    const { q } = await makeQueue();
    const id = await q.submit("demo", "dana", { title: "A", body: "b", evidence: [], warmForMs: HOUR });
    // not due yet
    expect(await q.dueIncubations()).toEqual([]);
    // due in the far future
    expect((await q.dueIncubations(Date.now() + 2 * HOUR)).map((t) => t.id)).toEqual([id]);
    expect(await q.sealEarly(id)).toBe(true);
    expect(await q.dueIncubations(Date.now() + 2 * HOUR)).toEqual([]);
    const claimed = await q.claimNext("demo", "agent-1", DEFAULT_LEASE_TTL_MS);
    expect(claimed?.id).toBe(id);
  });

  it("warm() atomically moves only QUEUED work into INCUBATING", async () => {
    const { q, db } = await makeQueue();
    const id = await q.submit("demo", "dana", { title: "A", body: "b", evidence: [] });
    const until = Date.now() + HOUR;

    expect(await q.warm(id, until)).toBe(true);
    expect(
      await db
        .prepare("SELECT state, incubate_until FROM tasks WHERE id=?")
        .get<{ state: string; incubate_until: number }>(id),
    ).toMatchObject({ state: "INCUBATING", incubate_until: until });
    expect(await q.claimNext("demo", "agent-1", DEFAULT_LEASE_TTL_MS)).toBeNull();

    // The state guard makes retries and every non-QUEUED transition no-ops.
    expect(await q.warm(id, until + HOUR)).toBe(false);
    await q.graduate(id);
    const claimed = await q.claimNext("demo", "agent-1", DEFAULT_LEASE_TTL_MS);
    expect(claimed?.id).toBe(id);
    expect(await q.warm(id, until + HOUR)).toBe(false);
    const active = await db
      .prepare("SELECT state, lease_agent, incubate_until FROM tasks WHERE id=?")
      .get<{ state: string; lease_agent: string; incubate_until: null }>(id);
    expect(active).toMatchObject({ state: "CLAIMED", lease_agent: "agent-1", incubate_until: null });
  });

  it("warm() invalidates a released task's approved plan without erasing attempt history", async () => {
    const { q } = await makeQueue();
    const id = await q.submit("demo", "dana", { title: "A", body: "b", evidence: [] });
    await q.claimNext("demo", "agent-1", DEFAULT_LEASE_TTL_MS);
    await q.approvePlan(id, "implement the old canonical spec");
    const released = await q.release(id, "agent-1", "needs more research first");
    expect(released).toMatchObject({
      state: "QUEUED",
      plan: "implement the old canonical spec",
      lease_agent: null,
      lease_expires_at: null,
    });
    expect(released.plan_approved_at).toBeGreaterThan(0);
    expect(released.attempts).toEqual([
      expect.objectContaining({ agent: "agent-1", outcome: "released", notes: "needs more research first" }),
    ]);

    expect(await q.warm(id, Date.now() + HOUR)).toBe(true);
    const warming = await q.brief(id);
    expect(warming).toMatchObject({
      state: "INCUBATING",
      plan: null,
      plan_approved_at: null,
      plan_deadline: null,
      lease_agent: null,
      lease_expires_at: null,
    });
    expect(warming.attempts).toEqual(released.attempts);

    await q.graduate(id);
    const reclaimed = await q.claimNext("demo", "agent-2", DEFAULT_LEASE_TTL_MS);
    expect(reclaimed).toMatchObject({ id, state: "CLAIMED", plan: null, plan_approved_at: null });
    expect(reclaimed?.plan_deadline).toBeGreaterThan(Date.now());
    expect(reclaimed?.attempts).toEqual(released.attempts);
  });

  it("extendIncubation() pushes the clock and keeps the task unclaimable", async () => {
    const { q, db } = await makeQueue();
    const id = await q.submit("demo", "dana", { title: "A", body: "b", evidence: [], warmForMs: HOUR });
    const pushed = Date.now() + 5 * HOUR;
    expect(await q.extendIncubation(id, pushed)).toBe(true);
    const row = await db.prepare("SELECT incubate_until FROM tasks WHERE id=?").get<{ incubate_until: number }>(id);
    expect(row?.incubate_until).toBe(pushed);
    // still not due at now+2h, still not claimable
    expect(await q.dueIncubations(Date.now() + 2 * HOUR)).toEqual([]);
    expect(await q.claimNext("demo", "agent-1", DEFAULT_LEASE_TTL_MS)).toBeNull();
    // extend refuses a graduated task
    await q.graduate(id);
    expect(await q.extendIncubation(id, pushed)).toBe(false);
  });
});

describe("parseWarmFor", () => {
  it("accepts the 1h/1d/1w presets", () => {
    expect(parseWarmFor("1h")).toBe(HOUR);
    expect(parseWarmFor("1d")).toBe(24 * HOUR);
    expect(parseWarmFor("1w")).toBe(7 * 24 * HOUR);
    expect(parseWarmFor(" 1H ")).toBe(HOUR);
  });
  it("accepts ISO-8601 durations", () => {
    expect(parseWarmFor("PT30M")).toBe(30 * 60 * 1000);
    expect(parseWarmFor("PT1H30M")).toBe(90 * 60 * 1000);
    expect(parseWarmFor("P2D")).toBe(2 * 24 * HOUR);
    expect(parseWarmFor("P1W")).toBe(7 * 24 * HOUR);
  });
  it("rejects garbage and empty/zero durations", () => {
    expect(() => parseWarmFor("soon")).toThrow(/invalid warm_for/);
    expect(() => parseWarmFor("")).toThrow(/invalid warm_for/);
    expect(() => parseWarmFor("P")).toThrow(/invalid warm_for/);
    expect(() => parseWarmFor("PT")).toThrow(/invalid warm_for/);
    expect(() => parseWarmFor("2h")).toThrow(/invalid warm_for/); // only 1h/1d/1w are presets
  });
});

describe("migrateTasksStateCheck (SQLite state-CHECK widening)", () => {
  it("lets an INCUBATING insert land on a DB created before the INCUBATING state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memracer-mig-"));
    const path = join(dir, "old.db");
    // Hand-build a pre-#61 database: the old tasks CHECK omits INCUBATING.
    const raw = new Database(path);
    raw.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, repo TEXT, mediator_model TEXT NOT NULL DEFAULT 'x');
      CREATE TABLE threads (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, kind TEXT NOT NULL, task_id INTEGER, created_at INTEGER NOT NULL);
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 2,
        state TEXT NOT NULL DEFAULT 'QUEUED'
          CHECK (state IN ('QUEUED','CLAIMED','PLANNED','EXECUTING','DONE','BLOCKED','PARKED')),
        base_sha TEXT,
        repo TEXT,
        submitted_by TEXT NOT NULL,
        watermark TEXT,
        lease_agent TEXT,
        lease_expires_at INTEGER,
        result_summary TEXT,
        result_pr_url TEXT,
        result_pr_number INTEGER,
        result_pr_description TEXT,
        pr_verification TEXT,
        pr_verification_etag TEXT,
        grooming_rationale TEXT,
        parent_id INTEGER REFERENCES tasks(id),
        plan TEXT,
        plan_deadline INTEGER,
        plan_approved_at INTEGER,
        root_thread_id INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO projects (id, name) VALUES ('demo','Demo');
      INSERT INTO tasks (project_id, title, body, submitted_by, created_at, updated_at)
        VALUES ('demo','legacy','b','dana', 100, 100);
    `);
    // Sanity: the old CHECK rejects INCUBATING before migration.
    expect(() => raw.prepare("UPDATE tasks SET state='INCUBATING' WHERE id=1").run()).toThrow();
    raw.close();

    // openDb runs the migration path (ensureColumns adds incubate_until, then
    // migrateTasksStateCheck widens the CHECK).
    const db = openDb(path);
    // The legacy row survived the rebuild intact.
    const legacy = await db.prepare("SELECT id, title, submitted_by, created_at FROM tasks WHERE id=1").get<{ id: number; title: string; submitted_by: string; created_at: number }>();
    expect(legacy).toMatchObject({ id: 1, title: "legacy", submitted_by: "dana", created_at: 100 });
    // And INCUBATING is now a legal state with the new column.
    const res = await db.prepare("UPDATE tasks SET state='INCUBATING', incubate_until=? WHERE id=1").run(12345);
    expect(res.changes).toBe(1);
    const row = await db.prepare("SELECT state, incubate_until FROM tasks WHERE id=1").get<{ state: string; incubate_until: number }>();
    expect(row).toMatchObject({ state: "INCUBATING", incubate_until: 12345 });
    await db.close();
  });
});
