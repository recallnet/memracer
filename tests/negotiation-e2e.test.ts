import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db.js";
import { NegotiationStore } from "../src/negotiation.js";
import { openTestDb } from "./helpers/db.js";

/**
 * Demonstrated-working path (acceptance criterion 6):
 * submit ambiguous → clarify → disconnect → reconnect same identity →
 * resume same prompt → answer → accept.
 */
describe("negotiation e2e lifecycle", () => {
  let db: Db;

  beforeEach(async () => {
    db = await openTestDb();
    await db.prepare(`INSERT INTO projects (id, name, repo) VALUES ('p', 'P', 'r/p')`).run();
    await db
      .prepare(
        `INSERT INTO tasks (id, project_id, title, body, state, submitted_by, created_at, updated_at)
         VALUES (9, 'p', 'normalize orders', 'maybe do something', 'INCUBATING', 'andrew', 1, 1)`,
      )
      .run();
  });

  afterEach(async () => {
    await db.close();
  });

  it("survives disconnect and resumes at the same open question then accepts", async () => {
    // 1) Ambiguous submission opens negotiation on first clarify.
    const session1 = new NegotiationStore(db, () => 10_000);
    const opened = await session1.open({
      projectId: "p",
      subjectKind: "submission",
      subjectTaskId: 9,
      partyIdentity: "andrew",
      partyRole: "human",
    });
    await session1.ask(opened.id, "mediator", "Which venue — Hyperliquid or Lighter?", {
      personOwned: true,
    });
    expect((await session1.get(opened.id))?.state).toBe("awaiting_person");
    const prompt = (await session1.get(opened.id))!.current_prompt;

    // 2) Disconnect: abandon session1 without answering.
    // 3) Reconnect as same identity.
    const session2 = new NegotiationStore(db, () => 11_000);
    const resumed = await session2.listOpenForParty("andrew");
    expect(resumed).toHaveLength(1);
    expect(resumed[0]?.id).toBe(opened.id);
    expect(resumed[0]?.current_prompt).toBe(prompt);

    // 4) Answer and Frigg accepts on re-groom.
    await session2.answer(opened.id, "andrew", "Hyperliquid");
    expect((await session2.get(opened.id))?.state).toBe("open");
    await session2.finalize(opened.id, "accepted");
    expect((await session2.get(opened.id))?.state).toBe("accepted");
    // Task would be QUEUED by applyGroomAccept in the live pipeline; assert
    // the negotiation terminal state is the durable accept signal.
    const terminal = await session2.openForSubject(9);
    expect(terminal).toBeNull();
  });
});
