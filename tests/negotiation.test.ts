import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db.js";
import { NegotiationStore } from "../src/negotiation.js";
import { openTestDb } from "./helpers/db.js";

describe("negotiations table + store", () => {
  let db: Db;

  beforeEach(async () => {
    db = await openTestDb();
    await db.prepare(`INSERT INTO projects (id, name, repo) VALUES ('p', 'P', 'r/p')`).run();
    await db
      .prepare(
        `INSERT INTO tasks (id, project_id, title, body, state, submitted_by, created_at, updated_at)
         VALUES (1, 'p', 't', 'b', 'INCUBATING', 'andrew', 1, 1)`,
      )
      .run();
  });

  afterEach(async () => {
    await db.close();
  });

  it("exists with the negotiation columns", async () => {
    await db
      .prepare(
        `INSERT INTO negotiations
           (id, project_id, subject_kind, subject_task_id, party_identity, party_role, state, created_at, updated_at)
         VALUES ('n1', 'p', 'submission', 1, 'andrew', 'human', 'open', 1, 1)`,
      )
      .run();
    const row = await db
      .prepare("SELECT state, party_identity FROM negotiations WHERE id = 'n1'")
      .get<{ state: string; party_identity: string }>();
    expect(row?.state).toBe("open");
    expect(row?.party_identity).toBe("andrew");
  });

  it("opens, advances a question, records an answer, and finalizes", async () => {
    const store = new NegotiationStore(db, () => 1000);
    const n = await store.open({
      projectId: "p",
      subjectKind: "submission",
      subjectTaskId: 1,
      partyIdentity: "andrew",
      partyRole: "human",
    });
    expect(n.state).toBe("open");

    await store.ask(n.id, "mediator", "Which venue — Hyperliquid or Lighter?");
    let cur = await store.get(n.id);
    expect(cur?.state).toBe("awaiting_party");
    expect(cur?.current_prompt).toMatch(/Which venue/);
    expect(cur?.awaiting_identity).toBe("andrew");

    await store.answer(n.id, "andrew", "Hyperliquid");
    cur = await store.get(n.id);
    expect(cur?.state).toBe("open");
    expect(cur?.current_prompt).toBeNull();
    expect(JSON.parse(cur!.transcript)).toHaveLength(2);

    await store.finalize(n.id, "accepted");
    expect((await store.get(n.id))?.state).toBe("accepted");
  });

  it("escalates a person-owned question to awaiting_person", async () => {
    const store = new NegotiationStore(db, () => 1000);
    const n = await store.open({
      projectId: "p",
      subjectKind: "submission",
      subjectTaskId: 1,
      partyIdentity: "andrew",
      partyRole: "human",
    });
    await store.ask(n.id, "mediator", "Ship v1 or wait for v2 scope?", { personOwned: true });
    const cur = await store.get(n.id);
    expect(cur?.state).toBe("awaiting_person");
    expect(cur?.awaiting_identity).toBe("andrew");
  });

  it("stores a durable question_id link on ask", async () => {
    await db
      .prepare(
        `INSERT INTO questions (id, project_id, task_id, asked_by, question, status, created_at)
         VALUES (42, 'p', 1, 'mediator', 'Which venue?', 'open', 1)`,
      )
      .run();
    const store = new NegotiationStore(db, () => 1000);
    const n = await store.open({
      projectId: "p",
      subjectKind: "submission",
      subjectTaskId: 1,
      partyIdentity: "andrew",
      partyRole: "human",
    });
    await store.ask(n.id, "mediator", "Which venue?", { questionId: 42 });
    const cur = await store.get(n.id);
    expect(cur?.question_id).toBe(42);
    expect(cur?.current_prompt).toBe("Which venue?");
  });

  it("finds the open negotiation for a subject, and refuses a second", async () => {
    const store = new NegotiationStore(db, () => 1000);
    const n = await store.open({
      projectId: "p",
      subjectKind: "submission",
      subjectTaskId: 1,
      partyIdentity: "a",
      partyRole: "human",
    });
    expect((await store.openForSubject(1))?.id).toBe(n.id);
    await expect(
      store.open({
        projectId: "p",
        subjectKind: "submission",
        subjectTaskId: 1,
        partyIdentity: "a",
        partyRole: "human",
      }),
    ).rejects.toThrow(/already has an open negotiation/);
  });

  it("lists open negotiations for a party for reconnect/resume surfaces", async () => {
    const store = new NegotiationStore(db, () => 2000);
    const n = await store.open({
      projectId: "p",
      subjectKind: "submission",
      subjectTaskId: 1,
      partyIdentity: "andrew",
      partyRole: "human",
    });
    await store.ask(n.id, "mediator", "Need a decision?");
    const listed = await store.listOpenForParty("andrew");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(n.id);
    expect(listed[0]?.current_prompt).toMatch(/Need a decision/);
  });

  it("sweepStale cancels non-terminal negotiations older than the cutoff", async () => {
    await db
      .prepare(
        `INSERT INTO tasks (id, project_id, title, body, state, submitted_by, created_at, updated_at)
         VALUES (10, 'p', 'stale', 'b', 'QUEUED', 'a', 1, 1),
                (11, 'p', 'fresh', 'b', 'QUEUED', 'a', 1, 1)`,
      )
      .run();
    let now = 10_000;
    const store = new NegotiationStore(db, () => now);
    const stale = await store.open({
      projectId: "p",
      subjectKind: "submission",
      subjectTaskId: 10,
      partyIdentity: "a",
      partyRole: "human",
    });
    await store.ask(stale.id, "mediator", "Old question?");
    now = 50_000;
    const fresh = await store.open({
      projectId: "p",
      subjectKind: "submission",
      subjectTaskId: 11,
      partyIdentity: "a",
      partyRole: "human",
    });
    await store.ask(fresh.id, "mediator", "New question?");
    // cutoff: updated_at < 50_000 - 30_000 = 20_000 → only stale (10_000) matches
    expect(await store.sweepStale(50_000, 30_000)).toBe(1);
    expect((await store.get(stale.id))?.state).toBe("cancelled");
    expect((await store.get(fresh.id))?.state).toBe("awaiting_party");
  });
});
