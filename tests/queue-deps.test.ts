// tests/queue-deps.test.ts
//
// A dependency is ORDER ONLY (#75, reversing #57's gate): task_deps never
// blocks a claim. A QUEUED task whose predecessor is not DONE is STILL
// claimable — it is merely offered after peers whose predecessors are all
// DONE (advisory serve-order). Nothing sits HELD/PARKED waiting on a
// dependency; a coder that draws a not-yet-ready task just releases and is
// re-served later. Edges still reject self-loops and cycles and survive a
// merged-away predecessor; `waiting_on` is a display hint, not a wait.
import { describe, expect, it } from "vitest";
import {
  Queue,
  DEFAULT_LEASE_TTL_MS,
  insertDependency,
  unsatisfiedDeps,
} from "../src/queue.js";
import { openTestDb } from "./helpers/db.js";

async function makeQueue() {
  const db = await openTestDb();
  await db.prepare("INSERT INTO projects (id, name) VALUES ('demo','Demo')").run();
  return { db, q: new Queue(db) };
}

describe("dependency is order-only (not a gate)", () => {
  it("serves the predecessor first, but the dependent is still claimable while it is pending", async () => {
    const { q } = await makeQueue();
    const a = await q.submit("demo", "dana", { title: "A", body: "first", evidence: [] });
    const b = await q.submit("demo", "dana", { title: "B", body: "second", evidence: [] });
    await q.addDependency("demo", b, a); // B depends on A

    // order: A (0 unsatisfied deps) is offered before B (1 unsatisfied dep)
    const first = await q.claimNext("demo", "agent-1", DEFAULT_LEASE_TTL_MS);
    expect(first?.id).toBe(a);
    // B is NOT blocked — with A now CLAIMED (not DONE), a second agent still gets B
    const second = await q.claimNext("demo", "agent-2", DEFAULT_LEASE_TTL_MS);
    expect(second?.id).toBe(b);
  });

  it("a lone checker sees a dependent with a non-DONE predecessor as available", async () => {
    const { q } = await makeQueue();
    const a = await q.submit("demo", "dana", { title: "A", body: "first", evidence: [] });
    const b = await q.submit("demo", "dana", { title: "B", body: "second", evidence: [] });
    await q.addDependency("demo", b, a);

    // A is claimed but NOT completed — its predecessor edge is unsatisfied
    const first = await q.claimNext("demo", "agent-1", DEFAULT_LEASE_TTL_MS);
    expect(first?.id).toBe(a);
    // only B remains QUEUED; it is served despite A not being DONE (no gate)
    const woke = await q.checkWork("demo", "agent-2", 5);
    expect(woke.available_count).toBe(1);
    expect((await q.claimNext("demo", "agent-2", DEFAULT_LEASE_TTL_MS))?.id).toBe(b);
  });

  it("a dependency never auto-holds or parks the dependent — it is claimed normally", async () => {
    const { q, db } = await makeQueue();
    const a = await q.submit("demo", "dana", { title: "A", body: "first", evidence: [] });
    const b = await q.submit("demo", "dana", { title: "B", body: "second", evidence: [] });
    await q.addDependency("demo", b, a);

    await q.claimNext("demo", "agent-1", DEFAULT_LEASE_TTL_MS); // takes A
    const claimed = await q.claimNext("demo", "agent-2", DEFAULT_LEASE_TTL_MS); // takes B
    expect(claimed?.id).toBe(b);
    // B went straight to CLAIMED — a dependency never parked or held it
    const bRow = await db.prepare("SELECT state FROM tasks WHERE id = ?").get<{ state: string }>(b);
    expect(bRow?.state).toBe("CLAIMED");
    const stuck = await db
      .prepare("SELECT COUNT(*) AS n FROM tasks WHERE state IN ('HELD','PARKED')")
      .get<{ n: number }>();
    expect(stuck?.n).toBe(0);
  });

  it("merging a predecessor away clears the dangling edge (the dependent has no unsatisfied deps)", async () => {
    const { q, db } = await makeQueue();
    const duplicateTitle = "Remove merged dependency predecessor";
    const duplicateBody = "Clear dependency edges after merging a duplicate predecessor.";
    const a = await q.submit("demo", "dana", { title: duplicateTitle, body: duplicateBody, evidence: [] });
    const b = await q.submit("demo", "dana", { title: "B", body: "second", evidence: [] });
    const target = await q.submit("demo", "dana", { title: duplicateTitle, body: duplicateBody, evidence: [] });
    await q.addDependency("demo", b, a);
    expect(await unsatisfiedDeps(db, b)).toEqual([a]);

    await q.applyGroomMerge(a, target); // A merged into T, A row deleted
    expect(await unsatisfiedDeps(db, b)).toEqual([]);
    const claimed = await q.claimNext("demo", "agent-1", DEFAULT_LEASE_TTL_MS);
    expect([b, target]).toContain(claimed?.id);
  });

  it("status() surfaces waiting_on as a display hint while the predecessor is pending, then clears when DONE", async () => {
    const { q } = await makeQueue();
    const a = await q.submit("demo", "dana", { title: "A", body: "first", evidence: [] });
    const b = await q.submit("demo", "dana", { title: "B", body: "second", evidence: [] });
    await q.addDependency("demo", b, a);

    let tasks = (await q.status("demo")).tasks;
    expect(tasks.find((t) => t.id === b)?.waiting_on).toEqual([a]);
    expect(tasks.find((t) => t.id === a)?.waiting_on).toEqual([]);

    await q.claimNext("demo", "agent-1", DEFAULT_LEASE_TTL_MS);
    await q.complete(a, "agent-1", "done", "https://github.com/x/y/pull/2");
    tasks = (await q.status("demo")).tasks;
    expect(tasks.find((t) => t.id === b)?.waiting_on).toEqual([]);
  });

  it("insertDependency rejects a self-edge and a cycle", async () => {
    const { q, db } = await makeQueue();
    const a = await q.submit("demo", "dana", { title: "A", body: "b", evidence: [] });
    const b = await q.submit("demo", "dana", { title: "B", body: "b", evidence: [] });
    await expect(insertDependency(db, "demo", a, a)).rejects.toThrow(/itself/);
    await insertDependency(db, "demo", b, a); // B depends on A
    await expect(insertDependency(db, "demo", a, b)).rejects.toThrow(/cycle/);
  });

  it("insertDependency rejects a cross-project or unknown task id", async () => {
    const { q, db } = await makeQueue();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('other','Other')").run();
    const a = await q.submit("demo", "dana", { title: "A", body: "b", evidence: [] });
    const foreign = await q.submit("other", "dana", { title: "F", body: "b", evidence: [] });
    await expect(insertDependency(db, "demo", a, foreign)).rejects.toThrow(/must exist in project/);
    await expect(insertDependency(db, "demo", a, 9999)).rejects.toThrow(/must exist in project/);
  });
});
