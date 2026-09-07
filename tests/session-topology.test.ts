import { afterEach, describe, expect, it } from "vitest";
import { Queue, DEFAULT_LEASE_TTL_MS } from "../src/queue.js";
import { MediatorWorker } from "../src/mediator/worker.js";
import { registerPipelines } from "../src/mediator/pipelines.js";
import { FakeDriver } from "../src/mediator/fake.js";
import { MemoryTools } from "../src/mediator/memory-tools.js";
import type { MediatorContext } from "../src/mediator/driver.js";
import { openTestDb } from "./helpers/db.js";

/** FakeDriver that records the context of every review job for inspection. */
class SpyReviewDriver extends FakeDriver {
  contexts: MediatorContext[] = [];
  override async review(ctx: MediatorContext, input: Parameters<FakeDriver["review"]>[1]) {
    this.contexts.push(ctx);
    return { verdict: "revise" as const, feedback: "capture-only", rationale: "spy" };
  }
}

async function setup() {
  const db = await openTestDb();
  await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
  await db.prepare("INSERT INTO projects (id, name) VALUES ('q','Q')").run();
  const queue = new Queue(db);
  const worker = new MediatorWorker(db, { tickMs: 20, jobTimeoutMs: 2000 });
  const spy = new SpyReviewDriver();
  registerPipelines({ db, queue, worker, driverFor: () => spy });
  worker.start();
  return { db, queue, worker, spy, tools: new MemoryTools(db) };
}

let active: MediatorWorker | undefined;
afterEach(() => active?.stop());

async function groom(worker: MediatorWorker, taskId: number, by = "dana") {
  await worker.waitForJob(await worker.enqueue("p", "groom", { taskId, submittedBy: by }), 3000);
}

describe("session context topology", () => {
  it("a forked child carries ancestor + sibling thread_ids and can thread_read their ACTUAL content, sandboxed", async () => {
    const { queue, worker, spy, tools } = await setup();
    active = worker;
    const parent = await queue.submit("p", "dana", { title: "parent", body: "PARENT-BODY split the work", evidence: [] });
    const c1 = await queue.submit("p", "dana", { title: "child one", body: "do half", evidence: [], parentId: parent });
    const c2 = await queue.submit("p", "dana", {
      title: "child two", body: "CONCURRENT-C2-WORK in flight", evidence: [], parentId: parent,
    });
    await groom(worker, parent);
    await groom(worker, c1);
    await groom(worker, c2);

    // review c1 → capture its lineage
    await worker.waitForJob(await worker.enqueue("p", "review", { taskId: c1, plan: "p", agent: "cc-1" }), 3000);
    const lineage = spy.contexts.at(-1)!.lineage!;

    // ancestor parent carries readable thread handles (not just a one-liner)
    expect(lineage.ancestors.map((a) => a.id)).toEqual([parent]);
    const parentThreads = lineage.ancestors[0].thread_ids;
    expect(parentThreads.length).toBeGreaterThan(0);

    // concurrent sibling c2 is present WITH thread handles and an in-flight state,
    // even though it never completed (no summarizeTaskThreads ran on it)
    const sib = lineage.siblings.find((s) => s.id === c2)!;
    expect(sib.state).not.toBe("DONE");
    expect(sib.thread_ids.length).toBeGreaterThan(0);

    // the mediator thread_reads the parent's ACTUAL conversation, project-scoped
    const p = tools.bind("p");
    const parentRead = (await p.dispatch("thread_read", { threadId: parentThreads[0] })) as {
      messages?: { content: string }[];
    };
    expect(JSON.stringify(parentRead.messages)).toContain("PARENT-BODY");
    // …and the concurrent sibling's in-flight work
    const sibRead = (await p.dispatch("thread_read", { threadId: sib.thread_ids[0] })) as {
      messages?: { content: string }[];
    };
    expect(JSON.stringify(sibRead.messages)).toContain("CONCURRENT-C2-WORK");

    // cross-project refusal: project Q's tools cannot read project P's thread
    const q = tools.bind("q");
    const refused = (await q.dispatch("thread_read", { threadId: parentThreads[0] })) as { error?: string };
    expect(refused.error).toBeDefined();
    expect(JSON.stringify(refused)).not.toContain("PARENT-BODY");
  });

  it("orders siblings completed-before-me first, then concurrent", async () => {
    const { queue, worker, spy } = await setup();
    active = worker;
    const parent = await queue.submit("p", "dana", { title: "root", body: "b", evidence: [] });
    const c1 = await queue.submit("p", "dana", { title: "c1", body: "b", evidence: [], parentId: parent });
    const cDone = await queue.submit("p", "dana", { title: "done sib", body: "b", evidence: [], parentId: parent });
    const cActive = await queue.submit("p", "dana", { title: "active sib", body: "b", evidence: [], parentId: parent });
    await groom(worker, cDone);
    await groom(worker, cActive);
    // drive cDone to DONE
    await queue.claimNext("p", "cc-1", DEFAULT_LEASE_TTL_MS); // parent (lowest id)
    await queue.claimNext("p", "cc-2", DEFAULT_LEASE_TTL_MS); // c1
    await queue.claimNext("p", "cc-3", DEFAULT_LEASE_TTL_MS); // cDone
    await queue.complete(cDone, "cc-3", "shipped", "https://github.com/x/y/pull/1");

    await worker.waitForJob(await worker.enqueue("p", "review", { taskId: c1, plan: "p", agent: "cc-2" }), 3000);
    const siblings = spy.contexts.at(-1)!.lineage!.siblings.filter((s) => s.id === cDone || s.id === cActive);
    expect(siblings.map((s) => s.id)).toEqual([cDone, cActive]); // DONE first
    expect(siblings[0].state).toBe("DONE");
    expect(siblings[1].state).not.toBe("DONE");
  });
});
