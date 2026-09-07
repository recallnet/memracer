import { describe, expect, it } from "vitest";
import { MemoryStore, validateMemoryDoc } from "../src/mediator/memory.js";
import { QuestionLedger } from "../src/mediator/question-ledger.js";
import { openTestDb } from "./helpers/db.js";

async function setup() {
  const db = await openTestDb();
  await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
  return { db, memory: new MemoryStore(db) };
}

const doc = (over: Partial<Parameters<MemoryStore["upsert"]>[1]> = {}) => ({
  path: "learnings/dup-submissions.md",
  type: "Learning",
  title: "Duplicate submissions",
  description: "Members resubmit the same idea",
  tags: ["queue", "grooming"],
  body: "Tasks 3 and 5 were duplicates.",
  ...over,
});

describe("MemoryStore", () => {
  it("upserts, gets, lists, overwrites on same path", async () => {
    const { memory } = await setup();
    await memory.upsert("p", doc());
    const got = await memory.get("p", "learnings/dup-submissions.md");
    expect(got).toMatchObject({ path: "learnings/dup-submissions.md", type: "Learning", body: "Tasks 3 and 5 were duplicates." });
    await memory.upsert("p", doc({ body: "updated body" }));
    expect((await memory.get("p", "learnings/dup-submissions.md"))!.body).toBe("updated body");
    const list = await memory.list("p");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ path: "learnings/dup-submissions.md", title: "Duplicate submissions" });
    expect(list[0]).not.toHaveProperty("body");
  });

  it("returns null for a missing doc and removes docs", async () => {
    const { memory } = await setup();
    expect(await memory.get("p", "learnings/nope.md")).toBeNull();
    await memory.upsert("p", doc());
    await memory.remove("p", "learnings/dup-submissions.md");
    expect(await memory.get("p", "learnings/dup-submissions.md")).toBeNull();
  });

  it("rejects invalid and reserved paths", async () => {
    const { memory } = await setup();
    for (const path of ["index.md", "log.md", "tech/index.md", "tech/log.md", "Learnings/x.md", "a b.md", "../x.md", "x.txt", "decisions//x.md", "/decisions/x.md"]) {
      await expect(memory.upsert("p", doc({ path })), path).rejects.toThrow();
    }
    // nested kebab-case is fine
    await memory.upsert("p", doc({ path: "decisions/api/rate-limit.md" }));
  });

  it("appendLog records entries in order", async () => {
    const { db, memory } = await setup();
    await memory.appendLog("p", "first");
    await memory.appendLog("p", "second");
    expect(await db.prepare("SELECT entry FROM memory_log ORDER BY id").all()).toEqual([
      { entry: "first" }, { entry: "second" },
    ]);
  });

  it("appendLog attributes an entry to a task when given a taskId, else null", async () => {
    const { db, memory } = await setup();
    await db.prepare("INSERT INTO tasks (project_id, title, body, submitted_by, created_at, updated_at) VALUES ('p','t','b','dana',1,1)").run();
    const { id: taskId } = (await db.prepare("SELECT id FROM tasks WHERE project_id='p'").get<{ id: number }>())!;
    await memory.appendLog("p", "attributed", taskId);
    await memory.appendLog("p", "unattributed");
    expect(await db.prepare("SELECT entry, task_id FROM memory_log ORDER BY id").all()).toEqual([
      { entry: "attributed", task_id: taskId },
      { entry: "unattributed", task_id: null },
    ]);
  });

  it("renders root and per-directory indexes for progressive disclosure", async () => {
    const { memory } = await setup();
    await memory.upsert("p", doc());
    await memory.upsert("p", doc({ path: "decisions/storage/sqlite.md", type: "Decision", title: "SQLite stays", description: "one file db" }));
    const indexes = await memory.renderIndexes("p");
    expect([...indexes.keys()]).toEqual(["index.md", "decisions/index.md", "decisions/storage/index.md", "learnings/index.md"]);
    expect(indexes.get("index.md")).toContain("- [decisions](decisions/) - Browse decisions knowledge.");
    expect(indexes.get("decisions/index.md")).toBe("# Directories\n\n- [storage](storage/) - Browse storage knowledge.\n");
    expect(indexes.get("decisions/storage/index.md")).toBe("# Concepts\n\n- [SQLite stays](sqlite.md) - one file db\n");
    expect(indexes.get("learnings/index.md")).toContain("[Duplicate submissions](dup-submissions.md)");
    expect(indexes.get("index.md")?.startsWith('---\nokf_version: "0.1"\n---\n')).toBe(true);
    expect(indexes.get("decisions/index.md")).not.toMatch(/^---/);
  });

  it("renders mediator-chosen domain folders independently of free-form types", async () => {
    const { memory } = await setup();
    for (const concept of [
      { path: "decisions/positioning.md", type: "Product", title: "Positioning" },
      { path: "tech/event-store.md", type: "Insight", title: "Event store" },
      { path: "conventions/review-order.md", type: "Team Practice", title: "Review order" },
      { path: "risks/lease-loss.md", type: "Operational Risk", title: "Lease loss" },
    ]) {
      await memory.upsert("p", doc({ ...concept, description: `${concept.title} details`, body: `${concept.title} is durable.` }));
    }

    const indexes = await memory.renderIndexes("p");
    expect([...indexes.keys()]).toEqual([
      "index.md", "conventions/index.md", "decisions/index.md", "risks/index.md", "tech/index.md",
    ]);
    expect(indexes.get("index.md")).toContain("[tech](tech/)");
    expect(indexes.get("decisions/index.md")).toContain("[Positioning](positioning.md)");
    expect(indexes.has("architecture/index.md")).toBe(false);
  });

  it("renderConcept composes conformant frontmatter from columns", async () => {
    const { memory } = await setup();
    await memory.upsert("p", doc());
    const rendered = memory.renderConcept((await memory.get("p", "learnings/dup-submissions.md"))!);
    expect(rendered).toMatch(/^---\n/);
    expect(rendered).toContain('type: "Learning"');
    expect(rendered).toContain('title: "Duplicate submissions"');
    expect(rendered).toContain('description: "Members resubmit the same idea"');
    expect(rendered).toContain('tags: ["queue","grooming"]');
    expect(rendered).toMatch(/timestamp: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(rendered).toMatch(/---\n\nTasks 3 and 5 were duplicates\.\n$/);
  });

  it("round-trips optional structural provenance without requiring it", async () => {
    const { db, memory } = await setup();
    expect(validateMemoryDoc(doc())).toEqual({ ok: true });
    expect(validateMemoryDoc(doc({ provenance: { sourceTask: 0 } }))).toMatchObject({ ok: false });
    expect(validateMemoryDoc(doc({ provenance: { asOf: "not-a-date" } }))).toMatchObject({ ok: false });
    const source = await db.prepare(
      "INSERT INTO tasks (project_id, title, body, submitted_by, created_at, updated_at) VALUES ('p','source','body','dana',1,1) RETURNING id",
    ).get<{ id: number }>();
    await memory.upsert("p", doc({
      provenance: {
        sourceTask: source!.id,
        asOf: "2026-07-18T13:00:00.000Z",
        supersedes: ["learnings/old-duplicates.md"],
        supersededBy: ["conventions/dedup.md"],
      },
    }));

    const stored = (await memory.get("p", "learnings/dup-submissions.md"))!;
    expect(stored.provenance).toEqual({
      sourceTask: source!.id,
      asOf: "2026-07-18T13:00:00.000Z",
      supersedes: ["learnings/old-duplicates.md"],
      supersededBy: ["conventions/dedup.md"],
    });
    expect(memory.renderConcept(stored)).toContain([
      `source_task: ${source!.id}`,
      'as_of: "2026-07-18T13:00:00.000Z"',
      'supersedes: ["learnings/old-duplicates.md"]',
      'superseded_by: ["conventions/dedup.md"]',
    ].join("\n"));

    await memory.upsert("p", doc({ path: "notes/no-provenance.md", type: "Note" }));
    expect((await memory.get("p", "notes/no-provenance.md"))!.provenance).toBeUndefined();
  });

  it("compare-and-swap rejects a stale concept revision", async () => {
    const { memory } = await setup();
    await memory.upsert("p", doc());
    const first = (await memory.get("p", "learnings/dup-submissions.md"))!;
    await memory.update("p", { ...first, body: "first update" }, first.updated_at);
    await expect(memory.update("p", { ...first, body: "stale update" }, first.updated_at))
      .rejects.toThrow(/changed concurrently/);
    expect((await memory.get("p", first.path))!.body).toBe("first update");
  });

  it("validates the generated bundle and reports reciprocal-link gaps", async () => {
    const { memory } = await setup();
    await memory.upsert("p", doc({
      path: "decisions/retention.md", type: "Decision", title: "Retention", description: "Retention choice", tags: ["storage"],
      body: "# Context\n\nKeep records.\n\n# Rationale\n\nSee [Architecture](../architecture.md).\n\n# Status\n\nAccepted.\n\n# Consequences\n\nBounded storage.\n\n# Citations",
    }));
    await memory.upsert("p", doc({
      path: "architecture.md", type: "Architecture", title: "Architecture", description: "System shape", tags: ["architecture"],
      body: "# Overview\n\nStorage service.\n\n# Components\n\n# Data flow\n\n# Citations",
    }));

    const report = await memory.validateBundle("p");
    expect(report).toMatchObject({ ok: true, concepts: 2, index_rendered: true, graph_consistent: false });
    expect(report.reciprocal_gaps).toEqual([{ from: "decisions/retention.md", to: "architecture.md" }]);
  });

  it("keeps projects with pre-upgrade nested core-asset backlinks valid", async () => {
    const { memory } = await setup();
    await memory.upsert("p", doc({
      path: "core-assets.md",
      type: "Reference",
      title: "Core assets",
      description: "Standing knowledge routes",
      tags: ["okf", "routing"],
      body: "# Summary\n\nRoute tests through [Test command](conventions/test-command.md).\n\n# Details\n\nStanding assets.\n\n# Citations",
    }));
    await memory.upsert("p", doc({
      path: "conventions/test-command.md",
      type: "Convention",
      title: "Test command",
      description: "How the project runs checks",
      tags: ["testing"],
      // Original seeded bytes treated this path as bundle-root-relative even
      // though the concept is nested. Existing projects retain those rows.
      body: "# Rule\n\nRun the suite.\n\n# Rationale\n\nStable verification.\n\n# Applies to\n\nEvery change.\n\n# Citations\n\n[Core assets](core-assets.md)",
    }));

    expect(await memory.validateBundle("p")).toMatchObject({
      ok: true,
      concepts: 2,
      graph_consistent: true,
      reciprocal_gaps: [],
    });
  });

  it("digest ranks by word overlap, excludes score-0 concepts, caps at 3", async () => {
    const { memory } = await setup();
    await memory.upsert("p", doc({ path: "learnings/queue-races.md", title: "Queue races", description: "lease renewal race", tags: ["queue"], body: "BODY-RACES" }));
    await memory.upsert("p", doc({ path: "decisions/sqlite.md", title: "SQLite stays", description: "single file database", tags: ["storage"], body: "BODY-SQLITE" }));
    await memory.upsert("p", doc({ path: "conventions/naming.md", title: "Branch naming", description: "kebab-case branches", tags: ["git"], body: "BODY-NAMING" }));
    await memory.upsert("p", doc({ path: "risks/lease-expiry.md", title: "Lease expiry", description: "queue lease timeouts", tags: ["queue", "lease"], body: "BODY-LEASE" }));

    const d = await memory.digest("p", "queue lease renewal bug");
    // The progressive root index is always present and points into directories.
    expect(d).toContain('okf_version: "0.1"');
    expect(d).toContain("- [conventions](conventions/) - Browse conventions knowledge.");
    // top matches rendered in full
    expect(d).toContain("BODY-LEASE");
    expect(d).toContain("BODY-RACES");
    // zero-overlap concept bodies excluded even though fewer than 3 matched
    expect(d).not.toContain("BODY-NAMING");
    expect(d).not.toContain("BODY-SQLITE");
  });

  it("digest returns just the index when nothing matches", async () => {
    const { memory } = await setup();
    await memory.upsert("p", doc());
    const d = await memory.digest("p", "zzz qqq");
    expect(d).toContain('okf_version: "0.1"');
    expect(d).not.toContain("Tasks 3 and 5");
  });

  it("digest always carries the project question ledger into mediator context", async () => {
    const { memory } = await setup();
    await memory.upsert("p", doc({
      path: "questions/open-questions.md",
      type: "Reference",
      title: "Open questions ledger",
      description: "Project questions",
      tags: ["questions"],
      body: "The primary users are developers.",
    }));
    const d = await memory.digest("p", "unrelated deployment task");
    expect(d).toContain("The primary users are developers.");
  });

  it("digest pins only open question-ledger rows", async () => {
    const { db, memory } = await setup();
    const ledger = new QuestionLedger(db);
    const [answeredId] = await ledger.add("p", null, "mediator", "Which market matters first?");
    const [openId] = await ledger.add("p", null, "mediator", "Which platform matters next?");
    await db
      .prepare("UPDATE questions SET status='answered', answer='Developers' WHERE id=?")
      .run(answeredId);
    await ledger.sync("p");

    const d = await memory.digest("p", "unrelated deployment task");
    expect(d).toContain(`[open] Q${openId}`);
    expect(d).toContain("Which platform matters next?");
    expect(d).not.toContain(`[answered] Q${answeredId}`);
    expect(d).not.toContain("Which market matters first?");
    expect(d).not.toContain("Answer: Developers");
  });

  it("digest truncates whole concepts under the char cap and notes the cut", async () => {
    const { memory } = await setup();
    const big = "queue ".repeat(1) + "x".repeat(3000);
    await memory.upsert("p", doc({ path: "learnings/a.md", title: "queue a", description: "queue", body: big }));
    await memory.upsert("p", doc({ path: "learnings/b.md", title: "queue b", description: "queue", body: big }));
    await memory.upsert("p", doc({ path: "learnings/c.md", title: "queue c", description: "queue", body: big }));
    const d = await memory.digest("p", "queue", { maxChars: 4000 });
    expect(d.length).toBeLessThanOrEqual(4100);
    // at least one concept made it, whole
    expect(d).toContain("queue a");
    // the cut is noted
    expect(d).toMatch(/…and \d+ more concepts/);
    // no mid-concept truncation: every included body is complete or absent
    const bodies = [...d.matchAll(/x{10,}/g)].map((m) => m[0].length);
    for (const len of bodies) expect(len).toBe(3000);
  });

  it("memory is scoped per project", async () => {
    const { db, memory } = await setup();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('q','Q')").run();
    await memory.upsert("p", doc());
    expect(await memory.list("q")).toEqual([]);
    expect(await memory.get("q", "learnings/dup-submissions.md")).toBeNull();
  });
});
