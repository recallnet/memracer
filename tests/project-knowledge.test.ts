import { describe, expect, it } from "vitest";
import { MemoryStore } from "../src/mediator/memory.js";
import { MediatorWorker } from "../src/mediator/worker.js";
import { Queue } from "../src/queue.js";
import {
  PROJECT_KNOWLEDGE_CHECK_COOLDOWN_MS,
  PROJECT_KNOWLEDGE_DOMAINS,
  PROJECT_KNOWLEDGE_OPEN_QUESTION_STALE_MS,
  PROJECT_KNOWLEDGE_SWEEP_MS,
  ProjectKnowledgeState,
} from "../src/mediator/project-knowledge.js";
import { openTestDb } from "./helpers/db.js";

async function setup() {
  const db = await openTestDb();
  await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
  return { db, state: new ProjectKnowledgeState(db), memory: new MemoryStore(db) };
}

describe("ProjectKnowledgeState", () => {
  it("runs the periodic bare sweep at a once-per-day cadence", () => {
    expect(PROJECT_KNOWLEDGE_SWEEP_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("defines the ten attention domains and offers a blank project without minting questions", async () => {
    const { db, state } = await setup();
    expect(PROJECT_KNOWLEDGE_DOMAINS.map((domain) => domain.id)).toEqual([
      "product-bounds",
      "priorities-roadmap",
      "team-people",
      "roles-collaboration",
      "architecture-tech",
      "constraints-invariants",
      "domain-vocabulary",
      "history-decisions-learnings",
      "operational-external",
      "preferences-felt-experience",
    ]);
    expect(await state.candidates("p", 1_000)).toHaveLength(10);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM questions").get()).toEqual({ n: 0 });
  });

  it("uses one project-wide cooldown so onboarding cannot flood all ten domains", async () => {
    const { state } = await setup();
    const now = 1_000;
    const first = await state.candidates("p", now);
    await state.recordCheck(
      "p",
      first.slice(0, 3).map((candidate) => ({
        domain: candidate.domain,
        event_generation: candidate.event_generation,
      })),
      [],
      now,
    );
    expect(await state.candidates("p", now + 1)).toEqual([]);
    const next = await state.candidates("p", now + PROJECT_KNOWLEDGE_CHECK_COOLDOWN_MS + 1);
    expect(next).toHaveLength(10);
    expect(next.slice(0, 3).map((candidate) => candidate.domain)).toEqual([
      "roles-collaboration",
      "architecture-tech",
      "constraints-invariants",
    ]);
  });

  it("lets explicit events bypass cooldown and preserves a newer event than the job snapshot", async () => {
    const { db, state } = await setup();
    const initial = await state.candidates("p", 1_000);
    await state.recordCheck(
      "p",
      initial.slice(0, 3).map((candidate) => ({ domain: candidate.domain, event_generation: 0 })),
      [],
      1_000,
    );
    await state.markEvent("p", ["architecture-tech"], "repository connected", 1_001);
    const [event] = await state.candidates("p", 1_002);
    expect(event.domain).toBe("architecture-tech");
    expect(event.triggers).toContain("EVENTS");

    await state.markEvent("p", ["architecture-tech"], "new architecture decision", 1_003);
    await state.recordCheck(
      "p",
      [{ domain: event.domain, event_generation: event.event_generation }],
      [],
      1_004,
    );
    expect(await db.prepare(
      "SELECT requested_generation, applied_generation, dirty_reason FROM project_context_domains WHERE project_id='p' AND domain='architecture-tech'",
    ).get()).toEqual({
      requested_generation: 2,
      applied_generation: 1,
      dirty_reason: "repository connected | new architecture decision",
    });
  });

  it("retains both reasons when project events arrive concurrently", async () => {
    const { db, state } = await setup();
    await Promise.all([
      state.markEvent("p", ["architecture-tech"], "repository connected"),
      state.markEvent("p", ["architecture-tech"], "service boundary changed"),
    ]);
    const row = await db.prepare(
      `SELECT requested_generation, dirty_reason FROM project_context_domains
        WHERE project_id='p' AND domain='architecture-tech'`,
    ).get<{ requested_generation: number; dirty_reason: string }>();
    expect(row?.requested_generation).toBe(2);
    expect(row?.dirty_reason).toContain("repository connected");
    expect(row?.dirty_reason).toContain("service boundary changed");
  });

  it("advances freshness only from successful writes carrying explicit domain tags", async () => {
    const { db, memory } = await setup();
    await memory.upsert("p", {
      path: "tech/architecture.md",
      type: "Architecture",
      title: "Architecture",
      description: "Current system shape",
      tags: ["domain:architecture-tech", "domain:constraints-invariants"],
      body: "# Architecture\n\nCurrent.",
    });
    const rows = await db.prepare(
      `SELECT domain, last_refreshed_at, last_checked_at FROM project_context_domains
        WHERE project_id='p' ORDER BY domain`,
    ).all<{ domain: string; last_refreshed_at: number | null; last_checked_at: number | null }>();
    expect(rows.map((row) => row.domain)).toEqual(["architecture-tech", "constraints-invariants"]);
    expect(rows.every((row) => row.last_refreshed_at !== null)).toBe(true);
    expect(rows.every((row) => row.last_checked_at === null)).toBe(true);

    await memory.upsert("p", {
      path: "misc/untagged.md",
      type: "Note",
      title: "Untagged",
      description: "Not freshness evidence",
      tags: ["architecture"],
      body: "# Note\n\nNo domain tag.",
    });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM project_context_domains").get()).toEqual({ n: 2 });
  });

  it("uses event generations to avoid reusing a running older refresh after its final check", async () => {
    const { db, state } = await setup();
    const worker = new MediatorWorker(db, { concurrency: 2, jobTimeoutMs: 2_000 });
    let calls = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let announceStarted!: () => void;
    const started = new Promise<void>((resolve) => { announceStarted = resolve; });
    worker.register("refresh", async () => {
      calls += 1;
      if (calls === 1) {
        announceStarted();
        await firstGate;
      }
      return { ok: true };
    });

    const firstId = await worker.enqueue("p", "refresh", { mode: "refresh" });
    await started;
    const event_generations = await state.markEvent("p", ["architecture-tech"], "event after final check");
    const followupId = await worker.findOrEnqueue("p", "refresh", { mode: "refresh", event_generations });
    expect(followupId).not.toBe(firstId);
    expect((await worker.getJob(firstId)).status).toBe("running");
    releaseFirst();
    expect((await worker.waitForJob(firstId, 2_000)).status).toBe("done");
    expect((await worker.waitForJob(followupId, 2_000)).status).toBe("done");
    expect(calls).toBe(2);
  });

  it("commits an answered domain question and its recoverable dirty generation atomically", async () => {
    const { db } = await setup();
    const queue = new Queue(db);
    const [questionId] = await queue.addQuestions("p", null, "mediator", {
      question: "Is the product boundary still accurate?",
      domain: "product-bounds",
      trigger: "TIME",
    });
    const answered = await queue.answerQuestion(questionId, "Yes, with one new non-goal.", "dana");
    expect(answered.event_generations).toEqual([{ domain: "product-bounds", generation: 1 }]);
    expect(await db.prepare(
      `SELECT q.status, q.answered_at,
              d.requested_generation, d.applied_generation
         FROM questions q JOIN project_context_domains d
           ON d.project_id=q.project_id AND d.domain=q.domain
        WHERE q.id=?`,
    ).get(questionId)).toEqual({
      status: "answered",
      answered_at: expect.any(Number),
      requested_generation: 1,
      applied_generation: 0,
    });
  });

  it("uses a 30-day typed-question staleness trigger but ignores a recent open question", async () => {
    const { db, state } = await setup();
    const now = Date.now();
    await state.ensure("p");
    await db.prepare(
      "UPDATE project_context_domains SET last_refreshed_at=?, last_checked_at=? WHERE project_id='p'",
    ).run(now, now - PROJECT_KNOWLEDGE_CHECK_COOLDOWN_MS - 1);
    const queue = new Queue(db);
    const [questionId] = await queue.addQuestions("p", null, "mediator", {
      question: "Is the current deployment owner still correct?",
      domain: "operational-external",
      trigger: "TIME",
    });
    expect(await state.candidates("p", now)).toEqual([]);
    await db.prepare("UPDATE questions SET created_at=? WHERE id=?")
      .run(now - PROJECT_KNOWLEDGE_OPEN_QUESTION_STALE_MS - 1, questionId);
    const stale = await state.candidates("p", now);
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ domain: "operational-external" });
    expect(stale[0].triggers).toContain("STALENESS");
    expect(stale[0].reasons).toContain(`open question Q${questionId} is older than 30 days`);
  });

  it("names the old concept path in a domain staleness reason", async () => {
    const { db, state } = await setup();
    const now = Date.now();
    await state.ensure("p");
    await db.prepare(
      "UPDATE project_context_domains SET last_refreshed_at=?, last_checked_at=? WHERE project_id='p'",
    ).run(now, now - PROJECT_KNOWLEDGE_CHECK_COOLDOWN_MS - 1);
    const ttl = PROJECT_KNOWLEDGE_DOMAINS.find((domain) => domain.id === "architecture-tech")!.refreshAfterMs;
    await db.prepare(
      `INSERT INTO memory_docs (project_id,path,type,title,description,tags,body,updated_at)
       VALUES ('p','tech/old-map.md','Architecture','Old map','Service topology',?,'# Old',?)`,
    ).run(JSON.stringify(["domain:architecture-tech"]), now - ttl - 1);
    const stale = await state.candidates("p", now);
    expect(stale.find((candidate) => candidate.domain === "architecture-tech")?.reasons)
      .toContain("oldest related concept is tech/old-map.md");
  });

  it("emits TIME when a domain refresh clock exceeds its configured TTL", async () => {
    const { db, state } = await setup();
    const now = Date.now();
    await state.ensure("p");
    await db.prepare(
      "UPDATE project_context_domains SET last_refreshed_at=?, last_checked_at=? WHERE project_id='p'",
    ).run(now, now - PROJECT_KNOWLEDGE_CHECK_COOLDOWN_MS - 1);
    const definition = PROJECT_KNOWLEDGE_DOMAINS.find((domain) => domain.id === "priorities-roadmap")!;
    await db.prepare(
      `UPDATE project_context_domains SET last_refreshed_at=?
        WHERE project_id='p' AND domain='priorities-roadmap'`,
    ).run(now - definition.refreshAfterMs - 1);
    const candidate = (await state.candidates("p", now))
      .find((entry) => entry.domain === "priorities-roadmap");
    expect(candidate?.triggers).toContain("TIME");
    expect(candidate?.reasons).toContain("domain knowledge is older than 30 days");
  });
});
