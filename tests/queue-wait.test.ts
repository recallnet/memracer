import { describe, expect, it } from "vitest";
import { Queue, DEFAULT_LEASE_TTL_MS, LEASE_RECOVERY_GRACE_MS } from "../src/queue.js";
import { openTestDb } from "./helpers/db.js";

async function makeQueue() {
  const db = await openTestDb();
  await db.prepare("INSERT INTO projects (id, name) VALUES ('demo','Demo')").run();
  return { db, q: new Queue(db) };
}

async function mutationSnapshot(db: Awaited<ReturnType<typeof openTestDb>>, taskId: number) {
  return {
    task: await db.prepare(
      "SELECT state, lease_agent, lease_expires_at, plan_deadline, updated_at, queue_generation FROM tasks WHERE id = ?",
    ).get(taskId),
    attempts: await db.prepare("SELECT * FROM attempts WHERE task_id = ? ORDER BY id").all(taskId),
    project: await db.prepare(
      "SELECT claim_generation, last_active_lease_at FROM projects WHERE id = 'demo'",
    ).get(),
  };
}

describe("Queue.checkWork", () => {
  it("reports queued work without claiming or exposing a task id", async () => {
    const { db, q } = await makeQueue();
    const id = await q.submit("demo", "dana", { title: "t", body: "b", priority: 2, evidence: [] });
    const before = await mutationSnapshot(db, id);

    const expected = {
      available_count: 1,
      peek: [{ project_id: "demo", title: "t", priority: 2 }],
    };
    expect(await q.checkWork("demo", "cc-1", 5, 5)).toEqual(expected);
    expect(await q.checkWork("demo", "cc-1", 5, 5)).toEqual(expected);
    expect(await q.checkWork("demo", "cc-1", 5, 5)).toEqual(expected);
    expect(await mutationSnapshot(db, id)).toEqual(before);
  });

  it("wakes a parked checker when a task is submitted, without claiming it", async () => {
    const { db, q } = await makeQueue();
    const parked = q.checkWork("demo", "cc-1", 30, 1);
    await new Promise((r) => setTimeout(r, 50));
    const id = await q.submit("demo", "dana", { title: "t", body: "b", evidence: [] });
    expect(await parked).toEqual({
      available_count: 1,
      peek: [{ project_id: "demo", title: "t", priority: 2 }],
    });
    expect(await db.prepare("SELECT state FROM tasks WHERE id = ?").get(id)).toEqual({ state: "QUEUED" });
  });

  it("counts work across projects and caps advisory peeks", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('a','A')").run();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('b','B')").run();
    const q = new Queue(db);
    await q.submit("a", "dana", { title: "a", body: "b", evidence: [] });
    await q.submit("b", "dana", { title: "b", body: "b", evidence: [] });

    expect(await q.checkWorkAny(["a", "b"], "cc-1", 5, 1)).toEqual({
      available_count: 2,
      peek: [{ project_id: "a", title: "a", priority: 2 }],
    });
  });

  it("orders bounded peeks by dependency readiness, priority, then id", async () => {
    const { q } = await makeQueue();
    const first = await q.submit("demo", "dana", { title: "first", body: "b", priority: 1, evidence: [] });
    await q.submit("demo", "dana", { title: "priority zero", body: "b", priority: 0, evidence: [] });
    const dependent = await q.submit("demo", "dana", { title: "not ready", body: "b", priority: 0, evidence: [] });
    await q.addDependency("demo", dependent, first);

    expect(await q.checkWork("demo", "cc-1", 5, 2)).toEqual({
      available_count: 3,
      peek: [
        { project_id: "demo", title: "priority zero", priority: 0 },
        { project_id: "demo", title: "first", priority: 1 },
      ],
    });
  });

  it("honors release cooldown for the releaser without hiding work from another agent", async () => {
    const { q } = await makeQueue();
    const id = await q.submit("demo", "dana", { title: "released", body: "b", evidence: [] });
    await q.claimNext("demo", "agent-1", DEFAULT_LEASE_TTL_MS);
    await q.release(id, "agent-1", "wrong fit");

    expect((await q.checkWork("demo", "agent-1", 1)).available_count).toBe(0);
    expect((await q.checkWork("demo", "agent-2", 1)).available_count).toBe(1);
  });

  it("wakes a parked checker on a submission to any watched project", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('a','A')").run();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('b','B')").run();
    const q = new Queue(db);
    const parked = q.checkWorkAny(["a", "b"], "cc-1", 30);
    await new Promise((r) => setTimeout(r, 50));
    await q.submit("a", "dana", { title: "t", body: "b", evidence: [] });
    expect((await parked).available_count).toBe(1);
  });

  it("returns an empty result after the timeout", async () => {
    const { q } = await makeQueue();
    const started = Date.now();
    expect(await q.checkWork("demo", "cc-1", 1)).toEqual({ available_count: 0, peek: [] });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
  });

  it("reports an expired lease without requeueing it until explicit claim", async () => {
    const { db, q } = await makeQueue();
    const id = await q.submit("demo", "dana", { title: "expired lease", body: "b", evidence: [] });
    await q.claimNext("demo", "old-agent", DEFAULT_LEASE_TTL_MS);
    await db.prepare("UPDATE tasks SET lease_expires_at = ? WHERE id = ?").run(Date.now() - LEASE_RECOVERY_GRACE_MS - 1, id);
    const before = await mutationSnapshot(db, id);

    const expected = {
      available_count: 1,
      peek: [{ project_id: "demo", title: "expired lease", priority: 2 }],
    };
    expect(await q.checkWork("demo", "new-agent", 1, 1)).toEqual(expected);
    expect(await q.checkWork("demo", "new-agent", 1, 1)).toEqual(expected);
    expect(await q.checkWork("demo", "new-agent", 1, 1)).toEqual(expected);
    expect(await mutationSnapshot(db, id)).toEqual(before);
    expect((await q.claimNext("demo", "new-agent", DEFAULT_LEASE_TTL_MS))?.id).toBe(id);
  });

  it("keeps a newly expired lease unavailable during owner recovery grace", async () => {
    const { db, q } = await makeQueue();
    const id = await q.submit("demo", "dana", { title: "recovering lease", body: "b", evidence: [] });
    await q.claimNext("demo", "old-agent", DEFAULT_LEASE_TTL_MS);
    await db.prepare("UPDATE tasks SET lease_expires_at = ? WHERE id = ?").run(Date.now() - 1, id);

    expect(await q.checkWork("demo", "new-agent", 1, 1)).toEqual({ available_count: 0, peek: [] });
    expect(await q.claimNext("demo", "new-agent", DEFAULT_LEASE_TTL_MS)).toBeNull();
    expect((await q.brief(id)).lease_agent).toBe("old-agent");
  });

  it("reports an expired plan window without mutating a live lease", async () => {
    const { db, q } = await makeQueue();
    const id = await q.submit("demo", "dana", { title: "expired plan", body: "b", evidence: [] });
    await q.claimNext("demo", "old-agent", DEFAULT_LEASE_TTL_MS);
    await db.prepare("UPDATE tasks SET plan_deadline = ? WHERE id = ?").run(Date.now() - 1, id);
    const before = await mutationSnapshot(db, id);

    expect((await q.checkWork("demo", "new-agent", 1)).available_count).toBe(1);
    expect((await q.checkWork("demo", "new-agent", 1)).available_count).toBe(1);
    expect((await q.checkWork("demo", "new-agent", 1)).available_count).toBe(1);
    expect(await mutationSnapshot(db, id)).toEqual(before);
    expect((await q.claimNext("demo", "new-agent", DEFAULT_LEASE_TTL_MS))?.id).toBe(id);
  });
});
