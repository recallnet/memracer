// tests/mediator-incubation-curation.test.ts
//
// Warming-period curation loop (#62): during a task's INCUBATING period any
// project human — not just the submitter — can human_enhance the canonical
// spec. The mediator arbitrates each contribution: merge it into the body,
// refuse scope creep with a reason, or ask a clarifying question. The
// contribution -> mediator -> decision loop lands on the task's incubation
// thread, and the refined spec survives graduation. Deterministic via
// FakeDriver (markers: SCOPECREEP… -> refuse, "CLARIFY: q" -> clarify).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openDb } from "../src/db.js";
import { betterAuthReady, seedMember } from "./helpers/auth.js";
import { enhanceAndWait } from "./helpers/async-human.js";
import { createApp } from "../src/server.js";
import { FakeDriver } from "../src/mediator/fake.js";
import { DEFAULT_LEASE_TTL_MS, type Queue } from "../src/queue.js";
import type { MediatorWorker } from "../src/mediator/worker.js";
import type { Db } from "../src/db.js";

let httpServer: Server;
let baseUrl: string;
let worker: MediatorWorker;
let queue: Queue;
let dbRef: Db;
const tokens: Record<string, string> = {};

beforeEach(async () => {
  dbRef = openDb(":memory:");
  await betterAuthReady(dbRef);
  await dbRef.prepare("INSERT INTO projects (id, name) VALUES ('demo','Demo')").run();
  tokens["tok-h"] = (await seedMember(dbRef, { name: "dana", projectId: "demo", role: "human" })).token; // submitter
  tokens["tok-h2"] = (await seedMember(dbRef, { name: "evan", projectId: "demo", role: "human" })).token; // a different demo human
  await dbRef.prepare("INSERT INTO projects (id, name) VALUES ('other','Other')").run();
  tokens["tok-out"] = (await seedMember(dbRef, { name: "olga", projectId: "other", role: "human" })).token; // human, NOT a member of demo
  const made = createApp(dbRef, { driverFor: () => new FakeDriver(), workerOpts: { tickMs: 20, jobTimeoutMs: 2000 } });
  worker = made.worker;
  queue = made.queue;
  await new Promise<void>((resolve) => {
    httpServer = made.app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`;
});

afterEach(async () => {
  worker.stop();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: "test", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
    requestInit: { headers: { Authorization: `Bearer ${tokens[token] ?? token}` } },
  });
  await client.connect(transport);
  return client;
}

function parse(result: { content?: unknown }) {
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0].text);
}

async function warmTask(client: Client, title: string, body: string): Promise<number> {
  const submitted = parse(await client.callTool({
    name: "human_submit",
    arguments: { title, body, evidence: [], warm_for: "1d" },
  }));
  expect(submitted.task.state).toBe("INCUBATING");
  return submitted.task.id;
}

async function decisionsFor(taskId: number): Promise<{ kind: string; summary: string }[]> {
  return dbRef
    .prepare("SELECT kind, summary FROM decision_log WHERE task_id=? ORDER BY id ASC")
    .all<{ kind: string; summary: string }>(taskId);
}

describe("incubation curation over MCP (#62)", () => {
  it("a non-submitter human enhances a warming task; the mediator merges it into the canonical body", async () => {
    const dana = await connect("tok-h");
    const evan = await connect("tok-h2");
    const taskId = await warmTask(dana, "warm feature", "Outcome: ship X");

    const res = await enhanceAndWait(evan, { task_id: taskId, contribution: "add a rate-limit acceptance criterion" });
    expect(res.verdict.action).toBe("merge");
    expect(res.task.body).toContain("Contribution from evan: add a rate-limit acceptance criterion");
    // still INCUBATING — enhancing never graduates the task
    expect(res.task.state).toBe("INCUBATING");

    const decisions = await decisionsFor(taskId);
    expect(decisions.some((d) => d.kind === "merge")).toBe(true);
  });

  it("two humans enhance; the mediator merges the strong change and refuses the scope creep", async () => {
    const dana = await connect("tok-h");
    const evan = await connect("tok-h2");
    const taskId = await warmTask(dana, "warm feature", "Outcome: ship X");

    const merged = await enhanceAndWait(evan, { task_id: taskId, contribution: "tighten the error-path acceptance criterion" });
    expect(merged.verdict.action).toBe("merge");

    const refused = await enhanceAndWait(dana, { task_id: taskId, contribution: "SCOPECREEP also rewrite the billing system" });
    expect(refused.verdict.action).toBe("refuse");
    expect(refused.verdict.rationale).toMatch(/out of scope/i);

    // The canonical body converged: it carries the merged change, not the creep.
    const brief = await queue.brief(taskId);
    expect(brief.body).toContain("tighten the error-path acceptance criterion");
    expect(brief.body).not.toContain("billing system");

    const decisions = await decisionsFor(taskId);
    expect(decisions.filter((d) => d.kind === "merge")).toHaveLength(1);
    expect(decisions.filter((d) => d.kind === "revise")).toHaveLength(1);
  });

  it("records the contribution -> mediator -> decision loop on the incubation thread", async () => {
    const dana = await connect("tok-h");
    const taskId = await warmTask(dana, "warm feature", "Outcome: ship X");
    await enhanceAndWait(dana, { task_id: taskId, contribution: "attach research on prior art" });

    const thread = await dbRef
      .prepare("SELECT id FROM threads WHERE task_id=? AND kind='discuss' ORDER BY id DESC LIMIT 1")
      .get<{ id: number }>(taskId);
    expect(thread).toBeTruthy();
    const msgs = await dbRef
      .prepare("SELECT role, author, content FROM thread_messages WHERE thread_id=? ORDER BY id ASC")
      .all<{ role: string; author: string; content: string }>(thread!.id);
    expect(msgs[0]).toMatchObject({ role: "human", author: "dana" });
    expect(msgs[0].content).toContain("attach research on prior art");
    expect(msgs.at(-1)!.role).toBe("mediator");
    expect(msgs.at(-1)!.content).toContain("merge");
  });

  it("a clarify contribution is recorded and leaves the body untouched", async () => {
    const dana = await connect("tok-h");
    const taskId = await warmTask(dana, "warm feature", "Outcome: ship X");
    const res = await enhanceAndWait(dana, { task_id: taskId, contribution: "CLARIFY: which region first?" });
    expect(res.verdict.action).toBe("clarify");
    expect(res.verdict.question).toBe("which region first?");
    expect(res.task.body).toBe("Outcome: ship X");
    expect((await decisionsFor(taskId)).some((d) => d.kind === "clarify")).toBe(true);
  });

  it("the collectively refined spec survives graduation", async () => {
    const dana = await connect("tok-h");
    const evan = await connect("tok-h2");
    const taskId = await warmTask(dana, "warm feature", "Outcome: ship X");
    await enhanceAndWait(evan, { task_id: taskId, contribution: "add an idempotency requirement" });

    // Clock strikes → seal groom graduates it to QUEUED.
    await dbRef.prepare("UPDATE tasks SET incubate_until=? WHERE id=?").run(Date.now() - 1, taskId);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const row = await dbRef.prepare("SELECT state FROM tasks WHERE id=?").get<{ state: string }>(taskId);
      if (row!.state === "QUEUED") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const brief = await queue.brief(taskId);
    expect(brief.state).toBe("QUEUED");
    expect(brief.body).toContain("add an idempotency requirement");
    // now claimable, carrying the refined spec
    const claimed = await queue.claimNext("demo", "cc-1", DEFAULT_LEASE_TTL_MS);
    expect(claimed?.id).toBe(taskId);
  });

  it("human_enhance is gated: refuses a non-INCUBATING task and non-members", async () => {
    const dana = await connect("tok-h");
    const olga = await connect("tok-out");

    // a plain (non-warm) submission is QUEUED, not INCUBATING → not enhanceable
    const plain = parse(await dana.callTool({
      name: "human_submit",
      arguments: { title: "plain", body: "b", evidence: [] },
    }));
    const plainId = plain.task.id;
    const notWarm = await dana.callTool({
      name: "human_enhance",
      arguments: { task_id: plainId, contribution: "anything" },
    });
    expect(notWarm.isError).toBe(true);
    expect((notWarm.content as { text: string }[])[0].text).toMatch(/not INCUBATING/i);

    // a human who is not a member of the task's project cannot enhance it
    const warmId = await warmTask(dana, "warm", "Outcome: ship X");
    const foreign = await olga.callTool({
      name: "human_enhance",
      arguments: { task_id: warmId, contribution: "anything" },
    });
    expect(foreign.isError).toBe(true);
    expect((foreign.content as { text: string }[])[0].text).toMatch(/not a member/i);
  });
});
