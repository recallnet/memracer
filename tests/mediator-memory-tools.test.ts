import { describe, expect, it } from "vitest";
import { MemoryStore } from "../src/mediator/memory.js";
import { MemoryTools } from "../src/mediator/memory-tools.js";
import { openTestDb } from "./helpers/db.js";
import type { Db } from "../src/db.js";

/**
 * Two tenants on one backend. Project A gets OKF docs + threads; project B
 * gets its own. The whole point of the tool layer is that A-bound tools can
 * NEVER read or write B — the multi-tenant security boundary.
 */
async function setup() {
  const db = await openTestDb();
  await db.prepare("INSERT INTO projects (id, name) VALUES ('a','A')").run();
  await db.prepare("INSERT INTO projects (id, name) VALUES ('b','B')").run();
  const planA = await db.prepare(
    "INSERT INTO tasks (project_id, title, body, state, submitted_by, plan, created_at, updated_at) VALUES ('a','Retry policy','b','PLANNED','andrew','Use exponential backoff with jitter: SECRET-A-PLAN',1,1) RETURNING id",
  ).get<{ id: number }>();
  const planB = await db.prepare(
    "INSERT INTO tasks (project_id, title, body, state, submitted_by, plan, created_at, updated_at) VALUES ('b','Private policy','b','PLANNED','rui','SECRET-B-PLAN never leaks to A',1,1) RETURNING id",
  ).get<{ id: number }>();
  const store = new MemoryStore(db);

  await store.upsert("a", {
    path: "learnings/queue-races.md",
    type: "Learning",
    title: "Queue lease races",
    description: "Two coders raced on the same lease",
    tags: ["queue", "lease"],
    body: "Task 12 and 14 both claimed the lease. See thread SECRET-A-BODY.",
  });
  await store.upsert("b", {
    path: "learnings/b-only.md",
    type: "Learning",
    title: "B private learning",
    description: "Only project B should ever see this",
    tags: ["b"],
    body: "SECRET-B-BODY never leaks to A.",
  });

  const threadA = await seedThread(db, "a", "review", "coder", "andrew", "plan for A: SECRET-A-THREAD");
  const threadB = await seedThread(db, "b", "answer", "coder", "rui", "question for B: SECRET-B-THREAD");

  return { db, store, tools: new MemoryTools(db), threadA, threadB, planA: planA!.id, planB: planB!.id };
}

async function seedThread(
  db: Db,
  projectId: string,
  kind: string,
  role: string,
  author: string,
  content: string,
): Promise<number> {
  const now = Date.now();
  const t = await db
    .prepare("INSERT INTO threads (project_id, kind, created_at) VALUES (?, ?, ?) RETURNING id")
    .get<{ id: number }>(projectId, kind, now);
  await db
    .prepare("INSERT INTO thread_messages (thread_id, role, author, content, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(t!.id, role, author, content, now);
  return t!.id;
}

describe("MemoryTools — project-scoped OKF access", () => {
  it("okf_grep only searches the bound project's memory", async () => {
    const { tools } = await setup();
    const a = tools.bind("a");
    const hitA = (await a.dispatch("okf_grep", { query: "SECRET-A-BODY" })) as { matches: unknown[] };
    expect(hitA.matches).toHaveLength(1);
    // A-bound tools cannot find B's private body
    const missB = (await a.dispatch("okf_grep", { query: "SECRET-B-BODY" })) as { matches: unknown[] };
    expect(missB.matches).toHaveLength(0);
  });

  it("okf_read cannot read another project's concept", async () => {
    const { tools } = await setup();
    const a = tools.bind("a");
    const own = (await a.dispatch("okf_read", { path: "learnings/queue-races.md" })) as { content?: string };
    expect(own.content).toContain("Queue lease races");
    // B's path is invisible from A — not found, not the doc
    const foreign = (await a.dispatch("okf_read", { path: "learnings/b-only.md" })) as { error?: string };
    expect(foreign.error).toBeDefined();
    expect(JSON.stringify(foreign)).not.toContain("SECRET-B-BODY");
  });

  it("okf_read opens virtual directory indexes by directory or index path", async () => {
    const { tools, store } = await setup();
    await store.upsert("a", {
      path: "tech/runtime/worker.md",
      type: "Architecture",
      title: "Worker runtime",
      description: "How workers run",
      tags: ["worker"],
      body: "Workers execute durable jobs.",
    });
    const a = tools.bind("a");
    expect(await a.dispatch("okf_read", { path: "tech/" })).toMatchObject({
      path: "tech/index.md",
      content: expect.stringContaining("[runtime](runtime/)"),
    });
    expect(await a.dispatch("okf_read", { path: "tech/runtime/index.md" })).toMatchObject({
      content: expect.stringContaining("[Worker runtime](worker.md)"),
    });
    expect(await a.dispatch("okf_read", { path: "missing/" })).toMatchObject({ error: expect.any(String) });
  });

  it("okf_write and okf_update only mutate the bound project — B stays untouched", async () => {
    const { tools, store } = await setup();
    const a = tools.bind("a");
    await a.dispatch("okf_write", {
      path: "decisions/tooling.md",
      type: "Decision",
      title: "Tooling",
      description: "d",
      tags: ["x"],
      body: "written by A",
    });
    expect((await store.get("a", "decisions/tooling.md"))!.body).toBe("written by A");
    // the write did not appear in B
    expect(await store.get("b", "decisions/tooling.md")).toBeNull();

    await a.dispatch("okf_update", { path: "learnings/queue-races.md", body: "updated by A" });
    expect((await store.get("a", "learnings/queue-races.md"))!.body).toBe("updated by A");
    // updating a path that only exists in B is a not-found for A — B unchanged
    const upd = (await a.dispatch("okf_update", { path: "learnings/b-only.md", body: "hijacked" })) as {
      error?: string;
    };
    expect(upd.error).toBeDefined();
    expect((await store.get("b", "learnings/b-only.md"))!.body).toBe("SECRET-B-BODY never leaks to A.");
  });

  it("records successful writes with server-owned task attribution", async () => {
    const { db, tools } = await setup();
    const task = await db.prepare(
      "INSERT INTO tasks (project_id, title, body, submitted_by, created_at, updated_at) VALUES ('a','Audit knowledge','b','dana',1,1) RETURNING id",
    ).get<{ id: number }>();
    const scoped = tools.bind("a", task!.id);
    await scoped.dispatch("okf_write", {
      path: "decisions/audit.md", type: "Decision", title: "Audit", description: "d", tags: [], body: "body",
    });
    await scoped.dispatch("okf_update", { path: "decisions/audit.md", body: "updated" });
    await scoped.dispatch("okf_update", { path: "decisions/missing.md", body: "not written" });

    expect(await db.prepare("SELECT task_id, entry FROM memory_log ORDER BY id").all()).toEqual([
      { task_id: task!.id, entry: "Wrote knowledge: decisions/audit.md" },
      { task_id: task!.id, entry: "Updated knowledge: decisions/audit.md" },
    ]);
    const read = await scoped.dispatch("okf_read", { path: "decisions/audit.md" }) as {
      revision: number;
      content: string;
    };
    expect(read.revision).toEqual(expect.any(Number));
    expect(read.content).toContain(`source_task: ${task!.id}`);
    expect(read.content).toMatch(/as_of: "\d{4}-\d{2}-\d{2}T/);
  });

  it("rejects duplicate creates instead of overwriting a concept", async () => {
    const { tools, store } = await setup();
    const scoped = tools.bind("a");
    const duplicate = await scoped.dispatch("okf_write", {
      path: "learnings/queue-races.md",
      type: "Learning",
      title: "Replacement",
      description: "must not replace",
      tags: [],
      body: "clobbered",
    });
    expect(duplicate).toMatchObject({ error: expect.stringMatching(/already exists/) });
    expect((await store.get("a", "learnings/queue-races.md"))!.body).toContain("Task 12 and 14");
  });

  it("okf_write returns an error (not a throw) for invalid/reserved paths", async () => {
    const { tools } = await setup();
    const a = tools.bind("a");
    for (const path of ["index.md", "log.md", "tech/index.md", "tech/log.md", "Bad Path.md", "../escape.md"]) {
      const r = (await a.dispatch("okf_write", {
        path,
        type: "Decision",
        title: "t",
        description: "d",
        tags: [],
        body: "b",
      })) as { error?: string };
      expect(r.error, path).toBeDefined();
    }
  });

  it("thread_grep only returns the bound project's threads", async () => {
    const { tools } = await setup();
    const a = tools.bind("a");
    const hitA = (await a.dispatch("thread_grep", { query: "SECRET-A-THREAD" })) as { matches: unknown[] };
    expect(hitA.matches).toHaveLength(1);
    const missB = (await a.dispatch("thread_grep", { query: "SECRET-B-THREAD" })) as { matches: unknown[] };
    expect(missB.matches).toHaveLength(0);
  });

  it("thread_read refuses a thread that belongs to another project", async () => {
    const { tools, threadA, threadB } = await setup();
    const a = tools.bind("a");
    const own = (await a.dispatch("thread_read", { threadId: threadA })) as { messages?: unknown[] };
    expect(own.messages).toHaveLength(1);
    // A asking for B's thread id by number → refused, never the content
    const foreign = (await a.dispatch("thread_read", { threadId: threadB })) as { error?: string };
    expect(foreign.error).toBeDefined();
    expect(JSON.stringify(foreign)).not.toContain("SECRET-B-THREAD");
  });

  it("plan_grep searches only stored plans in the bound project", async () => {
    const { tools, planA } = await setup();
    const a = tools.bind("a");
    const own = (await a.dispatch("plan_grep", { query: "SECRET-A-PLAN" })) as {
      matches: Array<{ task_id: number; snippet: string }>;
    };
    expect(own.matches).toEqual([
      expect.objectContaining({ task_id: planA, snippet: expect.stringContaining("SECRET-A-PLAN") }),
    ]);
    const foreign = (await a.dispatch("plan_grep", { query: "SECRET-B-PLAN" })) as { matches: unknown[] };
    expect(foreign.matches).toEqual([]);
    expect(await a.dispatch("plan_grep", { query: "  " })).toMatchObject({ error: expect.any(String) });
  });

  it("plan_read returns an own-project plan and refuses foreign or invalid ids", async () => {
    const { tools, planA, planB } = await setup();
    const a = tools.bind("a");
    expect([...a.citablePlanIds()]).toEqual([]);
    expect(await a.dispatch("plan_read", { taskId: planA })).toMatchObject({
      task_id: planA,
      title: "Retry policy",
      plan: expect.stringContaining("SECRET-A-PLAN"),
    });
    expect([...a.citablePlanIds()]).toEqual([planA]);
    const foreign = await a.dispatch("plan_read", { taskId: planB });
    expect(foreign).toMatchObject({ error: expect.any(String) });
    expect(JSON.stringify(foreign)).not.toContain("SECRET-B-PLAN");
    expect([...a.citablePlanIds()]).toEqual([planA]);
    expect(await a.dispatch("plan_read", { taskId: "nope" })).toMatchObject({ error: expect.any(String) });
  });

  it("dispatch rejects an unknown tool without throwing", async () => {
    const { tools } = await setup();
    const r = (await tools.bind("a").dispatch("rm_rf", {})) as { error?: string };
    expect(r.error).toMatch(/unknown tool/);
  });

  it("okf_validate reports the generated index and reciprocal graph health", async () => {
    const { tools } = await setup();
    const report = (await tools.bind("a").dispatch("okf_validate", {})) as { ok?: boolean; index_rendered?: boolean; reciprocal_gaps?: unknown[] };
    expect(report.ok).toBe(true);
    expect(report.index_rendered).toBe(true);
    expect(report.reciprocal_gaps).toEqual([]);
  });

  it("toolDefinitions advertises all nine tools in OpenAI function-call shape", async () => {
    const { tools } = await setup();
    const definitions = tools.bind("a").toolDefinitions();
    const names = definitions.map((d) => d.function.name);
    expect(new Set(names)).toEqual(
      new Set(["okf_grep", "okf_read", "okf_write", "okf_update", "okf_validate", "thread_grep", "thread_read", "plan_grep", "plan_read"]),
    );
    expect(definitions.find((item) => item.function.name === "okf_write")?.function.description)
      .toMatch(/create a new OKF concept.*fails when the path already exists/i);
  });
});
