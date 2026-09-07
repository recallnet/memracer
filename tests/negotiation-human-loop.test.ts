import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db.js";
import { NegotiationStore } from "../src/negotiation.js";
import { openTestDb } from "./helpers/db.js";

/**
 * Human clarify loop (focused area #2): groom clarify opens a negotiation;
 * answering returns to open so re-groom can accept.
 */
describe("human clarify loop via negotiation store", () => {
  let db: Db;
  let store: NegotiationStore;

  beforeEach(async () => {
    db = await openTestDb();
    store = new NegotiationStore(db, () => 5000);
    await db.prepare(`INSERT INTO projects (id, name, repo) VALUES ('p', 'P', 'r/p')`).run();
    await db
      .prepare(
        `INSERT INTO tasks (id, project_id, title, body, state, submitted_by, created_at, updated_at)
         VALUES (1, 'p', 'ambiguous', 'do the thing maybe', 'INCUBATING', 'dana', 1, 1)`,
      )
      .run();
  });

  afterEach(async () => {
    await db.close();
  });

  it("groom-style clarify opens awaiting_person and answer returns to open for re-groom", async () => {
    const neg = await store.open({
      projectId: "p",
      subjectKind: "submission",
      subjectTaskId: 1,
      partyIdentity: "dana",
      partyRole: "human",
    });
    await store.ask(neg.id, "mediator", "Which venue?", { personOwned: true });
    expect((await store.get(neg.id))?.state).toBe("awaiting_person");
    await store.answer(neg.id, "dana", "Hyperliquid");
    expect((await store.get(neg.id))?.state).toBe("open");
    await store.finalize(neg.id, "accepted");
    expect((await store.get(neg.id))?.state).toBe("accepted");
  });

  it("fast path: no negotiation row when never opened", async () => {
    const open = await store.openForSubject(1);
    expect(open).toBeNull();
  });
});
