import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db.js";
import { NegotiationStore } from "../src/negotiation.js";
import { openTestDb } from "./helpers/db.js";

/** Coder clarify path (focused area #3). */
describe("coder clarify loop via negotiation store", () => {
  let db: Db;
  let store: NegotiationStore;

  beforeEach(async () => {
    db = await openTestDb();
    store = new NegotiationStore(db, () => 6000);
    await db.prepare(`INSERT INTO projects (id, name, repo) VALUES ('p', 'P', 'r/p')`).run();
    await db
      .prepare(
        `INSERT INTO tasks (id, project_id, title, body, state, submitted_by, created_at, updated_at)
         VALUES (2, 'p', 'plan me', 'body', 'CLAIMED', 'dana', 1, 1)`,
      )
      .run();
  });

  afterEach(async () => {
    await db.close();
  });

  it("review-style clarify opens awaiting_party for the coder and accepts after answer", async () => {
    const neg = await store.open({
      projectId: "p",
      subjectKind: "coder_plan",
      subjectTaskId: 2,
      partyIdentity: "coder-a",
      partyRole: "coder",
    });
    await store.ask(neg.id, "mediator", "Which timeout — 30s or 90s?");
    expect((await store.get(neg.id))?.state).toBe("awaiting_party");
    expect((await store.get(neg.id))?.party_role).toBe("coder");
    await store.answer(neg.id, "coder-a", "90s");
    await store.finalize(neg.id, "accepted");
    expect((await store.get(neg.id))?.state).toBe("accepted");
  });
});
