import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AttentionAlertService } from "../src/attention-alerts.js";
import { listHumanAttention } from "../src/human-attention.js";
import type { Db } from "../src/db.js";
import { openTestDb } from "./helpers/db.js";

describe("canonical human attention", () => {
  let db: Db;
  const base = 2_000_000_000_000;

  beforeEach(async () => {
    db = await openTestDb();
    await db.prepare(`INSERT INTO projects (id, name, repo) VALUES ('demo', 'Demo', 'recallnet/demo')`).run();
  });

  afterEach(async () => {
    await db.close();
  });

  async function queuedTask(id: number, updatedAt: number) {
    await db
      .prepare(
        `INSERT INTO tasks
           (id, project_id, title, body, state, submitted_by, queued_at, queue_generation, created_at, updated_at)
         VALUES (?, 'demo', ?, 'body', 'QUEUED', 'dana', ?, 1, ?, ?)`,
      )
      .run(id, `Task ${id}`, updatedAt, updatedAt, updatedAt);
  }

  it("surfaces open questions without queue_alert aging episodes", async () => {
    await queuedTask(1, base - 900_000);
    await db
      .prepare(
        `INSERT INTO questions (project_id, task_id, asked_by, question, status, created_at)
         VALUES ('demo', 1, 'coder-a', 'Need a human decision on scope?', 'open', ?)`,
      )
      .run(base);

    const items = await listHumanAttention(db, new AttentionAlertService(db, "https://app.example/dashboard"), {
      projectIds: ["demo"],
      projectNames: new Map([["demo", "Demo"]]),
      publicUrl: "https://app.example/dashboard",
      now: base,
      includeLeases: false,
    });

    // Aging QUEUED tasks must not appear as Needs-You queue_alert rows.
    expect(items.every((item) => item.kind !== "queue_alert")).toBe(true);
    expect(items.map((item) => item.episode_id)).toEqual(["question:1"]);
    expect(items.every((item) => item.pushable)).toBe(true);
    const question = items.find((item) => item.kind === "question" || item.kind === "blocked")!;
    expect(question.dashboard_url).toContain("project=demo");
    expect(question.dashboard_url).toContain("question=1");
  });

  it("never emits queue_alert even when AttentionAlertService would flag aging tasks", async () => {
    await queuedTask(11, base - 3_600_000);
    await queuedTask(12, base - 3_600_000);
    const service = new AttentionAlertService(db, "https://app.example/dashboard");
    const raw = await service.evaluate(["demo"], base);
    expect(raw.length).toBeGreaterThan(0);
    const items = await listHumanAttention(db, service, {
      projectIds: ["demo"],
      now: base,
      includeLeases: false,
      includeBlocked: false,
    });
    expect(items.filter((item) => item.kind === "queue_alert")).toEqual([]);
  });

  it("includes open conflict conversations awaiting the member", async () => {
    const thread = await db
      .prepare(
        "INSERT INTO threads (project_id, kind, task_id, root_id, created_at, summary) VALUES ('demo', 'discuss', NULL, NULL, ?, 'topic') RETURNING id",
      )
      .get<{ id: number }>(base);
    const conv = await db
      .prepare(
        `INSERT INTO conversations (project_id, thread_id, topic, state, deadline, created_at)
         VALUES ('demo', ?, 'Merge or split?', 'OPEN', ?, ?) RETURNING id`,
      )
      .get<{ id: number }>(thread!.id, base + 86_400_000, base);
    await db
      .prepare("INSERT INTO conversation_participants (conversation_id, member, replied_at) VALUES (?, 'dana', NULL)")
      .run(conv!.id);

    const items = await listHumanAttention(db, new AttentionAlertService(db), {
      projectIds: ["demo"],
      memberName: "dana",
      now: base,
      includeLeases: false,
      includeBlocked: false,
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      episode_id: `conversation:${conv!.id}`,
      kind: "conversation",
      pushable: true,
    });
  });

  it("marks expiring leases as non-pushable dashboard attention", async () => {
    await db
      .prepare(
        `INSERT INTO tasks
           (id, project_id, title, body, state, submitted_by, lease_agent, lease_expires_at, created_at, updated_at)
         VALUES (9, 'demo', 'Live', 'body', 'EXECUTING', 'dana', 'coder-a', ?, ?, ?)`,
      )
      .run(base + 60_000, base, base);

    const items = await listHumanAttention(db, new AttentionAlertService(db), {
      projectIds: ["demo"],
      now: base,
      includeLeases: true,
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "lease", pushable: false, episode_id: `lease:9:${base + 60_000}` });
  });

  it("ranks blocked and questions ahead of leases even when the lease has a lower task id", async () => {
    await db
      .prepare(
        `INSERT INTO tasks
           (id, project_id, title, body, state, submitted_by, lease_agent, lease_expires_at, created_at, updated_at)
         VALUES (1, 'demo', 'Leased', 'body', 'EXECUTING', 'dana', 'coder-a', ?, ?, ?)`,
      )
      .run(base + 60_000, base, base);
    await db
      .prepare(
        `INSERT INTO tasks
           (id, project_id, title, body, state, submitted_by, block_kind, created_at, updated_at)
         VALUES (3, 'demo', 'Blocked', 'body', 'BLOCKED', 'dana', 'human', ?, ?)`,
      )
      .run(base, base);
    await db
      .prepare(
        `INSERT INTO attempts (task_id, agent, outcome, notes, created_at)
         VALUES (3, 'coder-b', 'blocked', 'needs a human decision', ?)`,
      )
      .run(base);

    const items = await listHumanAttention(db, new AttentionAlertService(db), {
      projectIds: ["demo"],
      now: base,
      includeLeases: true,
      includeBlocked: true,
    });

    expect(items.map((item) => `${item.task_id}:${item.kind}`)).toEqual(["3:blocked", "1:lease"]);
  });

  it("surfaces BLOCKED-without-question as kind blocked and open conflicts as kind conversation", async () => {
    await db
      .prepare(
        `INSERT INTO tasks
           (id, project_id, title, body, state, submitted_by, block_kind, created_at, updated_at)
         VALUES (5, 'demo', 'Stranded', 'body', 'BLOCKED', 'dana', 'human', ?, ?)`,
      )
      .run(base, base);
    await db
      .prepare(
        `INSERT INTO attempts (task_id, agent, outcome, notes, created_at)
         VALUES (5, 'coder-b', 'blocked', 'infra is down', ?)`,
      )
      .run(base);
    const thread = await db
      .prepare(
        "INSERT INTO threads (project_id, kind, task_id, root_id, created_at, summary) VALUES ('demo', 'discuss', NULL, NULL, ?, 'topic') RETURNING id",
      )
      .get<{ id: number }>(base);
    const conv = await db
      .prepare(
        `INSERT INTO conversations (project_id, thread_id, topic, state, deadline, created_at)
         VALUES ('demo', ?, 'Merge or split?', 'OPEN', ?, ?) RETURNING id`,
      )
      .get<{ id: number }>(thread!.id, base + 86_400_000, base);
    await db
      .prepare("INSERT INTO conversation_participants (conversation_id, member, replied_at) VALUES (?, 'dana', NULL)")
      .run(conv!.id);

    const items = await listHumanAttention(db, new AttentionAlertService(db), {
      projectIds: ["demo"],
      memberName: "dana",
      now: base,
      includeLeases: false,
      includeBlocked: true,
    });

    expect(items.map((item) => item.kind).sort()).toEqual(["blocked", "conversation"]);
    expect(items.find((item) => item.kind === "blocked")).toMatchObject({
      episode_id: "blocked:5",
      task_id: 5,
      pushable: true,
    });
    expect(items.find((item) => item.kind === "conversation")).toMatchObject({
      episode_id: `conversation:${conv!.id}`,
      pushable: true,
    });
    // Human-facing reason is KIND-based, never the raw attempt note.
    expect(items.find((item) => item.kind === "blocked")?.reason).toBe(
      "This task needs a decision from you.",
    );
    expect(items.find((item) => item.kind === "blocked")?.reason).not.toContain("infra is down");
  });

  it("excludes infra_failure and dependency blocks and never leaks raw attempt notes", async () => {
    await db
      .prepare(
        `INSERT INTO tasks
           (id, project_id, title, body, state, submitted_by, block_kind, created_at, updated_at)
         VALUES
           (10, 'demo', 'Infra stuck', 'body', 'BLOCKED', 'dana', 'infra_failure', ?, ?),
           (11, 'demo', 'Dep stuck', 'body', 'BLOCKED', 'dana', 'dependency', ?, ?),
           (12, 'demo', 'Human decide', 'body', 'BLOCKED', 'dana', 'human', ?, ?)`,
      )
      .run(base, base, base, base, base, base);
    await db
      .prepare(
        `INSERT INTO attempts (task_id, agent, outcome, notes, created_at) VALUES
           (10, 'coder-a', 'blocked', 'set MEMRACER_GITHUB_TOKEN or authenticate gh on the host — completion refused', ?),
           (11, 'coder-a', 'blocked', 'waiting on task 9 /src/internal/path.ts', ?),
           (12, 'coder-a', 'blocked', 'set MEMRACER_GITHUB_TOKEN secretly', ?)`,
      )
      .run(base, base, base);

    const items = await listHumanAttention(db, new AttentionAlertService(db), {
      projectIds: ["demo"],
      now: base,
      includeLeases: false,
      includeBlocked: true,
    });

    expect(items.map((item) => item.task_id).sort()).toEqual([12]);
    const human = items.find((item) => item.task_id === 12)!;
    expect(human.reason).toBe("This task needs a decision from you.");
    expect(human.reason).not.toMatch(/MEMRACER|TOKEN|authenticate|gh|path\.ts/i);
    expect(JSON.stringify(items)).not.toMatch(/MEMRACER_GITHUB_TOKEN|authenticate gh|path\.ts/);
  });

  it("with-question path does not badge system-domain blocks as human BLOCKED", async () => {
    await db
      .prepare(
        `INSERT INTO tasks
           (id, project_id, title, body, state, submitted_by, block_kind, created_at, updated_at)
         VALUES
           (20, 'demo', 'Infra+Q', 'body', 'BLOCKED', 'dana', 'infra_failure', ?, ?),
           (21, 'demo', 'Human+Q', 'body', 'BLOCKED', 'dana', 'human', ?, ?)`,
      )
      .run(base, base, base, base);
    await db
      .prepare(
        `INSERT INTO questions (id, project_id, task_id, asked_by, question, status, created_at)
         VALUES
           (1, 'demo', 20, 'mediator', 'Which region should host it?', 'open', ?),
           (2, 'demo', 21, 'mediator', 'Ship v1 or wait?', 'open', ?)`,
      )
      .run(base, base);
    await db
      .prepare(
        `INSERT INTO attempts (task_id, agent, outcome, notes, created_at) VALUES
           (20, 'coder-a', 'blocked', 'set MEMRACER_GITHUB_TOKEN on the host', ?)`,
      )
      .run(base);

    const items = await listHumanAttention(db, new AttentionAlertService(db), {
      projectIds: ["demo"],
      now: base,
      includeLeases: false,
      includeBlocked: true,
    });

    const infraQ = items.find((item) => item.task_id === 20);
    const humanQ = items.find((item) => item.task_id === 21);
    // Open question still surfaces, but not as human-actionable BLOCKED.
    expect(infraQ).toMatchObject({ kind: "question", badge: "QUESTION" });
    expect(infraQ?.reason).not.toMatch(/MEMRACER|TOKEN/i);
    expect(humanQ).toMatchObject({ kind: "blocked", badge: "BLOCKED" });
    expect(JSON.stringify(items)).not.toMatch(/MEMRACER_GITHUB_TOKEN/);
  });
});
