// tests/server-mediator.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openDb, type Db } from "../src/db.js";
import { betterAuthReady, seedMember } from "./helpers/auth.js";
import { discussAndWait, submitAndWait, waitForHumanJob } from "./helpers/async-human.js";
import { createApp } from "../src/server.js";
import { jobResult } from "../src/tools.js";
import { FakeDriver } from "../src/mediator/fake.js";
import type { MediatorWorker } from "../src/mediator/worker.js";
import type { AnswerInput, MediatorContext } from "../src/mediator/driver.js";
import { mergedGreenPrVerifier } from "./helpers/pr-verifier.js";

let httpServer: Server;
let baseUrl: string;
let worker: MediatorWorker;
let dbRef: Db;
const tokens: Record<string, string> = {};

beforeEach(async () => {
  dbRef = openDb(":memory:");
  await betterAuthReady(dbRef);
  await dbRef.prepare("INSERT INTO projects (id, name, repo) VALUES ('demo','Demo','x/y')").run();
  tokens["tok-h"] = (await seedMember(dbRef, { name: "dana", projectId: "demo", role: "human" })).token;
  tokens["tok-h2"] = (await seedMember(dbRef, { name: "rui", projectId: "demo", role: "human" })).token;
  tokens["tok-c"] = (await seedMember(dbRef, { name: "cc-7f2", projectId: "demo", role: "coder" })).token;
  tokens["tok-c2"] = (await seedMember(dbRef, { name: "cc-2nd", projectId: "demo", role: "coder" })).token;
  const made = createApp(dbRef, {
    driverFor: () => new FakeDriver(),
    workerOpts: { tickMs: 20, jobTimeoutMs: 2000 },
    prVerifier: mergedGreenPrVerifier(),
  });
  worker = made.worker;
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

describe("mediated flows over MCP", () => {
  it("returns a security refusal without retaining a task", async () => {
    const dana = await connect("tok-h");
    const submitted = await submitAndWait(dana, {
      title: "unsafe request", body: "REFUSE: would publish real secrets", evidence: [],
    });
    expect(submitted).toMatchObject({
      task: null,
      grooming: { action: "refuse", removed: true, rationale: "would publish real secrets" },
    });
    expect((await dbRef.prepare("SELECT COUNT(*) AS n FROM tasks").get()) as { n: number }).toEqual({ n: 0 });
    expect(await dbRef.prepare("SELECT task_id, kind FROM decision_log").get()).toEqual({
      task_id: null,
      kind: "escalate",
    });
    await dana.close();
  });

  it("human_discuss lets a human close a task conversationally", async () => {
    const dana = await connect("tok-h");
    const submitted = parse(await dana.callTool({
      name: "human_submit",
      arguments: { title: "obsolete idea", body: "b", evidence: [] },
    }));
    const taskId = submitted.task.id;
    const discussed = await discussAndWait(dana, {
      message: `close task ${taskId}: superseded by the redesign`,
    });
    expect(discussed.reply).toBe("done: 1 action(s)");
    expect(discussed.applied).toEqual([
      { action: "close_task", task_id: taskId, reason: "superseded by the redesign" },
    ]);
    expect(discussed.refused).toEqual([]);
    const status = parse(await dana.callTool({ name: "human_status", arguments: {} }));
    const task = status.projects.demo.tasks.find((t: { id: number }) => t.id === taskId);
    expect(task.state).toBe("DONE");
  });

  it("two overlapping submissions from different humans merge into one task with logged rationale", async () => {
    const dana = await connect("tok-h");
    const rui = await connect("tok-h2");
    const title = "Rate limit public API requests";
    const body = "Add a limiter for public API requests with a shared quota.";
    const first = await submitAndWait(dana, { title, body, evidence: [] });
    expect(first.grooming.action).toBe("accept");
    const second = await submitAndWait(rui, {
      title, body: `Outcome: ${body}`, evidence: [],
    });
    expect(second.grooming).toMatchObject({ action: "merge", into_task_id: first.task.id });
    expect(second.task.id).toBe(first.task.id);
    const status = parse(await dana.callTool({ name: "human_status", arguments: {} }));
    expect(status.projects.demo.tasks).toHaveLength(1);
    const decisions = await dbRef.prepare("SELECT kind, rationale FROM decision_log ORDER BY id")
      .all<{ kind: string; rationale: string }>();
    expect(decisions.map(({ kind }) => ({ kind }))).toEqual([{ kind: "create" }, { kind: "merge" }]);
    const provenance = JSON.parse(decisions[1]!.rationale.split("\n").at(-1)!);
    expect(provenance).toMatchObject({
      merged_from: { title },
    });
    // The merged task's full body must NOT be inlined into provenance (context poison).
    expect(provenance.merged_from.body).toBeUndefined();
    expect(provenance.merged_from.task_id).not.toBe(first.task.id);
    await dana.close();
    await rui.close();
  });

  it("plan review gates execution: revise then approved → PLANNED", async () => {
    const dana = await connect("tok-h");
    const coder = await connect("tok-c");
    await dana.callTool({ name: "human_submit", arguments: { title: "t", body: "b", evidence: [] } });
    const brief = parse(await coder.callTool({ name: "coder_claim_task", arguments: {} }));
    const rejected = parse(await coder.callTool({
      name: "coder_propose_plan", arguments: { task_id: brief.id, plan: "a bad plan" },
    }));
    expect(rejected).toMatchObject({ verdict: "revise", feedback: "plan flagged as bad" });
    const approved = parse(await coder.callTool({
      name: "coder_propose_plan", arguments: { task_id: brief.id, plan: "solid plan" },
    }));
    expect(approved).toMatchObject({ verdict: "approved" });
    const status = parse(await dana.callTool({ name: "human_status", arguments: {} }));
    expect(status.projects.demo.tasks[0].state).toBe("PLANNED");
    await dana.close();
    await coder.close();
  });

  it("escalated question → park → human_answer → task requeues and another explicit claim picks it up", async () => {
    const dana = await connect("tok-h");
    const coder = await connect("tok-c");
    await dana.callTool({ name: "human_submit", arguments: { title: "t", body: "b", evidence: [] } });
    const brief = parse(await coder.callTool({ name: "coder_claim_task", arguments: {} }));
    const asked = parse(await coder.callTool({
      name: "coder_ask", arguments: { task_id: brief.id, question: "please escalate: which region?" },
    }));
    expect(asked).toMatchObject({ escalated: true });
    parse(await coder.callTool({ name: "coder_park", arguments: { task_id: brief.id } }));

    const status = parse(await dana.callTool({ name: "human_status", arguments: {} }));
    expect(status.open_questions).toHaveLength(1);
    parse(await dana.callTool({
      name: "human_answer",
      arguments: { question_id: status.open_questions[0].id, answer: "eu-west-1" },
    }));

    const reclaimed = parse(await coder.callTool({ name: "coder_claim_task", arguments: {} }));
    expect(reclaimed.id).toBe(brief.id);
    expect(reclaimed.questions).toEqual([
      expect.objectContaining({ answer: "eu-west-1", status: "answered" }),
    ]);
    await dana.close();
    await coder.close();
  });

  it("progress renews without a correction payload; followup creates a groomed child after DONE", async () => {
    const dana = await connect("tok-h");
    const coder = await connect("tok-c");
    await dana.callTool({ name: "human_submit", arguments: { title: "t", body: "b", evidence: [] } });
    const brief = parse(await coder.callTool({ name: "coder_claim_task", arguments: {} }));

    const progressed = parse(await coder.callTool({
      name: "coder_progress", arguments: { task_id: brief.id, note: "working" },
    }));
    expect(progressed).not.toHaveProperty("pending_steers");

    const followupTooEarly = await dana.callTool({
      name: "human_followup", arguments: { task_id: brief.id, title: "x", body: "y", evidence: [] },
    });
    expect(followupTooEarly.isError).toBe(true);

    parse(await coder.callTool({
      name: "coder_complete",
      arguments: {
        task_id: brief.id, summary: "done",
        pr_url: "https://github.com/x/y/pull/7",
        pr_description: "Implements the task.",
        verification: "pnpm test — mediator followup path green",
      },
    }));
    const refreshGenerations = () => dbRef.prepare(
      `SELECT domain, requested_generation FROM project_context_domains
        WHERE project_id='demo'
          AND domain IN ('priorities-roadmap','architecture-tech','history-decisions-learnings')
        ORDER BY domain`,
    ).all<{ domain: string; requested_generation: number }>();
    expect((await refreshGenerations()).every((row) => row.requested_generation >= 1)).toBe(true);
    const followup = parse(await dana.callTool({
      name: "human_followup", arguments: { task_id: brief.id, title: "add per-IP limit", body: "b", evidence: [] },
    }));
    expect(followup.parent_id).toBe(brief.id);
    expect((await waitForHumanJob(dana, followup.job_id)).action).toBe("accept");

    const heartbeat = parse(await coder.callTool({ name: "coder_heartbeat", arguments: {} }));
    expect(heartbeat.queued.demo).toBe(1);
    await dana.close();
    await coder.close();
  });

  it("coder_release gives a task back with the reason in the next brief", async () => {
    const dana = await connect("tok-h");
    const coder = await connect("tok-c");
    await dana.callTool({ name: "human_submit", arguments: { title: "rust thing", body: "b", evidence: [] } });
    const brief = parse(await coder.callTool({ name: "coder_claim_task", arguments: {} }));
    const released = parse(await coder.callTool({
      name: "coder_release",
      arguments: { task_id: brief.id, reason: "out of depth: needs embedded Rust experience" },
    }));
    expect(released.state).toBe("QUEUED");
    // Release cooldown: the releasing coder is NOT re-served its own
    // give-back (release loop, observed live); another coder gets it with
    // the reason in the brief.
    const selfReclaim = parse(await coder.callTool({ name: "coder_claim_task", arguments: {} }));
    expect(selfReclaim).toBeNull();
    const other = await connect("tok-c2");
    const reclaimed = parse(await other.callTool({ name: "coder_claim_task", arguments: {} }));
    expect(reclaimed.id).toBe(brief.id);
    expect(reclaimed.attempts).toEqual([
      { agent: "cc-7f2-cc-7f2", outcome: "released", notes: "out of depth: needs embedded Rust experience" },
    ]);
    await other.close();
    await dana.close();
    await coder.close();
  });

  it("coder_block lands in needs-you as an open question; answering requeues the task", async () => {
    const dana = await connect("tok-h");
    const coder = await connect("tok-c");
    await dana.callTool({ name: "human_submit", arguments: { title: "t", body: "b", evidence: [] } });
    const brief = parse(await coder.callTool({ name: "coder_claim_task", arguments: {} }));
    parse(await coder.callTool({
      name: "coder_block", arguments: { task_id: brief.id, reason: "staging db is gone" },
    }));

    const status = parse(await dana.callTool({ name: "human_status", arguments: {} }));
    expect(status.open_questions).toEqual([
      expect.objectContaining({
        task_id: brief.id, asked_by: "cc-7f2-cc-7f2",
        question: "blocked: staging db is gone — what should happen?",
      }),
    ]);
    expect(status.attention_alerts).toEqual([
      expect.objectContaining({ episode_id: `question:${status.open_questions[0].id}`, task_id: brief.id }),
    ]);
    parse(await dana.callTool({
      name: "human_answer",
      arguments: { question_id: status.open_questions[0].id, answer: "use the seeded local db" },
    }));
    expect(parse(await dana.callTool({ name: "human_status", arguments: {} })).attention_alerts).toEqual([]);
    const reclaimed = parse(await coder.callTool({ name: "coder_claim_task", arguments: {} }));
    expect(reclaimed.id).toBe(brief.id);
    expect(reclaimed.questions).toEqual([
      expect.objectContaining({ answer: "use the seeded local db", status: "answered" }),
    ]);
    await dana.close();
    await coder.close();
  });

  it("an infrastructure block returns to the coder queue without a human answer", async () => {
    const dana = await connect("tok-h");
    const coder = await connect("tok-c");
    await dana.callTool({ name: "human_submit", arguments: { title: "t", body: "b", evidence: [] } });
    const brief = parse(await coder.callTool({ name: "coder_claim_task", arguments: {} }));
    const blocked = parse(await coder.callTool({
      name: "coder_block",
      arguments: {
        task_id: brief.id,
        reason: "model endpoint returned 404",
        kind: "infra_failure",
        retry_after_ms: 1_000,
      },
    }));
    expect(blocked).toMatchObject({ state: "BLOCKED", block_kind: "infra_failure" });
    expect(parse(await dana.callTool({ name: "human_status", arguments: {} })).open_questions).toEqual([]);

    const deadline = Date.now() + 3_000;
    let state = "BLOCKED";
    while (state === "BLOCKED" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      state = (await dbRef.prepare("SELECT state FROM tasks WHERE id=?").get<{ state: string }>(brief.id))!.state;
    }
    expect(state).toBe("QUEUED");
    const other = await connect("tok-c2");
    const reclaimed = parse(await other.callTool({ name: "coder_claim_task", arguments: {} }));
    expect(reclaimed).toMatchObject({
      id: brief.id,
      block_kind: null,
      block_requeue_at: null,
      attempts: expect.arrayContaining([
        expect.objectContaining({ outcome: "released", notes: expect.stringContaining("infrastructure retry") }),
      ]),
    });
    await other.close();
    await dana.close();
    await coder.close();
  });

  it("jobResult pending shape teaches re-enter + no coding; terminal shapes attach instruction", () => {
    const pending = jobResult(
      { status: "running", result: null, error: null, id: 5 },
      { loop: "plan_review" },
    );
    expect(pending).toMatchObject({
      status: "pending",
      job_id: 5,
      loop: "plan_review",
      poll_after_ms: 2000,
      wait_s_default: 15,
      wait_s_max: 90,
      next: { tool: "coder_propose_plan", mode: "reenter_same" },
    });
    expect(String((pending as { instruction: string }).instruction)).toMatch(/Do NOT implement/i);
    expect(String((pending as { note: string }).note)).toMatch(/SAME arguments|same arguments/i);

    const approved = jobResult(
      { status: "done", result: JSON.stringify({ verdict: "approved", feedback: "" }), error: null, id: 6 },
      { loop: "plan_review" },
    );
    expect(approved).toMatchObject({
      verdict: "approved",
      instruction: expect.stringMatching(/Implement now/i),
    });

    const revise = jobResult(
      { status: "done", result: JSON.stringify({ verdict: "revise", feedback: "more detail" }), error: null, id: 7 },
      { loop: "plan_review" },
    );
    expect(revise).toMatchObject({
      verdict: "revise",
      instruction: expect.stringMatching(/Do NOT implement/i),
    });
  });

  it("mediatorWaitMs defaults review short and honors wait_s cap", async () => {
    const { mediatorWaitMs } = await import("../src/tools.js");
    expect(mediatorWaitMs("MEMRACER_REVIEW_WAIT_MS")).toBe(15_000);
    expect(mediatorWaitMs("MEMRACER_GROOM_WAIT_MS")).toBe(60_000);
    expect(mediatorWaitMs("MEMRACER_REVIEW_WAIT_MS", 5)).toBe(5_000);
    expect(mediatorWaitMs("MEMRACER_REVIEW_WAIT_MS", 999)).toBe(90_000);
  });

  it("coder_ask retried while the mediator is still working reuses the pending job", async () => {
    const db2 = openDb(":memory:");
    await betterAuthReady(db2);
    await db2.prepare("INSERT INTO projects (id, name) VALUES ('demo','Demo')").run();
    const tokH2 = (await seedMember(db2, { name: "dana", projectId: "demo", role: "human" })).token;
    const tokC2 = (await seedMember(db2, { name: "cc-7f2", projectId: "demo", role: "coder" })).token;
    let answerCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const base = new FakeDriver();
    const slowDriver = {
      groom: base.groom.bind(base),
      review: base.review.bind(base),
      discuss: base.discuss.bind(base),
      answer: async (ctx: MediatorContext, input: AnswerInput) => {
        answerCalls += 1;
        await gate;
        return base.answer(ctx, input);
      },
    };
    const made = createApp(db2, { driverFor: () => slowDriver, workerOpts: { tickMs: 20, jobTimeoutMs: 5000 } });
    const server2: Server = await new Promise((resolve) => {
      const s = made.app.listen(0, () => resolve(s));
    });
    const url = `http://127.0.0.1:${(server2.address() as AddressInfo).port}/mcp`;
    const clientFor = async (token: string) => {
      const c = new Client({ name: "test", version: "0.0.1" });
      await c.connect(new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }));
      return c;
    };
    try {
      const dana = await clientFor(tokH2);
      const coder = await clientFor(tokC2);
      await dana.callTool({ name: "human_submit", arguments: { title: "t", body: "b", evidence: [] } });
      const brief = parse(await coder.callTool({ name: "coder_claim_task", arguments: {} }));
      const args = { task_id: brief.id, question: "life?" };
      const first = coder.callTool({ name: "coder_ask", arguments: args });
      // let the first ask enqueue its job and start the (gated) handler
      while (answerCalls === 0) await new Promise((r) => setTimeout(r, 10));
      const second = coder.callTool({ name: "coder_ask", arguments: args });
      await new Promise((r) => setTimeout(r, 50));
      release();
      const [r1, r2] = await Promise.all([first, second]);
      expect(parse(r1)).toMatchObject({ escalated: false, answer: "42" });
      expect(parse(r2)).toMatchObject({ escalated: false, answer: "42" });
      expect(answerCalls).toBe(1);
      expect(await db2.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind='answer'").get()).toEqual({ n: 1 });
      await dana.close();
      await coder.close();
    } finally {
      made.worker.stop();
      await new Promise<void>((resolve) => server2.close(() => resolve()));
    }
  });

  it("coder_complete enqueues a reconcile job; the PR text closes a redundant task", async () => {
    const dana = await connect("tok-h");
    const coder = await connect("tok-c");
    await dana.callTool({ name: "human_submit", arguments: { title: "add limiter", body: "b", evidence: [] } });
    const redundant = parse(await dana.callTool({
      name: "human_submit", arguments: { title: "throttle api", body: "b", evidence: [] },
    })).task.id;
    const brief = parse(await coder.callTool({ name: "coder_claim_task", arguments: {} }));
    parse(await coder.callTool({
      name: "coder_complete",
      arguments: {
        task_id: brief.id, summary: "shipped",
        pr_url: "https://github.com/x/y/pull/3",
        pr_description: `Adds the limiter. close task ${redundant}: absorbed by this PR`,
        verification: "pnpm test — reconcile close-by-PR green",
      },
    }));
    const refreshGenerations = () => dbRef.prepare(
      `SELECT domain, requested_generation FROM project_context_domains
        WHERE project_id='demo'
          AND domain IN ('priorities-roadmap','architecture-tech','history-decisions-learnings')
        ORDER BY domain`,
    ).all<{ domain: string; requested_generation: number }>();
    expect((await refreshGenerations()).every((row) => row.requested_generation >= 1)).toBe(true);
    const job = (await dbRef
      .prepare("SELECT id FROM jobs WHERE kind='reconcile' ORDER BY id DESC LIMIT 1")
      .get()) as { id: number } | undefined;
    expect(job).toBeDefined();
    await worker.waitForJob(job!.id, 3000);
    const status = parse(await dana.callTool({ name: "human_status", arguments: {} }));
    const other = status.projects.demo.tasks.find((t: { id: number }) => t.id === redundant);
    expect(other.state).toBe("DONE");
    expect((await refreshGenerations()).every((row) => row.requested_generation >= 2)).toBe(true);
    await dana.close();
    await coder.close();
  });
});
