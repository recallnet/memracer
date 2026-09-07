// tests/queue-mediation.test.ts
import { describe, expect, it } from "vitest";
import { Queue, DEFAULT_LEASE_TTL_MS } from "../src/queue.js";
import { MemoryStore } from "../src/mediator/memory.js";
import { openTestDb } from "./helpers/db.js";

async function makeQ() {
  const db = await openTestDb();
  await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
  return { db, q: new Queue(db) };
}

describe("queue mediation ops", () => {
  it("brief falls back to the project repo when the task has none", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name, repo) VALUES ('p','P','recallnet/p-repo')").run();
    const q = new Queue(db);
    const id = await q.submit("p", "dana", { title: "t", body: "b", evidence: [] });
    expect((await q.brief(id)).repo).toBe("recallnet/p-repo");
    const explicit = await q.submit("p", "dana", { title: "t2", body: "b", evidence: [], repo: "other/repo" });
    expect((await q.brief(explicit)).repo).toBe("other/repo");
  });

  it("applyGroom accept updates the task and rationale", async () => {
    const { q } = await makeQ();
    const id = await q.submit("p", "dana", { title: "raw", body: "raw body", evidence: [] });
    await q.applyGroomAccept(id, "clean title", "clean body", 1, "tightened");
    const b = await q.brief(id);
    expect(b.title).toBe("clean title");
    expect(b.priority).toBe(1);
    expect(b.grooming_rationale).toBe("tightened");
  });

  it("applyGroomMerge moves evidence and writes destination-owned source provenance", async () => {
    const { db, q } = await makeQ();
    const target = await q.submit("p", "dana", {
      title: "Preserve groom evidence on the surviving task",
      body: "Move submitted evidence to the surviving duplicate task.",
      evidence: [],
    });
    const dup = await q.submit("p", "rui", {
      title: "Preserve groom evidence on the surviving task",
      body: "Move submitted evidence to the surviving duplicate task.",
      evidence: [{ kind: "code", path: "x.ts", snippet: "s" }],
    });
    expect(await q.applyGroomMerge(dup, target, {
      rationale: "same deliverable",
      citations: [{ type: "evidence", id: 1 }],
      mode: "groom",
    })).toEqual({ merged: true });
    expect((await q.brief(target)).evidence).toHaveLength(1);
    expect((await q.status("p")).tasks.map((t) => t.id)).toEqual([target]);
    const decision = await db.prepare(
      "SELECT task_id, summary, rationale, citations FROM decision_log WHERE kind='merge'",
    ).get<{ task_id: number; summary: string; rationale: string; citations: string }>();
    expect(decision).toMatchObject({
      task_id: target,
      summary: `merged task ${dup} into task ${target}`,
      citations: JSON.stringify([{ type: "evidence", id: 1 }]),
    });
    // Provenance stores a reference (task_id + title), never the merged task's
    // full body — inlining it poisons groom context (content-misattribution bug).
    expect(decision!.rationale.split("\n").at(-1)).toBe(JSON.stringify({
      merged_from: {
        task_id: dup,
        title: "Preserve groom evidence on the surviving task",
      },
    }));
  });

  it("applyGroomMerge refuses different scopes and leaves both tasks intact", async () => {
    const { q } = await makeQ();
    const target = await q.submit("p", "dana", {
      title: "Record mediator delivery architecture",
      body: "Record the mediator delivery architecture for operators.",
      evidence: [{ kind: "code", path: ".okf/tech/mediator-sessions.md" }],
    });
    const source = await q.submit("p", "rui", {
      title: "Record mediator delivery architecture",
      body: "Record the mediator delivery architecture for operators.",
      evidence: [{ kind: "code", path: "src/mediator/pipelines.ts" }],
    });

    expect(await q.applyGroomMerge(source, target)).toEqual({ merged: false, reason: "scope_mismatch" });
    expect((await q.status("p")).tasks.map((task) => task.id)).toEqual([target, source]);
  });

  it("applyGroomMerge refuses a terminal or cross-project target", async () => {
    const { db, q } = await makeQ();
    const source = await q.submit("p", "rui", {
      title: "Deliver conservative task merge checks",
      body: "Guard duplicate deletion with a deterministic safety classifier.",
      evidence: [],
    });
    const doneTarget = await q.submit("p", "dana", {
      title: "Deliver conservative task merge checks",
      body: "Guard duplicate deletion with a deterministic safety classifier.",
      evidence: [],
    });
    await db.prepare("UPDATE tasks SET state='DONE' WHERE id=?").run(doneTarget);
    expect(await q.applyGroomMerge(source, doneTarget)).toEqual({ merged: false, reason: "target_not_mergeable" });

    await db.prepare("INSERT INTO projects (id, name) VALUES ('q','Q')").run();
    const otherProject = await q.submit("q", "dana", {
      title: "Deliver conservative task merge checks",
      body: "Guard duplicate deletion with a deterministic safety classifier.",
      evidence: [],
    });
    expect(await q.applyGroomMerge(source, otherProject)).toEqual({ merged: false, reason: "target_not_mergeable" });
    expect((await q.status("p")).tasks.map((task) => task.id)).toContain(source);
    expect((await q.status("q")).tasks.map((task) => task.id)).toEqual([otherProject]);
  });

  it("applyGroomMerge refuses a source claimed before the transaction", async () => {
    const { q } = await makeQ();
    const source = await q.submit("p", "rui", {
      title: "Deliver conservative task merge checks",
      body: "Guard duplicate deletion with a deterministic safety classifier.",
      evidence: [],
    });
    const target = await q.submit("p", "dana", {
      title: "Deliver conservative task merge checks",
      body: "Guard duplicate deletion with a deterministic safety classifier.",
      evidence: [],
    });
    expect((await q.claimNext("p", "coder", DEFAULT_LEASE_TTL_MS))?.id).toBe(source);

    expect(await q.applyGroomMerge(source, target)).toEqual({ merged: false, reason: "source_not_mergeable" });
    expect((await q.status("p")).tasks.map((task) => task.id)).toEqual([source, target]);
  });

  it("serializes non-FK task owners in both writer-before-merge and merge-before-writer orders", async () => {
    const { db, q } = await makeQ();
    const memory = new MemoryStore(db);
    const title = "Serialize duplicate task ownership";
    const body = "Keep idempotency and memory provenance attached to the surviving task.";
    const target = await q.submit("p", "dana", { title, body, evidence: [] });
    const source = await q.submit("p", "rui", { title, body, evidence: [] });

    await q.rememberSubmissionKey("p", "rui", "writer-first", source);
    await memory.upsert("p", {
      path: "learnings/writer-first.md",
      type: "Learning",
      title: "Writer first",
      description: "A task owner lands before duplicate consolidation.",
      tags: ["queue"],
      body: "The merge retargets this provenance.",
      provenance: { sourceTask: source },
    });
    expect(await q.applyGroomMerge(source, target)).toEqual({ merged: true });
    expect(await q.findSubmissionByKey("p", "rui", "writer-first")).toBe(target);
    expect(await db.prepare("SELECT source_task FROM memory_docs WHERE path='learnings/writer-first.md'").get())
      .toEqual({ source_task: target });

    const laterTarget = await q.submit("p", "dana", { title, body, evidence: [] });
    const removedSource = await q.submit("p", "rui", { title, body, evidence: [] });
    expect(await q.applyGroomMerge(removedSource, laterTarget)).toEqual({ merged: true });
    await expect(q.rememberSubmissionKey("p", "rui", "merge-first", removedSource))
      .rejects.toThrow(/no longer exists/);
    await expect(memory.upsert("p", {
      path: "learnings/merge-first.md",
      type: "Learning",
      title: "Merge first",
      description: "A stale writer loses to duplicate consolidation.",
      tags: ["queue"],
      body: "The stale source id must not be published.",
      provenance: { sourceTask: removedSource },
    })).rejects.toThrow(/no longer exists/);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM submission_idempotency WHERE task_id=?").get(removedSource))
      .toEqual({ n: 0 });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM memory_docs WHERE source_task=?").get(removedSource))
      .toEqual({ n: 0 });
    await db.prepare(
      `INSERT INTO submission_idempotency
         (project_id, submitted_by, idempotency_key, task_id, created_at)
       VALUES ('p', 'rui', 'legacy-dangling', ?, ?)`,
    ).run(removedSource, Date.now());
    expect(await q.findSubmissionByKey("p", "rui", "legacy-dangling")).toBeNull();
  });

  it("serializes overlapping idempotency writers and merge reservations", async () => {
    const { db, q } = await makeQ();
    const title = "Serialize overlapping duplicate ownership";
    const body = "Retarget a writer that overlaps duplicate deletion without leaving stale task ids.";
    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => { resolve = done; });
      return { promise, resolve };
    };

    const writerTarget = await q.submit("p", "dana", { title, body, evidence: [] });
    const writerSource = await q.submit("p", "rui", { title, body, evidence: [] });
    const writerReserved = deferred();
    const finishWriter = deferred();
    const writerFirst = db.transaction(async () => {
      await db.prepare("UPDATE tasks SET updated_at=updated_at WHERE id=? RETURNING id").get(writerSource);
      writerReserved.resolve();
      await finishWriter.promise;
      await q.rememberSubmissionKey("p", "rui", "overlap-writer-first", writerSource);
    });
    await writerReserved.promise;
    const waitingMerge = q.applyGroomMerge(writerSource, writerTarget);
    finishWriter.resolve();
    await writerFirst;
    expect(await waitingMerge).toEqual({ merged: true });
    expect(await q.findSubmissionByKey("p", "rui", "overlap-writer-first")).toBe(writerTarget);

    const mergeTarget = await q.submit("p", "dana", { title, body, evidence: [] });
    const mergeSource = await q.submit("p", "rui", { title, body, evidence: [] });
    const mergeReserved = deferred();
    const finishMerge = deferred();
    const mergeFirst = db.transaction(async () => {
      await db.prepare(
        "UPDATE tasks SET updated_at=updated_at WHERE id IN (?, ?) AND project_id='p' RETURNING id",
      ).all(mergeSource, mergeTarget);
      mergeReserved.resolve();
      await finishMerge.promise;
      expect(await q.applyGroomMerge(mergeSource, mergeTarget)).toEqual({ merged: true });
    });
    await mergeReserved.promise;
    const waitingWriter = q.rememberSubmissionKey("p", "rui", "overlap-merge-first", mergeSource);
    finishMerge.resolve();
    await mergeFirst;
    await expect(waitingWriter).rejects.toThrow(/no longer exists/);
    expect(await q.findSubmissionByKey("p", "rui", "overlap-merge-first")).toBeNull();
  });

  it("atomically preserves and retargets a fallback audit when a waiting merge wins", async () => {
    const { db, q } = await makeQ();
    const title = "Serialize merge fallback audit ownership";
    const body = "Keep the fallback decision attached when duplicate consolidation follows it.";
    const target = await q.submit("p", "dana", { title, body, evidence: [] });
    const source = await q.submit("p", "rui", { title, body, evidence: [] });
    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => { resolve = done; });
      return { promise, resolve };
    };
    const fallbackReserved = deferred();
    const finishFallback = deferred();
    const fallbackFirst = db.transaction(async () => {
      await db.prepare("UPDATE tasks SET updated_at=updated_at WHERE id=? RETURNING id").get(source);
      fallbackReserved.resolve();
      await finishFallback.promise;
      expect(await q.applyGroomMergeFallback(source, title, body, 2, {
        rationale: "classifier refused the first proposal",
        citations: [{ type: "evidence", id: 7 }],
      })).toBe(true);
    });

    await fallbackReserved.promise;
    const waitingMerge = q.applyGroomMerge(source, target, {
      rationale: "later exact duplicate merge",
      mode: "groom",
    });
    finishFallback.resolve();
    await fallbackFirst;
    expect(await waitingMerge).toEqual({ merged: true });

    expect(await db.prepare("SELECT id FROM tasks WHERE id=?").get(source)).toBeUndefined();
    expect(await db.prepare(
      "SELECT task_id, summary, rationale, citations FROM decision_log WHERE kind='create'",
    ).get()).toEqual({
      task_id: target,
      summary: `created "${title}" (merge safety fallback)`,
      rationale: "classifier refused the first proposal",
      citations: JSON.stringify([{ type: "evidence", id: 7 }]),
    });
  });

  it("applyGroomMerge retargets children without making the target its own parent", async () => {
    const { db, q } = await makeQ();
    const duplicate = await q.submit("p", "dana", {
      title: "Retarget children after duplicate consolidation",
      body: "Move duplicate child links to the surviving task.",
      evidence: [],
    });
    const target = await q.submit("p", "dana", {
      title: "Retarget children after duplicate consolidation",
      body: "Move duplicate child links to the surviving task.",
      evidence: [],
      parentId: duplicate,
    });
    const child = await q.submit("p", "dana", {
      title: "child", body: "b", evidence: [], parentId: duplicate,
    });

    await q.applyGroomMerge(duplicate, target);

    expect(await db.prepare("SELECT parent_id FROM tasks WHERE id=?").get(target)).toEqual({ parent_id: null });
    expect(await db.prepare("SELECT parent_id FROM tasks WHERE id=?").get(child)).toEqual({ parent_id: target });
  });

  it("applyGroomRefuse removes only an unleased provisional task", async () => {
    const { db, q } = await makeQ();
    const refused = await q.submit("p", "dana", {
      title: "unsafe",
      body: "body",
      evidence: [{ kind: "code", path: ".env", snippet: "redacted" }],
    });
    expect(await q.applyGroomRefuse(refused, "p")).toBe(true);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE id=?").get(refused)).toEqual({ n: 0 });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM evidence WHERE task_id=?").get(refused)).toEqual({ n: 0 });

    const claimed = await q.submit("p", "dana", { title: "raced", body: "body", evidence: [] });
    await q.claimNext("p", "cc-1", DEFAULT_LEASE_TTL_MS);
    expect(await q.applyGroomRefuse(claimed, "p")).toBe(false);
    expect((await q.brief(claimed)).lease_agent).toBe("cc-1");
  });

  it("park releases the lease and unparkWithAnswer requeues with the answer attached", async () => {
    const { db, q } = await makeQ();
    const id = await q.submit("p", "dana", { title: "t", body: "b", evidence: [] });
    await q.claimNext("p", "cc-1", DEFAULT_LEASE_TTL_MS);
    await q.park(id, "cc-1");
    let b = await q.brief(id);
    expect(b.state).toBe("PARKED");
    expect(b.lease_agent).toBeNull();
    const qid = (await db
      .prepare(
        "INSERT INTO questions (project_id, task_id, asked_by, question, created_at) VALUES ('p',?,?,'which db?',1) RETURNING id",
      )
      .get<{ id: number }>(id, "cc-1"))!.id;
    await q.answerQuestion(qid, "postgres", "dana");
    expect(await q.addQuestions("p", id, "mediator", "Resolved: the database choice is postgres.")).toEqual([]);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM questions WHERE task_id=?").get(id)).toEqual({ n: 1 });
    b = await q.brief(id);
    expect(b.state).toBe("QUEUED");
    expect(b.queue_generation).toBe(2);
    expect(b.queued_at).toBeGreaterThan(0);
    expect(b.questions).toEqual([
      expect.objectContaining({ question: "which db?", answer: "postgres", status: "answered" }),
    ]);
  });

  it("holds a groom clarification once and accepts only one concurrent answer", async () => {
    const { db, q } = await makeQ();
    const id = await q.submit("p", "dana", { title: "t", body: "b", evidence: [] });
    const questionId = await q.holdForMediatorClarification(id, "p", "which database?");
    await expect(q.holdForMediatorClarification(id, "p", "which database?")).rejects.toThrow(/no longer queued/);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM questions WHERE task_id=?").get(id)).toEqual({ n: 1 });

    const outcomes = await Promise.allSettled([
      q.answerQuestion(questionId, "postgres", "dana"),
      q.answerQuestion(questionId, "sqlite", "dana"),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(await db.prepare("SELECT status FROM questions WHERE id=?").get(questionId)).toEqual({ status: "answered" });
    expect((await q.brief(id)).queue_generation).toBe(2);
  });

  it("block records the attempt", async () => {
    const { q } = await makeQ();
    const id = await q.submit("p", "dana", { title: "t", body: "b", evidence: [] });
    await q.claimNext("p", "cc-1", DEFAULT_LEASE_TTL_MS);
    await q.block(id, "cc-1", "dependency missing");
    const b = await q.brief(id);
    expect(b.state).toBe("BLOCKED");
    expect(b.attempts).toEqual([
      expect.objectContaining({ agent: "cc-1", outcome: "blocked", notes: "dependency missing" }),
    ]);
  });

  it("release gives the task back: QUEUED, lease gone, reason travels in the attempt", async () => {
    const { q } = await makeQ();
    const id = await q.submit("p", "dana", { title: "t", body: "b", evidence: [] });
    await q.claimNext("p", "cc-1", DEFAULT_LEASE_TTL_MS);
    const released = await q.release(id, "cc-1", "wrong toolchain: needs a Rust env I don't have");
    expect(released.state).toBe("QUEUED");
    expect(released.lease_agent).toBeNull();
    expect(released.lease_expires_at).toBeNull();
    // the next claimer sees the reason in the brief
    const brief = await q.claimNext("p", "cc-2", DEFAULT_LEASE_TTL_MS);
    expect(brief?.id).toBe(id);
    expect(brief?.attempts).toEqual([
      { agent: "cc-1", outcome: "released", notes: "wrong toolchain: needs a Rust env I don't have" },
    ]);
  });

  it("release rejects a non-lease-holder", async () => {
    const { q } = await makeQ();
    const id = await q.submit("p", "dana", { title: "t", body: "b", evidence: [] });
    await q.claimNext("p", "cc-1", DEFAULT_LEASE_TTL_MS);
    await expect(q.release(id, "intruder", "nope")).rejects.toThrow(/lease/);
  });

  it("block opens an answerable question and human_answer requeues the BLOCKED task", async () => {
    const { db, q } = await makeQ();
    const id = await q.submit("p", "dana", { title: "t", body: "b", evidence: [] });
    await q.claimNext("p", "cc-1", DEFAULT_LEASE_TTL_MS);
    await q.block(id, "cc-1", "dependency missing");
    expect(await q.brief(id)).toMatchObject({ state: "BLOCKED", block_kind: "human", block_requeue_at: null });
    const question = (await db
      .prepare("SELECT id, project_id, task_id, asked_by, question, status FROM questions")
      .get<{ id: number; project_id: string; task_id: number; asked_by: string; question: string; status: string }>()) as {
      id: number; project_id: string; task_id: number; asked_by: string; question: string; status: string;
    };
    expect(question).toMatchObject({
      project_id: "p", task_id: id, asked_by: "cc-1",
      question: "blocked: dependency missing — what should happen?",
      status: "open",
    });
    await q.answerQuestion(question.id, "install it via the repo dev container", "dana");
    const brief = await q.brief(id);
    expect(brief.state).toBe("QUEUED");
    expect(brief.block_kind).toBeNull();
    expect(brief.questions).toEqual([
      expect.objectContaining({ answer: "install it via the repo dev container", status: "answered" }),
    ]);
  });

  it("infra-failure blocks auto-requeue only after their retry clock", async () => {
    const { db, q } = await makeQ();
    const id = await q.submit("p", "dana", { title: "t", body: "b", evidence: [] });
    await q.claimNext("p", "cc-1", DEFAULT_LEASE_TTL_MS);
    const blocked = await q.block(id, "cc-1", "model endpoint returned 404", {
      kind: "infra_failure",
      retryAfterMs: 1_000,
    });
    expect(blocked).toMatchObject({ state: "BLOCKED", block_kind: "infra_failure" });
    expect(blocked.block_requeue_at).toBeGreaterThan(Date.now());
    expect(await db.prepare("SELECT COUNT(*) AS n FROM questions WHERE task_id=?").get(id)).toEqual({ n: 0 });
    expect(await q.recoverBlockedTasks(blocked.block_requeue_at! - 1)).toEqual([]);
    expect(await q.recoverBlockedTasks(blocked.block_requeue_at!)).toEqual([id]);
    expect(await q.brief(id)).toMatchObject({
      state: "QUEUED",
      block_kind: null,
      block_requeue_at: null,
      queue_generation: 2,
      attempts: [
        expect.objectContaining({ outcome: "blocked", notes: "model endpoint returned 404" }),
        expect.objectContaining({ agent: "system", outcome: "released", notes: expect.stringContaining("infrastructure retry") }),
      ],
    });
  });

  it("repairs a legacy BLOCKED row with no question or retry trigger", async () => {
    const { db, q } = await makeQ();
    const id = await q.submit("p", "dana", { title: "t", body: "b", evidence: [] });
    await db.prepare(
      "UPDATE tasks SET state='BLOCKED', block_kind='human', block_requeue_at=9999, queued_at=NULL WHERE id=?",
    ).run(id);
    expect(await q.recoverBlockedTasks(50)).toEqual([id]);
    expect(await q.brief(id)).toMatchObject({
      state: "QUEUED",
      block_kind: null,
      block_requeue_at: null,
      attempts: [expect.objectContaining({ outcome: "released", notes: expect.stringContaining("no open question") })],
    });
  });

  it("releases a HELD dependent when its predecessor completes and every hold condition is clear", async () => {
    const { db, q } = await makeQ();
    const predecessor = await q.submit("p", "dana", { title: "A", body: "first", priority: 0, evidence: [] });
    const dependent = await q.submit("p", "dana", { title: "B", body: "second", evidence: [] });
    await q.addDependency("p", dependent, predecessor);
    await db.prepare(
      "UPDATE tasks SET state='HELD', result_summary='held: waiting for A', plan_deadline=123 WHERE id=?",
    ).run(dependent);

    await q.claimNext("p", "cc-1", DEFAULT_LEASE_TTL_MS);
    await q.complete(predecessor, "cc-1", "done", "https://github.com/acme/repo/pull/1");

    expect(await q.brief(dependent)).toMatchObject({
      state: "QUEUED",
      result_summary: null,
      plan_deadline: null,
      queue_generation: 2,
      attempts: [
        expect.objectContaining({
          agent: "system",
          outcome: "released",
          notes: "auto-requeued: HELD conditions resolved",
        }),
      ],
    });
  });

  it("keeps HELD tasks held while any mediator question, conflict conversation, or predecessor remains open", async () => {
    const { db, q } = await makeQ();
    const predecessor = await q.submit("p", "dana", { title: "A", body: "first", evidence: [] });
    const withQuestion = await q.submit("p", "dana", { title: "question", body: "b", evidence: [] });
    const withConversation = await q.submit("p", "dana", { title: "conversation", body: "b", evidence: [] });
    const withDependency = await q.submit("p", "dana", { title: "dependency", body: "b", evidence: [] });
    const intentionalHold = await q.submit("p", "dana", { title: "intentional", body: "b", evidence: [] });
    await db.prepare("UPDATE tasks SET state='HELD' WHERE id IN (?, ?, ?, ?)")
      .run(withQuestion, withConversation, withDependency, intentionalHold);
    await db.prepare("UPDATE tasks SET state='DONE' WHERE id=?").run(predecessor);
    await q.addDependency("p", withQuestion, predecessor);
    await q.addDependency("p", withConversation, predecessor);
    await q.addDependency("p", intentionalHold, predecessor);
    await db.prepare("UPDATE tasks SET hold_cause='explicit' WHERE id=?").run(intentionalHold);
    await db.prepare(
      "INSERT INTO questions (project_id, task_id, asked_by, question, created_at) VALUES ('p', ?, 'mediator', 'clarify?', 1)",
    ).run(withQuestion);
    const thread = await db.prepare(
      "INSERT INTO threads (project_id, kind, task_id, created_at) VALUES ('p', 'discuss', ?, 1) RETURNING id",
    ).get<{ id: number }>(withConversation);
    const conversation = await db.prepare(
      "INSERT INTO conversations (project_id, thread_id, topic, deadline, created_at) VALUES ('p', ?, 'conflict', 9999, 1) RETURNING id",
    ).get<{ id: number }>(thread!.id);
    await db.prepare("INSERT INTO conversation_tasks (conversation_id, task_id) VALUES (?, ?)")
      .run(conversation!.id, withConversation);
    await q.addDependency("p", withDependency, predecessor);

    const unfinished = await q.submit("p", "dana", { title: "unfinished", body: "b", evidence: [] });
    await q.addDependency("p", withDependency, unfinished);

    expect(await q.recoverDependencyHolds({ projectId: "p", now: 50 })).toEqual([]);
    expect((await q.brief(withQuestion)).state).toBe("HELD");
    expect((await q.brief(withConversation)).state).toBe("HELD");
    expect((await q.brief(withDependency)).state).toBe("HELD");
    expect((await q.brief(intentionalHold)).state).toBe("HELD");
  });

  it("every supported BLOCKED entry has an open question or retry trigger", async () => {
    const { db, q } = await makeQ();
    for (const [title, kind] of [["human", "human"], ["dependency", "dependency"], ["infra", "infra_failure"]] as const) {
      const id = await q.submit("p", "dana", { title, body: "b", evidence: [] });
      await q.claimNext("p", `cc-${title}`, DEFAULT_LEASE_TTL_MS);
      await q.block(id, `cc-${title}`, `${title} blocked`, { kind });
    }
    const clarification = await q.submit("p", "dana", { title: "clarify", body: "b", evidence: [] });
    await q.holdForMediatorClarification(clarification, "p", "which database?");

    expect(await db.prepare(
      `SELECT t.id FROM tasks t
       WHERE t.state='BLOCKED' AND t.block_requeue_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM questions qn WHERE qn.task_id=t.id AND qn.status='open')`,
    ).all()).toEqual([]);
  });

  it("keeps the lease when a human block cannot open a new question", async () => {
    const { db, q } = await makeQ();
    const id = await q.submit("p", "dana", { title: "t", body: "b", evidence: [] });
    const [questionId] = await q.addQuestions("p", id, "cc-old", "blocked: staging db is gone — what should happen?");
    await q.answerQuestion(questionId, "use the local db", "dana");
    await q.claimNext("p", "cc-1", DEFAULT_LEASE_TTL_MS);

    await expect(q.block(id, "cc-1", "staging db is gone")).rejects.toThrow(/did not produce an open question/);
    expect(await q.brief(id)).toMatchObject({ state: "CLAIMED", lease_agent: "cc-1", block_kind: null });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE task_id=?").get(id)).toEqual({ n: 0 });
  });

  it("approvePlan moves CLAIMED to PLANNED and submit accepts a parent", async () => {
    const { q } = await makeQ();
    const id = await q.submit("p", "dana", { title: "t", body: "b", evidence: [] });
    await q.claimNext("p", "cc-1", DEFAULT_LEASE_TTL_MS);
    await q.approvePlan(id, "the plan");
    expect((await q.brief(id)).state).toBe("PLANNED");
    const child = await q.submit("p", "dana", { title: "kid", body: "b", evidence: [], parentId: id });
    expect((await q.brief(child)).parent_id).toBe(id);
  });
});
