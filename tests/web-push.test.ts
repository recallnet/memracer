import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db.js";
import {
  claimDelivery,
  notifyProjectHumans,
  notifyUserAttention,
  prunePushDeliveryLog,
  revokePushSubscription,
  setWebPushTransportForTests,
  upsertPushSubscription,
  vapidConfigured,
} from "../src/web-push.js";
import type { HumanAttentionItem } from "../src/human-attention.js";
import { openTestDb } from "./helpers/db.js";

const item = (episodeId: string, pushable = true): HumanAttentionItem => ({
  episode_id: episodeId,
  kind: "question",
  project: "demo",
  task_id: 1,
  title: "Need decision",
  reason: "What should we do?",
  recovery: "Answer the question",
  pushable,
  task_uri: "task://1",
  dashboard_url: "https://app.example/dashboard?project=demo&task=1",
});

describe("web push subscriptions and delivery", () => {
  let db: Db;
  const originalPublic = process.env.VAPID_PUBLIC_KEY;
  const originalPrivate = process.env.VAPID_PRIVATE_KEY;

  beforeEach(async () => {
    db = await openTestDb();
    process.env.VAPID_PUBLIC_KEY = "test-public";
    process.env.VAPID_PRIVATE_KEY = "test-private";
    setWebPushTransportForTests(async () => ({ statusCode: 201 }));
  });

  afterEach(async () => {
    setWebPushTransportForTests(null);
    if (originalPublic === undefined) delete process.env.VAPID_PUBLIC_KEY;
    else process.env.VAPID_PUBLIC_KEY = originalPublic;
    if (originalPrivate === undefined) delete process.env.VAPID_PRIVATE_KEY;
    else process.env.VAPID_PRIVATE_KEY = originalPrivate;
    await db.close();
  });

  it("reports configured when both VAPID keys are present", () => {
    expect(vapidConfigured()).toBe(true);
    delete process.env.VAPID_PRIVATE_KEY;
    expect(vapidConfigured()).toBe(false);
  });

  it("dedupes one delivery per endpoint episode", async () => {
    await upsertPushSubscription(db, {
      userId: "user-1",
      endpoint: "https://push.example/1",
      p256dh: "p",
      auth: "a",
    });
    const first = await notifyUserAttention(db, "user-1", item("question:1"));
    const second = await notifyUserAttention(db, "user-1", item("question:1"));
    expect(first.sent).toBe(1);
    expect(second.sent).toBe(0);
    expect(second.skipped).toBe(1);
    expect(await claimDelivery(db, "https://push.example/1", "question:1")).toBe(false);
  });

  it("revokes on 410 and stops future delivery", async () => {
    setWebPushTransportForTests(async () => ({ statusCode: 410 }));
    await upsertPushSubscription(db, {
      userId: "user-1",
      endpoint: "https://push.example/gone",
      p256dh: "p",
      auth: "a",
    });
    const result = await notifyUserAttention(db, "user-1", item("question:2"));
    expect(result.sent).toBe(0);
    const row = await db
      .prepare("SELECT revoked_at FROM push_subscriptions WHERE endpoint = ?")
      .get<{ revoked_at: number | null }>("https://push.example/gone");
    expect(row?.revoked_at).not.toBeNull();
  });

  it("releases the delivery claim after a transient send failure so later schedules retry", async () => {
    let calls = 0;
    setWebPushTransportForTests(async () => {
      calls += 1;
      return calls === 1 ? { statusCode: 503 } : { statusCode: 201 };
    });
    await upsertPushSubscription(db, {
      userId: "user-1",
      endpoint: "https://push.example/retry",
      p256dh: "p",
      auth: "a",
    });
    expect(await notifyUserAttention(db, "user-1", item("question:retry"))).toMatchObject({ sent: 0, skipped: 1 });
    expect(await notifyUserAttention(db, "user-1", item("question:retry"))).toMatchObject({ sent: 1 });
    expect(calls).toBe(2);
  });

  it("skips non-pushable items and revoked subscriptions", async () => {
    await upsertPushSubscription(db, {
      userId: "user-1",
      endpoint: "https://push.example/1",
      p256dh: "p",
      auth: "a",
    });
    await revokePushSubscription(db, "user-1", "https://push.example/1");
    expect(await notifyUserAttention(db, "user-1", item("lease:1", false))).toEqual({
      attempted: 0,
      sent: 0,
      skipped: 0,
    });
    expect(await notifyUserAttention(db, "user-1", item("question:3"))).toEqual({
      attempted: 0,
      sent: 0,
      skipped: 0,
    });
  });

  it("prunePushDeliveryLog removes only rows older than the age bound", async () => {
    const now = 1_000_000;
    await db
      .prepare(
        `INSERT INTO push_delivery_log (endpoint, episode_id, sent_at) VALUES
         ('https://push.example/old', 'e-old', ?),
         ('https://push.example/new', 'e-new', ?)`,
      )
      .run(now - 40 * 24 * 60 * 60 * 1000, now - 1000);
    const removed = await prunePushDeliveryLog(db, 30 * 24 * 60 * 60 * 1000, now);
    expect(removed).toBe(1);
    const rows = await db
      .prepare("SELECT episode_id FROM push_delivery_log ORDER BY episode_id")
      .all<{ episode_id: string }>();
    expect(rows).toEqual([{ episode_id: "e-new" }]);
  });

  it("notifyProjectHumans awaits fan-out so claim-log rows exist before resolve", async () => {
    // better-auth tables only exist after init; openTestDb may be SQLite in-memory.
    const { betterAuthReady, seedMember } = await import("./helpers/auth.js");
    const { openDb } = await import("../src/db.js");
    // seedMember requires SQLite authDatabase(); skip semantics on postgres CI lane.
    if (db.dialect !== "sqlite") return;
    await db.close();
    db = openDb(":memory:");
    await betterAuthReady(db);
    await db.prepare(`INSERT INTO projects (id, name, repo) VALUES ('demo', 'Demo', 'recallnet/demo')`).run();
    const member = await seedMember(db, {
      name: "push-user",
      projectId: "demo",
      role: "human",
    });
    await upsertPushSubscription(db, {
      userId: member.userId,
      endpoint: "https://push.example/await",
      p256dh: "p",
      auth: "a",
    });

    let resolveSend!: () => void;
    const sendGate = new Promise<void>((r) => {
      resolveSend = r;
    });
    let claimVisibleBeforeResolve = false;
    setWebPushTransportForTests(async () => {
      // Claim INSERT happens before transport; hold the send so notifyProjectHumans
      // must wait for the full notifyUserAttention path (including post-send updates).
      const claimed = await db
        .prepare(
          "SELECT 1 AS ok FROM push_delivery_log WHERE endpoint = ? AND episode_id = ?",
        )
        .get<{ ok: number }>("https://push.example/await", "question:await");
      claimVisibleBeforeResolve = claimed?.ok === 1;
      await sendGate;
      return { statusCode: 201 };
    });

    const attention = item("question:await");
    attention.project = "demo";
    let resolved = false;
    const done = notifyProjectHumans(db, "demo", [attention]).then(() => {
      resolved = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(false);
    expect(claimVisibleBeforeResolve).toBe(true);
    resolveSend();
    await done;
    expect(resolved).toBe(true);
    expect(
      await db
        .prepare("SELECT episode_id FROM push_delivery_log WHERE endpoint = ?")
        .get("https://push.example/await"),
    ).toEqual({ episode_id: "question:await" });
  });
});
