import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AttentionAlertService } from "../src/attention-alerts.js";
import type { Db } from "../src/db.js";
import { openTestDb } from "./helpers/db.js";

describe("pull-based attention alerts", () => {
  let db: Db;
  const base = 2_000_000_000_000;

  beforeEach(async () => {
    db = await openTestDb();
    await db
      .prepare(
        `INSERT INTO projects (id, name, repo)
         VALUES ('demo', 'Demo', 'recallnet/demo')`,
      )
      .run();
  });

  afterEach(async () => {
    await db.close();
  });

  async function task(id: number, updatedAt: number, state = "QUEUED", lease?: { agent: string; expires: number }) {
    const queued = state === "QUEUED";
    await db
      .prepare(
        `INSERT INTO tasks
           (id, project_id, title, body, state, submitted_by, lease_agent,
            lease_expires_at, queued_at, queue_generation, created_at, updated_at)
         VALUES (?, 'demo', ?, 'body', ?, 'dana', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id, `Task ${id}`, state, lease?.agent ?? null, lease?.expires ?? null,
        queued ? updatedAt : null, queued ? 1 : 0, updatedAt, updatedAt,
      );
  }

  it("uses the configurable grace edge and returns actionable pointers", async () => {
    expect(
      await db.prepare("SELECT attention_grace_ms, attention_cooldown_ms FROM projects WHERE id='demo'")
        .get(),
    ).toEqual({ attention_grace_ms: 900_000, attention_cooldown_ms: 1_800_000 });
    await task(1, base - 900_000);
    await task(2, base - 899_999);
    const alerts = await new AttentionAlertService(db, "https://memracer.example/dashboard").evaluate(["demo"], base);

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      episode_id: "1:1",
      project: "demo",
      project_name: "Demo",
      task_id: 1,
      task_title: "Task 1",
      queued_age_ms: 900_000,
      queued_age: "15m",
      task_uri: "task://1",
    });
    expect(alerts[0].reason).toMatch(/remained queued.*no coder currently holds a live lease/i);
    expect(alerts[0].recovery).toContain("coder_check_work");
    expect(alerts[0].recovery).toContain("coder_claim_task");
    expect(alerts[0].dashboard_url).toBe("https://memracer.example/dashboard?project=demo&task=1");
  });

  it("suppresses the whole project while any unexpired active lease exists", async () => {
    await task(1, base - 2_000_000);
    await task(2, base - 1000, "EXECUTING", { agent: "coder-a", expires: base + 1 });
    const service = new AttentionAlertService(db);

    expect(await service.evaluate(["demo"], base)).toEqual([]);
    await db.prepare("UPDATE tasks SET lease_expires_at = ? WHERE id = 2").run(base);
    expect(await service.evaluate(["demo"], base)).toHaveLength(1);
  });

  it("keeps one stable durable episode across repeated status pulls", async () => {
    await task(1, base - 2_000_000);
    const service = new AttentionAlertService(db);

    const first = await service.evaluate(["demo"], base);
    const second = await service.evaluate(["demo"], base + 60_000);
    expect(second.map((alert) => alert.episode_id)).toEqual(first.map((alert) => alert.episode_id));
    expect((await db.prepare("SELECT COUNT(*) AS n FROM attention_alerts").get<{ n: number }>())!.n).toBe(1);
  });

  it("serializes concurrent pulls into one task episode", async () => {
    await task(1, base - 2_000_000);
    const service = new AttentionAlertService(db);
    const results = await Promise.all([
      service.evaluate(["demo"], base),
      service.evaluate(["demo"], base),
      service.evaluate(["demo"], base),
    ]);
    expect(results.flat().map((alert) => alert.episode_id)).toEqual(["1:1", "1:1", "1:1"]);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM attention_alerts").get<{ n: number }>())!.n).toBe(1);
  });

  it("resolves on project activity and re-alerts only after cooldown", async () => {
    await task(1, base - 2_000_000);
    const service = new AttentionAlertService(db);
    expect((await service.evaluate(["demo"], base))[0].episode_id).toBe("1:1");

    await task(2, base, "CLAIMED", { agent: "coder-a", expires: base + 10_000 });
    expect(await service.evaluate(["demo"], base + 1)).toEqual([]);
    await db.prepare("UPDATE tasks SET state='DONE', lease_agent=NULL, lease_expires_at=NULL WHERE id=2").run();

    expect(await service.evaluate(["demo"], base + 1_800_000)).toEqual([]);
    expect((await service.evaluate(["demo"], base + 1_800_001))[0].episode_id).toBe("1:2");
  });

  it("does not carry an old episode across a claim and requeue between status pulls", async () => {
    await task(1, base - 2_000_000);
    const service = new AttentionAlertService(db);
    const first = await service.evaluate(["demo"], base);
    expect(first[0].episode_id).toBe("1:1");

    // The whole claim episode happens without evaluate() observing CLAIMED.
    // queue_generation is durable evidence even if timestamps collide.
    const requeuedAt = base + 10_000;
    await db
      .prepare("UPDATE tasks SET state='CLAIMED', lease_agent='coder-a', lease_expires_at=?, updated_at=? WHERE id=1")
      .run(requeuedAt + 5_000, requeuedAt - 1);
    await db
      .prepare("UPDATE projects SET last_active_lease_at=?, claim_generation=claim_generation+1 WHERE id='demo'")
      .run(requeuedAt - 1);
    await db
      .prepare("UPDATE tasks SET state='QUEUED', lease_agent=NULL, lease_expires_at=NULL, queued_at=?, queue_generation=queue_generation+1, updated_at=? WHERE id=1")
      .run(requeuedAt, requeuedAt);

    expect(await service.evaluate(["demo"], requeuedAt)).toEqual([]);
    expect(await service.evaluate(["demo"], requeuedAt + 899_999)).toEqual([]);
    expect(await service.evaluate(["demo"], requeuedAt + 1_799_999)).toEqual([]);

    const second = await service.evaluate(["demo"], requeuedAt + 1_800_000);
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({
      episode_id: "1:2",
      queued_age_ms: 1_800_000,
      episode_started_at: requeuedAt,
    });
    expect(
      await db.prepare(
        "SELECT episode, episode_started_at, resolved_at, cooldown_until FROM attention_alerts WHERE task_id=1",
      ).get(),
    ).toEqual({
      episode: 2,
      episode_started_at: requeuedAt,
      resolved_at: null,
      cooldown_until: null,
    });
  });

  it("detects a same-millisecond claim and requeue by generation", async () => {
    await task(1, base - 2_000_000);
    const service = new AttentionAlertService(db);
    expect((await service.evaluate(["demo"], base))[0].episode_id).toBe("1:1");

    await db
      .prepare("UPDATE projects SET last_active_lease_at=?, claim_generation=claim_generation+1 WHERE id='demo'")
      .run(base);
    await db
      .prepare("UPDATE tasks SET state='QUEUED', queued_at=?, queue_generation=queue_generation+1, updated_at=? WHERE id=1")
      .run(base, base);

    expect(await service.evaluate(["demo"], base)).toEqual([]);
    expect((await service.evaluate(["demo"], base + 1_800_000))[0].episode_id).toBe("1:2");
  });

  it("keeps queue age stable across metadata-only updates", async () => {
    await task(1, base - 900_000);
    await db.prepare("UPDATE tasks SET title='Edited', priority=0, updated_at=? WHERE id=1").run(base);

    const alerts = await new AttentionAlertService(db).evaluate(["demo"], base);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ task_title: "Edited", queued_age_ms: 900_000, queued_age: "15m" });
    expect(await db.prepare("SELECT queued_at, queue_generation FROM tasks WHERE id=1").get()).toEqual({
      queued_at: base - 900_000,
      queue_generation: 1,
    });
  });

  it("resolves task A after an unobserved claim/release episode on task B", async () => {
    await task(1, base - 2_000_000);
    await task(2, base);
    const service = new AttentionAlertService(db);
    expect((await service.evaluate(["demo"], base)).map((alert) => alert.episode_id)).toEqual(["1:1"]);

    const activityAt = base + 1_000;
    await db
      .prepare("UPDATE projects SET last_active_lease_at=?, claim_generation=claim_generation+1 WHERE id='demo'")
      .run(activityAt);
    await db
      .prepare("UPDATE tasks SET queued_at=?, queue_generation=queue_generation+1, updated_at=? WHERE id=2")
      .run(activityAt, activityAt);

    expect(await service.evaluate(["demo"], activityAt)).toEqual([]);
    expect(
      await db.prepare("SELECT resolved_at, cooldown_until FROM attention_alerts WHERE task_id=1").get(),
    ).toEqual({ resolved_at: activityAt, cooldown_until: activityAt + 1_800_000 });
    const later = await service.evaluate(["demo"], activityAt + 1_800_000);
    expect(later.find((alert) => alert.task_id === 1)?.episode_id).toBe("1:2");
  });

  it.each(["DONE", "PARKED", "BLOCKED", "INCUBATING"])("resolves when the task becomes %s", async (state) => {
    await task(1, base - 2_000_000);
    const service = new AttentionAlertService(db);
    expect(await service.evaluate(["demo"], base)).toHaveLength(1);
    await db.prepare("UPDATE tasks SET state=? WHERE id=1").run(state);
    expect(await service.evaluate(["demo"], base + 1)).toEqual([]);
    expect(
      (await db.prepare("SELECT resolved_at FROM attention_alerts WHERE task_id=1").get<{ resolved_at: number }>())!
        .resolved_at,
    ).toBe(base + 1);
  });
});
