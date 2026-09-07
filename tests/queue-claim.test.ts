// tests/queue-claim.test.ts
import { describe, expect, it } from "vitest";
import { Queue, DEFAULT_LEASE_TTL_MS, LEASE_RECOVERY_GRACE_MS, PLAN_WINDOW_MS } from "../src/queue.js";
import type { Db } from "../src/db.js";
import { openTestDb } from "./helpers/db.js";

async function makeQueue() {
  const db = await openTestDb();
  await db.prepare("INSERT INTO projects (id, name) VALUES ('demo','Demo')").run();
  return { db, q: new Queue(db) };
}

function afterScan(db: Db, marker: string, interleave: () => Promise<void>): Db {
  let fired = false;
  return {
    dialect: db.dialect,
    authDatabase: () => db.authDatabase(),
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
    transaction: (fn) => db.transaction(fn),
    isInTransaction: () => db.isInTransaction(),
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        get: (...params) => statement.get(...params),
        run: (...params) => statement.run(...params),
        all: async (...params) => {
          const rows = await statement.all(...params);
          if (!fired && rows.length > 0 && sql.includes(marker)) {
            fired = true;
            await interleave();
          }
          return rows;
        },
      };
    },
  };
}

describe("Queue.claimNext", () => {
  it("claims the highest-priority queued task and sets a lease", async () => {
    const { db, q } = await makeQueue();
    await q.submit("demo", "dana", { title: "low", body: "b", priority: 2, evidence: [] });
    const hi = await q.submit("demo", "dana", { title: "hi", body: "b", priority: 0, evidence: [] });
    const brief = await q.claimNext("demo", "cc-7f2", DEFAULT_LEASE_TTL_MS);
    expect(brief?.id).toBe(hi);
    expect(brief?.state).toBe("CLAIMED");
    expect(brief?.lease_agent).toBe("cc-7f2");
    expect(brief?.lease_expires_at).toBeGreaterThan(Date.now());
    expect(
      await db.prepare("SELECT claim_generation, last_active_lease_at FROM projects WHERE id='demo'").get(),
    ).toEqual({ claim_generation: 1, last_active_lease_at: brief?.updated_at });
  });

  it("never double-claims: two agents get two different tasks, third gets null", async () => {
    const { q } = await makeQueue();
    await q.submit("demo", "dana", { title: "a", body: "b", evidence: [] });
    await q.submit("demo", "dana", { title: "b", body: "b", evidence: [] });
    const one = await q.claimNext("demo", "agent-1", DEFAULT_LEASE_TTL_MS);
    const two = await q.claimNext("demo", "agent-2", DEFAULT_LEASE_TTL_MS);
    const three = await q.claimNext("demo", "agent-3", DEFAULT_LEASE_TTL_MS);
    expect(one?.id).not.toBe(two?.id);
    expect(three).toBeNull();
  });

  it("never double-claims one task under concurrent public claim attempts", async () => {
    const { q } = await makeQueue();
    const id = await q.submit("demo", "dana", { title: "only", body: "b", evidence: [] });
    const results = await Promise.all([
      q.claimNextAny(["demo"], "agent-1", DEFAULT_LEASE_TTL_MS),
      q.claimNextAny(["demo"], "agent-2", DEFAULT_LEASE_TTL_MS),
    ]);
    expect(results.filter((brief) => brief?.id === id)).toHaveLength(1);
    expect(results.filter((brief) => brief === null)).toHaveLength(1);
  });

  it("gives one seat at most one lease under concurrent claims", async () => {
    const { q } = await makeQueue();
    await q.submit("demo", "dana", { title: "first", body: "b", evidence: [] });
    await q.submit("demo", "dana", { title: "second", body: "b", evidence: [] });

    const results = await Promise.all([
      q.claimNext("demo", "same-seat", DEFAULT_LEASE_TTL_MS),
      q.claimNext("demo", "same-seat", DEFAULT_LEASE_TTL_MS),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((brief) => brief === null)).toHaveLength(1);
  });

  it("a released task is not re-served to the releasing agent during the cooldown", async () => {
    const { q } = await makeQueue();
    const id = await q.submit("demo", "dana", { title: "t", body: "b", evidence: [] });
    await q.claimNext("demo", "agent-1", DEFAULT_LEASE_TTL_MS);
    await q.release(id, "agent-1", "out of my depth");
    // release loop observed live: the releasing agent's next claim
    // re-claimed its own release immediately. Cooldown fixes that; other
    // agents are unaffected.
    expect(await q.claimNext("demo", "agent-1", DEFAULT_LEASE_TTL_MS)).toBeNull();
    const other = await q.claimNext("demo", "agent-2", DEFAULT_LEASE_TTL_MS);
    expect(other?.id).toBe(id);
    expect(other?.attempts).toEqual([
      expect.objectContaining({ agent: "agent-1", outcome: "released", notes: "out of my depth" }),
    ]);
    expect(other?.queue_generation).toBe(2);
    expect(other?.queued_at).toBeGreaterThan(0);
  });

  it("requeues an expired lease with attempt history and lets another agent claim it", async () => {
    const { db, q } = await makeQueue();
    const id = await q.submit("demo", "dana", { title: "t", body: "b", evidence: [] });
    await q.claimNext("demo", "agent-dead", 1000);
    // simulate the lease expiring
    await db.prepare("UPDATE tasks SET lease_expires_at = ? WHERE id = ?").run(Date.now() - LEASE_RECOVERY_GRACE_MS - 1, id);
    const brief = await q.claimNext("demo", "agent-2", DEFAULT_LEASE_TTL_MS);
    expect(brief?.id).toBe(id);
    expect(brief?.lease_agent).toBe("agent-2");
    expect(brief?.attempts).toEqual([
      { agent: "agent-dead", outcome: "lease_expired", notes: "lease expired; task requeued" },
    ]);
    expect(brief?.queue_generation).toBe(2);
  });

  it("a stale lease-expiry scan cannot clobber a later lease or append a phantom attempt", async () => {
    const { db, q } = await makeQueue();
    const id = await q.submit("demo", "dana", { title: "t", body: "b", evidence: [] });
    await q.claimNext("demo", "old-agent", DEFAULT_LEASE_TTL_MS);
    await db.prepare("UPDATE tasks SET lease_expires_at = ? WHERE id = ?").run(Date.now() - LEASE_RECOVERY_GRACE_MS - 1, id);
    const laterLease = Date.now() + DEFAULT_LEASE_TTL_MS;
    const laterPlan = Date.now() + PLAN_WINDOW_MS;
    const racing = new Queue(afterScan(db, "lease_expires_at FROM tasks", async () => {
      await db.prepare(
        "UPDATE tasks SET state='CLAIMED', lease_agent='later-agent', lease_expires_at=?, plan_deadline=?, updated_at=? WHERE id=?",
      ).run(laterLease, laterPlan, Date.now(), id);
    }));

    expect(await racing.claimNext("demo", "sweeper", DEFAULT_LEASE_TTL_MS)).toBeNull();
    expect(await db.prepare(
      "SELECT state, lease_agent, lease_expires_at, plan_deadline FROM tasks WHERE id=?",
    ).get(id)).toEqual({
      state: "CLAIMED",
      lease_agent: "later-agent",
      lease_expires_at: laterLease,
      plan_deadline: laterPlan,
    });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM attempts WHERE task_id=?").get(id)).toEqual({ count: 0 });
  });

  it("claim opens a plan window", async () => {
    const { q } = await makeQueue();
    await q.submit("demo", "dana", { title: "t", body: "b", evidence: [] });
    const before = Date.now();
    const brief = await q.claimNext("demo", "cc-1", DEFAULT_LEASE_TTL_MS);
    expect(brief?.plan_deadline).toBeGreaterThanOrEqual(before + PLAN_WINDOW_MS);
    expect(PLAN_WINDOW_MS).toBe(60 * 60 * 1000);
  });

  it("requeues a CLAIMED task whose plan window expired even under a live lease", async () => {
    const { db, q } = await makeQueue();
    const id = await q.submit("demo", "dana", { title: "t", body: "b", evidence: [] });
    await q.claimNext("demo", "agent-confused", DEFAULT_LEASE_TTL_MS);
    // lease still live, but the plan window has lapsed
    await db.prepare("UPDATE tasks SET plan_deadline = ? WHERE id = ?").run(Date.now() - 1, id);
    const brief = await q.claimNext("demo", "agent-2", DEFAULT_LEASE_TTL_MS);
    expect(brief?.id).toBe(id);
    expect(brief?.lease_agent).toBe("agent-2");
    expect(brief?.attempts).toEqual([
      { agent: "agent-confused", outcome: "plan_window_expired", notes: "plan window expired; task requeued" },
    ]);
    expect(brief?.queue_generation).toBe(2);
  });

  it("a stale plan-expiry scan cannot clobber a later owner or append a phantom attempt", async () => {
    const { db, q } = await makeQueue();
    const id = await q.submit("demo", "dana", { title: "t", body: "b", evidence: [] });
    await q.claimNext("demo", "old-agent", DEFAULT_LEASE_TTL_MS);
    await db.prepare("UPDATE tasks SET plan_deadline = ? WHERE id = ?").run(Date.now() - 1, id);
    const laterLease = Date.now() + DEFAULT_LEASE_TTL_MS;
    const laterPlan = Date.now() + PLAN_WINDOW_MS;
    const racing = new Queue(afterScan(db, "plan_deadline FROM tasks", async () => {
      await db.prepare(
        "UPDATE tasks SET state='CLAIMED', lease_agent='later-agent', lease_expires_at=?, plan_deadline=?, updated_at=? WHERE id=?",
      ).run(laterLease, laterPlan, Date.now(), id);
    }));

    expect(await racing.claimNext("demo", "sweeper", DEFAULT_LEASE_TTL_MS)).toBeNull();
    expect(await db.prepare(
      "SELECT state, lease_agent, lease_expires_at, plan_deadline FROM tasks WHERE id=?",
    ).get(id)).toEqual({
      state: "CLAIMED",
      lease_agent: "later-agent",
      lease_expires_at: laterLease,
      plan_deadline: laterPlan,
    });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM attempts WHERE task_id=?").get(id)).toEqual({ count: 0 });
  });

  it("requeues an EXECUTING heartbeater that never got a plan approved", async () => {
    const { db, q } = await makeQueue();
    const id = await q.submit("demo", "dana", { title: "t", body: "b", evidence: [] });
    await q.claimNext("demo", "agent-confused", DEFAULT_LEASE_TTL_MS);
    await q.progress(id, "agent-confused", "spinning", DEFAULT_LEASE_TTL_MS); // heartbeat without approval
    await db.prepare("UPDATE tasks SET plan_deadline = ? WHERE id = ?").run(Date.now() - 1, id);
    const brief = await q.claimNext("demo", "agent-2", DEFAULT_LEASE_TTL_MS);
    expect(brief?.id).toBe(id);
    expect(brief?.attempts.map((a) => a.outcome)).toEqual(["plan_window_expired"]);
  });

  it("an approved plan survives requeue and re-delivers in the next brief", async () => {
    const { db, q } = await makeQueue();
    const id = await q.submit("demo", "dana", { title: "t", body: "b", evidence: [] });
    await q.claimNext("demo", "agent-1", 1000);
    const approved = await q.approvePlan(id, "1. write test 2. fix");
    expect(approved.state).toBe("PLANNED");
    expect(approved.plan).toBe("1. write test 2. fix");
    expect(approved.plan_deadline).toBeNull();
    expect(approved.plan_approved_at).toBeGreaterThan(0);
    // lease dies; task requeues; another agent claims — plan rides along
    await db.prepare("UPDATE tasks SET lease_expires_at = ? WHERE id = ?").run(Date.now() - LEASE_RECOVERY_GRACE_MS - 1, id);
    const brief = await q.claimNext("demo", "agent-2", DEFAULT_LEASE_TTL_MS);
    expect(brief?.id).toBe(id);
    expect(brief?.plan).toBe("1. write test 2. fix");
  });

  it("a PLANNED task is not swept by the plan window (approval cleared it)", async () => {
    const { q } = await makeQueue();
    const id = await q.submit("demo", "dana", { title: "t", body: "b", evidence: [] });
    await q.claimNext("demo", "agent-1", DEFAULT_LEASE_TTL_MS);
    await q.approvePlan(id, "solid plan");
    await q.progress(id, "agent-1", "working", DEFAULT_LEASE_TTL_MS);
    expect(await q.claimNext("demo", "agent-2", DEFAULT_LEASE_TTL_MS)).toBeNull();
    expect((await q.brief(id)).state).toBe("EXECUTING");
  });
});
