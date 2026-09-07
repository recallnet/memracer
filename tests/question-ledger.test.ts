import { describe, expect, it } from "vitest";
import { MemoryStore } from "../src/mediator/memory.js";
import {
  QUESTION_LEDGER_PATH,
  QuestionLedger,
} from "../src/mediator/question-ledger.js";
import { openTestDb } from "./helpers/db.js";

async function setup() {
  const db = await openTestDb();
  await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
  return { db, ledger: new QuestionLedger(db), memory: new MemoryStore(db) };
}

describe("QuestionLedger", () => {
  it("allows a due domain refresh to re-confirm an answered subject while keeping one open question per domain", async () => {
    const { db, ledger } = await setup();
    const input = { question: "Is the dashboard still the primary user surface?", domain: "product-bounds", trigger: "TIME" } as const;
    const [id] = await ledger.add("p", null, "mediator", input);
    await db.prepare("UPDATE questions SET status='answered', answer='yes' WHERE id=?").run(id);
    const [next] = await ledger.add("p", null, "mediator", input);
    expect(next).not.toBe(id);
    expect(await ledger.add("p", null, "mediator", {
      question: "Should another product-boundary question be asked?",
      domain: "product-bounds",
      trigger: "STALENESS",
    })).toEqual([next]);
  });

  it("deduplicates project unknowns and preserves answered rows outside the open projection", async () => {
    const { db, ledger, memory } = await setup();
    const [id] = await ledger.add("p", null, "mediator", "Which market matters first?");
    expect(await ledger.add("p", null, "mediator", "Which market matters first?")).toEqual([id]);
    await db.prepare("UPDATE questions SET status='answered', answer='Developers' WHERE id=?").run(id);
    await ledger.sync("p");
    const doc = await memory.get("p", QUESTION_LEDGER_PATH);
    expect(doc).toBeNull();
    expect(
      await db
        .prepare("SELECT status, answer FROM questions WHERE id=?")
        .get(id),
    ).toEqual({ status: "answered", answer: "Developers" });
  });

  it("deduplicates paraphrased open subjects without collapsing nearby questions", async () => {
    const { db, ledger } = await setup();
    const [id] = await ledger.add("p", null, "mediator", "Which market matters first?");
    expect(await ledger.add("p", null, "mediator", "What market should we prioritize first?")).toEqual([id]);
    expect(await ledger.add("p", null, "mediator", "Which platform matters first?")).toHaveLength(1);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM questions").get()).toEqual({ n: 2 });
  });

  it("does not reopen answered subjects or insert resolution narration", async () => {
    const { db, ledger } = await setup();
    const [id] = await ledger.add("p", null, "mediator", "Which market matters first?");
    await db.prepare("UPDATE questions SET status='answered', answer='Developers' WHERE id=?").run(id);
    expect(await ledger.add("p", null, "mediator", "What market should we prioritize first?")).toEqual([]);
    expect(await ledger.add("p", null, "mediator", "Resolved: developers are the first market.")).toEqual([]);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM questions").get()).toEqual({ n: 1 });
  });

  it("retains a coder's explicit human-escalation request without punctuation", async () => {
    const { db, ledger } = await setup();
    const task = await db.prepare(
      "INSERT INTO tasks (project_id, title, body, submitted_by, created_at, updated_at) VALUES ('p','blocked','b','dana',1,1) RETURNING id",
    ).get<{ id: number }>();
    expect(await ledger.add("p", task!.id, "cc-1", "please escalate this to the humans")).toHaveLength(1);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM questions").get()).toEqual({ n: 1 });
  });

  it("does not ask a task question whose subject is already decided", async () => {
    const { db, ledger } = await setup();
    const task = await db.prepare(
      "INSERT INTO tasks (project_id, title, body, submitted_by, created_at, updated_at) VALUES ('p','surface order','b','dana',1,1) RETURNING id",
    ).get<{ id: number }>();
    await db.prepare(
      "INSERT INTO decision_log (project_id, task_id, kind, summary, rationale, created_at) VALUES ('p', ?, 'update', 'Phase 2 dependency order', 'Phase 2 precedes Phase 3.', 1)",
    ).run(task!.id);
    expect(await ledger.add("p", task!.id, "mediator", "What is the Phase 2 dependency order?")).toEqual([]);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM questions").get()).toEqual({ n: 0 });
  });

  it("projects only open questions when answered and open rows coexist", async () => {
    const { db, ledger, memory } = await setup();
    const [answeredId] = await ledger.add("p", null, "mediator", "Which market matters first?");
    const [openId] = await ledger.add("p", null, "mediator", "Which platform matters next?");
    await db
      .prepare("UPDATE questions SET status='answered', answer='Developers' WHERE id=?")
      .run(answeredId);
    await ledger.sync("p");

    const doc = await memory.get("p", QUESTION_LEDGER_PATH);
    expect(doc?.body).toContain(`[open] Q${openId}`);
    expect(doc?.body).toContain("Which platform matters next?");
    expect(doc?.body).not.toContain(`[answered] Q${answeredId}`);
    expect(doc?.body).not.toContain("Which market matters first?");
    expect(doc?.body).not.toContain("Answer: Developers");
    expect(await db.prepare("SELECT COUNT(*) AS n FROM questions").get()).toEqual({ n: 2 });
  });
});
