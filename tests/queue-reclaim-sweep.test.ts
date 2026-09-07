// tests/queue-reclaim-sweep.test.ts
// The periodic reclaim that makes the project event stream COMPLETE: an expired
// lease or plan window is a time-based transition into claimability that no
// mutation signals on its own. Without this, a coder parked on the SSE stream
// (`memracer wait`) never wakes for a task freed by a crashed coder. This proves
// the sweep requeues those tasks AND emits `changed` — no claimNext required.
import { describe, expect, it } from "vitest";
import type { Db } from "../src/db.js";
import { Queue, DEFAULT_LEASE_TTL_MS, LEASE_RECOVERY_GRACE_MS } from "../src/queue.js";
import { openTestDb } from "./helpers/db.js";

async function setup() {
  const db: Db = await openTestDb();
  await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
  await db.prepare("INSERT INTO projects (id, name) VALUES ('q','Q')").run();
  const queue = new Queue(db);
  const changed: string[] = [];
  queue.onChanged((projectId) => changed.push(projectId));
  return { db, queue, changed };
}

async function stateOf(db: Db, id: number): Promise<string> {
  return (await db.prepare("SELECT state FROM tasks WHERE id = ?").get<{ state: string }>(id))!.state;
}

describe("recoverExpiredLeases (periodic reclaim sweep)", () => {
  it("requeues an expired lease with no claimer and emits changed", async () => {
    const { db, queue, changed } = await setup();
    const id = await queue.submit("p", "dana", { title: "t", body: "b", evidence: [] });
    await queue.claimNext("p", "cc-1", DEFAULT_LEASE_TTL_MS);
    await db
      .prepare("UPDATE tasks SET lease_expires_at = ? WHERE id = ?")
      .run(Date.now() - LEASE_RECOVERY_GRACE_MS - 1000, id);
    changed.length = 0;

    const recovered = await queue.recoverExpiredLeases();

    expect(recovered).toEqual([id]);
    expect(await stateOf(db, id)).toBe("QUEUED");
    expect(changed).toContain("p");
  });

  it("is idempotent — a second pass requeues nothing and stays silent", async () => {
    const { db, queue, changed } = await setup();
    const id = await queue.submit("p", "dana", { title: "t", body: "b", evidence: [] });
    await queue.claimNext("p", "cc-1", DEFAULT_LEASE_TTL_MS);
    await db
      .prepare("UPDATE tasks SET lease_expires_at = ? WHERE id = ?")
      .run(Date.now() - LEASE_RECOVERY_GRACE_MS - 1000, id);
    await queue.recoverExpiredLeases();
    changed.length = 0;

    const again = await queue.recoverExpiredLeases();

    expect(again).toEqual([]);
    expect(changed).toEqual([]);
  });

  it("requeues a task past its plan deadline even while its lease is still live", async () => {
    const { db, queue, changed } = await setup();
    const id = await queue.submit("p", "dana", { title: "t", body: "b", evidence: [] });
    await queue.claimNext("p", "cc-1", DEFAULT_LEASE_TTL_MS);
    // lease still valid, but the plan window has closed
    await db
      .prepare("UPDATE tasks SET lease_expires_at = ?, plan_deadline = ? WHERE id = ?")
      .run(Date.now() + DEFAULT_LEASE_TTL_MS, Date.now() - 1000, id);
    changed.length = 0;

    const recovered = await queue.recoverExpiredLeases();

    expect(recovered).toEqual([id]);
    expect(await stateOf(db, id)).toBe("QUEUED");
    expect(changed).toContain("p");
  });

  it("leaves a live lease untouched and stays silent", async () => {
    const { db, queue, changed } = await setup();
    const id = await queue.submit("p", "dana", { title: "t", body: "b", evidence: [] });
    await queue.claimNext("p", "cc-1", DEFAULT_LEASE_TTL_MS);
    changed.length = 0;

    const recovered = await queue.recoverExpiredLeases();

    expect(recovered).toEqual([]);
    expect(await stateOf(db, id)).toBe("CLAIMED");
    expect(changed).toEqual([]);
  });

  it("recovers across projects and emits changed once per affected project", async () => {
    const { db, queue, changed } = await setup();
    const a = await queue.submit("p", "dana", { title: "a", body: "b", evidence: [] });
    const b = await queue.submit("q", "dana", { title: "b", body: "b", evidence: [] });
    await queue.claimNext("p", "cc-1", DEFAULT_LEASE_TTL_MS);
    await queue.claimNext("q", "cc-2", DEFAULT_LEASE_TTL_MS);
    await db
      .prepare("UPDATE tasks SET lease_expires_at = ? WHERE id IN (?, ?)")
      .run(Date.now() - LEASE_RECOVERY_GRACE_MS - 1000, a, b);
    changed.length = 0;

    const recovered = await queue.recoverExpiredLeases();

    expect(new Set(recovered)).toEqual(new Set([a, b]));
    expect(new Set(changed)).toEqual(new Set(["p", "q"]));
    expect(changed.length).toBe(2);
  });
});
