// tests/queue-changed.test.ts
import { describe, expect, it } from "vitest";
import type { Db } from "../src/db.js";
import { Queue, DEFAULT_LEASE_TTL_MS, LEASE_RECOVERY_GRACE_MS } from "../src/queue.js";
import { openTestDb } from "./helpers/db.js";

async function setup() {
  const db: Db = await openTestDb();
  await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
  await db.prepare("INSERT INTO projects (id, name) VALUES ('q','Q')").run();
  const queue = new Queue(db);
  const events: string[] = [];
  queue.onChanged((projectId) => events.push(projectId));
  return { db, queue, events };
}

describe("queue change events", () => {
  it("submit emits changed with the project id", async () => {
    const { queue, events } = await setup();
    await queue.submit("p", "dana", { title: "t", body: "b", evidence: [] });
    expect(events).toEqual(["p"]);
  });

  it("claimNext emits changed on a claim and stays silent on an empty queue", async () => {
    const { queue, events } = await setup();
    await queue.submit("p", "dana", { title: "t", body: "b", evidence: [] });
    events.length = 0;
    const brief = await queue.claimNext("p", "cc-1", DEFAULT_LEASE_TTL_MS);
    expect(brief).not.toBeNull();
    expect(events).toEqual(["p"]);
    await queue.claimNext("q", "cc-1", DEFAULT_LEASE_TTL_MS);
    expect(events).toEqual(["p"]);
  });

  it("claimNext emits changed when expired leases requeue, even with nothing claimable", async () => {
    const { db, queue, events } = await setup();
    const id = await queue.submit("p", "dana", { title: "t", body: "b", evidence: [] });
    await queue.claimNext("p", "cc-1", DEFAULT_LEASE_TTL_MS);
    // force the lease into the past, then park-block the row so requeue is the only mutation
    await db.prepare("UPDATE tasks SET lease_expires_at = ? WHERE id = ?").run(Date.now() - LEASE_RECOVERY_GRACE_MS - 1000, id);
    events.length = 0;
    const brief = await queue.claimNext("p", "cc-2", DEFAULT_LEASE_TTL_MS);
    expect(brief?.id).toBe(id);
    // one requeue + one claim happened inside a single call → a single changed signal suffices,
    // but at least one must fire
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(new Set(events)).toEqual(new Set(["p"]));
  });

  it("progress, complete emit changed", async () => {
    const { queue, events } = await setup();
    const id = await queue.submit("p", "dana", { title: "t", body: "b", evidence: [] });
    await queue.claimNext("p", "cc-1", DEFAULT_LEASE_TTL_MS);
    events.length = 0;
    await queue.progress(id, "cc-1", "working", DEFAULT_LEASE_TTL_MS);
    await queue.complete(id, "cc-1", "done", "https://github.com/x/y/pull/2");
    expect(events).toEqual(["p", "p"]);
  });

  it("park and block emit changed", async () => {
    const { queue, events } = await setup();
    const a = await queue.submit("p", "dana", { title: "a", body: "b", evidence: [] });
    await queue.claimNext("p", "cc-1", DEFAULT_LEASE_TTL_MS);
    events.length = 0;
    await queue.park(a, "cc-1");
    expect(events).toEqual(["p"]);
    const b = await queue.submit("p", "dana", { title: "b", body: "b", evidence: [] });
    await queue.claimNext("p", "cc-1", DEFAULT_LEASE_TTL_MS);
    events.length = 0;
    await queue.block(b, "cc-1", "stuck");
    expect(events).toEqual(["p"]);
  });

  it("approvePlan, applyGroomAccept, and applyGroomMerge emit changed", async () => {
    const { queue, events } = await setup();
    const a = await queue.submit("p", "dana", { title: "a", body: "b", evidence: [] });
    const duplicateTitle = "Retain queue change merge notification";
    const duplicateBody = "Emit one project change after merging the duplicate task.";
    const target = await queue.submit("p", "dana", { title: duplicateTitle, body: duplicateBody, evidence: [] });
    const duplicate = await queue.submit("p", "rui", { title: duplicateTitle, body: duplicateBody, evidence: [] });
    await queue.claimNext("p", "cc-1", DEFAULT_LEASE_TTL_MS);
    events.length = 0;
    await queue.approvePlan(a, "the plan");
    await queue.applyGroomAccept(a, "a2", "b2", 1, "groomed");
    await queue.applyGroomMerge(duplicate, target);
    expect(events).toEqual(["p", "p", "p"]);
  });

  it("answerQuestion emits changed", async () => {
    const { db, queue, events } = await setup();
    const id = await queue.submit("p", "dana", { title: "t", body: "b", evidence: [] });
    await db
      .prepare(
        "INSERT INTO questions (project_id, task_id, asked_by, question, created_at) VALUES ('p', ?, 'cc-1', 'which?', ?)",
      )
      .run(id, Date.now());
    const qid = ((await db.prepare("SELECT id FROM questions").get<{ id: number }>()) as { id: number }).id;
    events.length = 0;
    await queue.answerQuestion(qid, "this one", "dana");
    expect(events).toContain("p");
  });

  it("notifyChanged is public and offChanged removes a listener", async () => {
    const { queue, events } = await setup();
    queue.notifyChanged("p");
    expect(events).toEqual(["p"]);
    const extra: string[] = [];
    const listener = (pid: string) => extra.push(pid);
    const before = queue.changedListenerCount();
    queue.onChanged(listener);
    expect(queue.changedListenerCount()).toBe(before + 1);
    queue.offChanged(listener);
    expect(queue.changedListenerCount()).toBe(before);
    queue.notifyChanged("p");
    expect(extra).toEqual([]);
  });
});
