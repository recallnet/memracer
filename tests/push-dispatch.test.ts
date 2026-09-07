import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db.js";
import {
  deferredPushScopeActive,
  flushProjectAttentionPushes,
  runWithDeferredPushes,
  scheduleProjectAttentionPush,
} from "../src/push-dispatch.js";
import { openTestDb } from "./helpers/db.js";

describe("scheduleProjectAttentionPush", () => {
  let db: Db;

  beforeEach(async () => {
    db = await openTestDb();
    await db.prepare(`INSERT INTO projects (id, name, repo) VALUES ('demo', 'Demo', 'recallnet/demo')`).run();
    await db.prepare(`INSERT INTO projects (id, name, repo) VALUES ('other', 'Other', 'recallnet/other')`).run();
  });

  afterEach(async () => {
    await db.close();
  });

  it("defers mid-transaction work and flushes after commit without aborting later txs", async () => {
    // Mirrors question-ledger.add inside queue.block: schedule while an outer
    // transaction is open. Running push queries on the ambient Postgres tx
    // poisons it; fire-and-forget races the next BEGIN on PGlite.
    await runWithDeferredPushes(db, async () => {
      await db.transaction(async () => {
        await db
          .prepare(
            `INSERT INTO tasks
               (id, project_id, title, body, state, submitted_by, created_at, updated_at)
             VALUES (1, 'demo', 't', 'b', 'QUEUED', 'dana', 1, 1)`,
          )
          .run();
        expect(db.isInTransaction()).toBe(true);
        expect(deferredPushScopeActive()).toBe(true);
        await scheduleProjectAttentionPush(db, "demo");
      });
    });

    await expect(
      db.transaction(async () => {
        const row = await db.prepare("SELECT id FROM tasks WHERE id = 1").get<{ id: number }>();
        expect(row).toEqual({ id: 1 });
        await db.prepare("UPDATE tasks SET title = 'ok' WHERE id = 1").run();
      }),
    ).resolves.toBeUndefined();

    expect(await db.prepare("SELECT title FROM tasks WHERE id = 1").get()).toEqual({ title: "ok" });
  });

  it("runs immediately when not inside a transaction", async () => {
    expect(db.isInTransaction()).toBe(false);
    await expect(scheduleProjectAttentionPush(db, "demo")).resolves.toBeUndefined();
  });

  it("throws mid-transaction without a deferred scope", async () => {
    await expect(
      db.transaction(async () => {
        await scheduleProjectAttentionPush(db, "demo");
      }),
    ).rejects.toThrow(/runWithDeferredPushes/);
  });

  it("drops deferred jobs when the wrapped work throws (no post-rollback fan-out)", async () => {
    const realInTx = db.isInTransaction.bind(db);
    let forceInTx = false;
    db.isInTransaction = () => forceInTx || realInTx();
    await expect(
      runWithDeferredPushes(db, async () => {
        forceInTx = true;
        await scheduleProjectAttentionPush(db, "demo");
        forceInTx = false;
        throw new Error("rollback");
      }),
    ).rejects.toThrow(/rollback/);
    db.isInTransaction = realInTx;
    // Scope is gone; a no-op flush proves nothing was left on a shared bag.
    await expect(flushProjectAttentionPushes(db)).resolves.toBeUndefined();
  });

  it("isolates deferred bags across concurrent ALS scopes (no shared WeakMap drain)", async () => {
    // Avoid concurrent SQLite transactions (global withLock). Mock isInTransaction
    // so both scopes can defer without contending on BEGIN.
    const realInTx = db.isInTransaction.bind(db);
    let forceInTx = false;
    db.isInTransaction = () => forceInTx || realInTx();

    let releaseA!: () => void;
    const holdA = new Promise<void>((r) => {
      releaseA = r;
    });
    const order: string[] = [];

    const reqA = runWithDeferredPushes(db, async () => {
      forceInTx = true;
      await scheduleProjectAttentionPush(db, "demo");
      forceInTx = false;
      order.push("A-deferred");
      await holdA;
      order.push("A-draining");
    });

    // B starts while A still holds its deferred bag undrained.
    await new Promise((r) => setTimeout(r, 5));
    await runWithDeferredPushes(db, async () => {
      forceInTx = true;
      await scheduleProjectAttentionPush(db, "other");
      forceInTx = false;
      order.push("B-deferred");
    });
    order.push("B-done");
    releaseA();
    await reqA;
    order.push("A-done");

    db.isInTransaction = realInTx;

    // B completed fully before A drained — B's flush did not take A's jobs
    // (A would have drained before B-done if bags were shared on the Db).
    expect(order.indexOf("B-done")).toBeLessThan(order.indexOf("A-draining"));
    expect(order).toEqual(["A-deferred", "B-deferred", "B-done", "A-draining", "A-done"]);
    await expect(flushProjectAttentionPushes(db)).resolves.toBeUndefined();
  });
});
