import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db.js";
import { NegotiationStore } from "../src/negotiation.js";
import { openTestDb } from "./helpers/db.js";

/** Reconnect/resume (focused area #4). */
describe("negotiation resume after detach", () => {
  let db: Db;

  beforeEach(async () => {
    db = await openTestDb();
    await db.prepare(`INSERT INTO projects (id, name, repo) VALUES ('p', 'P', 'r/p')`).run();
    await db
      .prepare(
        `INSERT INTO tasks (id, project_id, title, body, state, submitted_by, created_at, updated_at)
         VALUES (3, 'p', 't', 'b', 'INCUBATING', 'andrew', 1, 1)`,
      )
      .run();
  });

  afterEach(async () => {
    await db.close();
  });

  it("re-attach by identity returns the same negotiation id and current_prompt", async () => {
    const storeA = new NegotiationStore(db, () => 7000);
    const n = await storeA.open({
      projectId: "p",
      subjectKind: "submission",
      subjectTaskId: 3,
      partyIdentity: "andrew",
      partyRole: "human",
    });
    await storeA.ask(n.id, "mediator", "Which market first?");
    // Detach: drop the in-process store; durable row remains.
    const storeB = new NegotiationStore(db, () => 8000);
    const listed = await storeB.listOpenForParty("andrew");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(n.id);
    expect(listed[0]?.current_prompt).toBe("Which market first?");
    const bySubject = await storeB.openForSubject(3);
    expect(bySubject?.id).toBe(n.id);
    await storeB.answer(n.id, "andrew", "US");
    expect((await storeB.get(n.id))?.state).toBe("open");
  });
});
