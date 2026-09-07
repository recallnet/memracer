// tests/conversations.test.ts — multi-human conflict conversations (#77).
import { afterEach, describe, expect, it } from "vitest";
import { Queue } from "../src/queue.js";
import { ConversationStore } from "../src/conversations.js";
import { MediatorWorker } from "../src/mediator/worker.js";
import { registerPipelines } from "../src/mediator/pipelines.js";
import { FakeDriver } from "../src/mediator/fake.js";
import { openTestDb } from "./helpers/db.js";

async function setup() {
  const db = await openTestDb();
  await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
  const queue = new Queue(db);
  const worker = new MediatorWorker(db, { tickMs: 20, jobTimeoutMs: 2000 });
  registerPipelines({ db, queue, worker, driverFor: () => new FakeDriver() });
  worker.start();
  const store = new ConversationStore(db, queue);
  return { db, queue, worker, store };
}

let active: MediatorWorker | undefined;
afterEach(() => active?.stop());

describe("ConversationStore", () => {
  it("opens a conversation over the threads topology: anchor thread, participants, tasks, opening message", async () => {
    const { db, queue, worker, store } = await setup();
    active = worker;
    const a = await queue.submit("p", "dana", { title: "t", body: "b", evidence: [] });
    const b = await queue.submit("p", "rui", { title: "t2", body: "b2", evidence: [] });
    const convId = await store.open("p", {
      topic: "conflict",
      taskIds: [a, b],
      participants: ["dana", "rui"],
      opening: "please resolve",
    });
    const view = (await store.get(convId))!;
    expect(view.state).toBe("OPEN");
    expect(view.deadline).toBeGreaterThan(Date.now());
    expect(view.task_ids).toEqual([a, b]);
    expect(view.participants.map((p) => p.member).sort()).toEqual(["dana", "rui"]);
    expect(view.participants.every((p) => p.replied_at === null)).toBe(true);
    // messages live in thread_messages on the anchor thread (topology reuse)
    expect(view.messages).toHaveLength(1);
    expect(view.messages[0]).toMatchObject({ role: "mediator", content: "please resolve" });
    const th = await db.prepare("SELECT kind FROM threads WHERE id=?").get<{ kind: string }>(view.thread_id);
    expect(th?.kind).toBe("discuss");
  });

  it("records a participant reply and stamps replied_at; a non-participant is rejected", async () => {
    const { worker, store } = await setup();
    active = worker;
    const convId = await store.open("p", { topic: "c", taskIds: [], participants: ["dana", "rui"] });
    expect(await store.allReplied(convId)).toBe(false);
    await store.reply(convId, "dana", "I think merge");
    const view = (await store.get(convId))!;
    expect(view.messages.map((m) => m.author)).toEqual(["dana"]);
    expect(view.participants.find((p) => p.member === "dana")!.replied_at).toBeGreaterThan(0);
    expect(await store.allReplied(convId)).toBe(false); // rui still silent
    await expect(store.reply(convId, "mallory", "butting in")).rejects.toThrow(/not a participant/);
    await store.reply(convId, "rui", "agreed");
    expect(await store.allReplied(convId)).toBe(true);
  });

  it("a reply to a non-OPEN conversation is rejected", async () => {
    const { worker, store } = await setup();
    active = worker;
    const convId = await store.open("p", { topic: "c", taskIds: [], participants: ["dana"] });
    await store.close(convId, "CLOSED", "done");
    await expect(store.reply(convId, "dana", "late")).rejects.toThrow(/not OPEN/);
  });

  it("honors a per-conversation timeout in days and surfaces due conversations", async () => {
    const { worker, store } = await setup();
    active = worker;
    const convId = await store.open("p", {
      topic: "c",
      taskIds: [],
      participants: ["dana"],
      timeoutDays: -1, // already past — for the sweep test
    });
    const due = await store.dueForTimeout();
    expect(due.map((d) => d.id)).toContain(convId);
  });
});

describe("groom conflict detection (#77)", () => {
  it("two members' same-content submissions open a conversation and hold both tasks — no silent merge", async () => {
    const { db, queue, worker, store } = await setup();
    active = worker;
    const a = await queue.submit("p", "dana", { title: "Add rate limiter", body: "throttle the api", evidence: [] });
    const b = await queue.submit("p", "rui", { title: "Add rate limiter", body: "throttle the api", evidence: [] });
    const job = await worker.waitForJob(await worker.enqueue("p", "groom", { taskId: b, submittedBy: "rui" }), 3000);
    expect(job.status).toBe("done");
    const result = JSON.parse(job.result!);
    expect(result).toMatchObject({ action: "conflict", task_id: b, with_task_id: a });
    // both tasks held off the coder queue
    expect((await queue.brief(a)).state).toBe("HELD");
    expect((await queue.brief(b)).state).toBe("HELD");
    // a conversation exists with both submitters and both tasks
    const conv = (await store.get(result.conversation_id))!;
    expect(conv.state).toBe("OPEN");
    expect(conv.participants.map((p) => p.member).sort()).toEqual(["dana", "rui"]);
    expect(conv.task_ids.sort((x, y) => x - y)).toEqual([a, b].sort((x, y) => x - y));
    // the open is provenance-linked to a decision
    expect(conv.decision_ids.length).toBe(1);
    expect(await db.prepare("SELECT kind FROM decision_log").all()).toEqual([{ kind: "clarify" }]);
  });

  it("distinct-content submissions from different members do NOT open a conversation (groom as usual)", async () => {
    const { queue, worker } = await setup();
    active = worker;
    await queue.submit("p", "dana", { title: "A", body: "one thing", evidence: [] });
    const b = await queue.submit("p", "rui", { title: "B", body: "totally different", evidence: [] });
    const job = await worker.waitForJob(await worker.enqueue("p", "groom", { taskId: b, submittedBy: "rui" }), 3000);
    expect(JSON.parse(job.result!)).toMatchObject({ action: "accept", task_id: b });
  });

  it("same member's resubmission is not a conflict (that is dedup, not a conflict)", async () => {
    const { queue, worker } = await setup();
    active = worker;
    await queue.submit("p", "dana", { title: "Same", body: "same body", evidence: [] });
    const b = await queue.submit("p", "dana", { title: "Same", body: "same body", evidence: [] });
    const job = await worker.waitForJob(await worker.enqueue("p", "groom", { taskId: b, submittedBy: "dana" }), 3000);
    expect(JSON.parse(job.result!)).toMatchObject({ action: "accept" });
  });
});

describe("conciliate: close paths and outcome application (#77)", () => {
  async function openConflict() {
    const ctx = await setup();
    const { queue, worker } = ctx;
    const a = await queue.submit("p", "dana", { title: "Cache layer", body: "add a cache", evidence: [] });
    const b = await queue.submit("p", "rui", { title: "Cache layer", body: "add a cache", evidence: [] });
    const job = await worker.waitForJob(await worker.enqueue("p", "groom", { taskId: b, submittedBy: "rui" }), 3000);
    const conversationId = JSON.parse(job.result!).conversation_id as number;
    return { ...ctx, a, b, conversationId };
  }

  it("early close: all replied + settled merge → dup closed, survivor reopened, linked decision, later groom sees it", async () => {
    const { db, queue, worker, store, a, b, conversationId } = await openConflict();
    active = worker;
    await store.reply(conversationId, "dana", `let's go with #${a}. RESOLVE: merge into ${a}`);
    // last reply triggers conciliation
    await store.reply(conversationId, "rui", "agreed");
    const jobId = await worker.enqueue("p", "conciliate", { conversationId });
    const result = JSON.parse((await worker.waitForJob(jobId, 3000)).result!);
    expect(result).toMatchObject({ settled: true, state: "CLOSED" });

    const conv = (await store.get(conversationId))!;
    expect(conv.state).toBe("CLOSED");
    expect(conv.summary).toMatch(/merged/i);
    // survivor a is live again (QUEUED); dup b closed
    expect(await queue.brief(a)).toMatchObject({ state: "QUEUED", queue_generation: 2 });
    expect((await queue.brief(b)).state).toBe("DONE");
    // a conversation-linked close decision exists
    expect(conv.decision_ids.length).toBe(2); // the open 'clarify' + the close 'close'
    const linked = await db
      .prepare(
        `SELECT dl.kind FROM decision_log dl JOIN conversation_decisions cd ON cd.decision_id = dl.id
         WHERE cd.conversation_id = ? ORDER BY dl.id`,
      )
      .all<{ kind: string }>(conversationId);
    expect(linked.map((r) => r.kind)).toEqual(["clarify", "close"]);
  });

  it("early close: split keeps both tasks (annotated) and reopens them", async () => {
    const { queue, worker, store, a, b, conversationId } = await openConflict();
    active = worker;
    await store.reply(conversationId, "dana", "these are actually different. RESOLVE: split");
    await store.reply(conversationId, "rui", "yes keep both");
    const result = JSON.parse(
      (await worker.waitForJob(await worker.enqueue("p", "conciliate", { conversationId }), 3000)).result!,
    );
    expect(result).toMatchObject({ settled: true, state: "CLOSED" });
    expect(await queue.brief(a)).toMatchObject({ state: "QUEUED", queue_generation: 2 });
    expect(await queue.brief(b)).toMatchObject({ state: "QUEUED", queue_generation: 2 });
    expect((await queue.brief(a)).body).toMatch(/Scope narrowed/);
    expect((await store.get(conversationId))!.state).toBe("CLOSED");
  });

  it("not settled + not expired: conversation stays OPEN, mediator note appended", async () => {
    const { worker, store, conversationId } = await openConflict();
    active = worker;
    // No RESOLVE marker → FakeDriver returns settled:false
    await store.reply(conversationId, "dana", "hmm not sure");
    await store.reply(conversationId, "rui", "me neither");
    const result = JSON.parse(
      (await worker.waitForJob(await worker.enqueue("p", "conciliate", { conversationId }), 3000)).result!,
    );
    expect(result).toMatchObject({ settled: false });
    const conv = (await store.get(conversationId))!;
    expect(conv.state).toBe("OPEN");
    expect(conv.messages.some((m) => m.role === "mediator" && /no consensus/i.test(m.content))).toBe(true);
  });

  it("timeout close: expire with partial input closes EXPIRED and holds the tasks", async () => {
    const { queue, worker, store, a, b, conversationId } = await openConflict();
    active = worker;
    // only one participant replied — partial input
    await store.reply(conversationId, "dana", "I lean merge but let's wait");
    const result = JSON.parse(
      (await worker.waitForJob(await worker.enqueue("p", "conciliate", { conversationId, expire: true }), 3000)).result!,
    );
    expect(result).toMatchObject({ settled: true, state: "EXPIRED" });
    const conv = (await store.get(conversationId))!;
    expect(conv.state).toBe("EXPIRED");
    expect(conv.summary).toMatch(/expired/i);
    // no consensus → tasks held pending a human decision
    expect((await queue.brief(a)).state).toBe("HELD");
    expect((await queue.brief(b)).state).toBe("HELD");
  });

  it("conciliating an already-closed conversation is a no-op", async () => {
    const { worker, store, conversationId } = await openConflict();
    active = worker;
    await store.close(conversationId, "CLOSED", "manual");
    const result = JSON.parse(
      (await worker.waitForJob(await worker.enqueue("p", "conciliate", { conversationId }), 3000)).result!,
    );
    expect(result).toMatchObject({ noop: true });
  });

  it("timeout sweep force-closes an OPEN conversation past its deadline", async () => {
    const { db, queue, worker, store } = await setup();
    active = worker;
    const a = await queue.submit("p", "dana", { title: "Q", body: "qq", evidence: [] });
    const b = await queue.submit("p", "rui", { title: "Q", body: "qq", evidence: [] });
    const conversationId = JSON.parse(
      (await worker.waitForJob(await worker.enqueue("p", "groom", { taskId: b, submittedBy: "rui" }), 3000)).result!,
    ).conversation_id as number;
    // force the deadline into the past, then let the registered sweep run
    await db.prepare("UPDATE conversations SET deadline = 1 WHERE id = ?").run(conversationId);
    await new Promise((r) => setTimeout(r, 200)); // a few sweep ticks (tickMs=20)
    const conv = (await store.get(conversationId))!;
    expect(conv.state).toBe("EXPIRED");
    void a;
  });
});
