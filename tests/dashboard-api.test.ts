// tests/dashboard-api.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { openDb, type Db } from "../src/db.js";
import { betterAuthReady, seedMember } from "./helpers/auth.js";
import { createApp } from "../src/server.js";
import { Queue, DEFAULT_LEASE_TTL_MS } from "../src/queue.js";
import { FakeDriver } from "../src/mediator/fake.js";
import type { MediatorWorker } from "../src/mediator/worker.js";

let httpServer: Server;
let baseUrl: string;
let worker: MediatorWorker;
let queue: Queue;
let dbRef: Db;
const tokens: Record<string, string> = {};

beforeEach(async () => {
  dbRef = openDb(":memory:");
  await betterAuthReady(dbRef);
  const project = dbRef.prepare("INSERT INTO projects (id, name, repo) VALUES (?, ?, ?)");
  await project.run("p1", "Project One", "acme/one");
  await project.run("p2", "Project Two", null);
  tokens["tok-a"] = (await seedMember(dbRef, { name: "ada", projectId: "p1", projectName: "Project One", role: "human" })).token;
  tokens["tok-b"] = (await seedMember(dbRef, { name: "bob", projectId: "p2", projectName: "Project Two", role: "human" })).token;
  const made = createApp(dbRef, {
    driverFor: () => new FakeDriver(),
    workerOpts: { tickMs: 20, jobTimeoutMs: 2000 },
    sseKeepaliveMs: 40,
  });
  worker = made.worker;
  queue = made.queue;
  await new Promise<void>((resolve) => {
    httpServer = made.app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterEach(async () => {
  worker.stop();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

function get(path: string, token?: string): Promise<Response> {
  const bearer = token ? (tokens[token] ?? token) : undefined;
  return fetch(`${baseUrl}${path}`, {
    headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
  });
}

async function connectCoder(token: string): Promise<Client> {
  const client = new Client({ name: "dashboard-api-test", version: "0.0.1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  return client;
}

function parseTool(result: { content?: unknown }): Record<string, unknown> {
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

/** submit → groom → claim → propose bad plan (revise) on p1; returns task id. */
async function driveMediatedFlow(): Promise<number> {
  const taskId = await queue.submit("p1", "ada", {
    title: "Rate limit ingest",
    body: "add limiter",
    evidence: [{ kind: "log", snippet: "429s everywhere" }],
  });
  await worker.waitForJob(await worker.enqueue("p1", "groom", { taskId, submittedBy: "ada" }), 3000);
  await queue.claimNext("p1", "cc-1", DEFAULT_LEASE_TTL_MS);
  await worker.waitForJob(
    await worker.enqueue("p1", "review", { taskId, plan: "a bad plan", agent: "cc-1" }),
    3000,
  );
  return taskId;
}

describe("dashboard API auth and scoping", () => {
  it("401 without a token, with a bad token, and with a bare header", async () => {
    expect((await get("/api/projects")).status).toBe(401);
    expect((await get("/api/projects", "nope")).status).toBe(401);
    expect((await get("/api/p/p1/queue")).status).toBe(401);
    const bare = await fetch(`${baseUrl}/api/projects`, { headers: { Authorization: "tok-a" } });
    expect(bare.status).toBe(401);
  });

  it("GET /api/projects returns only the member's memberships", async () => {
    const res = await get("/api/projects", "tok-a");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.projects).toEqual([
      { projectId: "p1", projectName: "Project One", repo: "acme/one", role: "human", orgId: null, orgName: null },
    ]);
  });

  it("requesting another project's data is a 404, not a 403", async () => {
    for (const path of ["queue", "agents", "threads", "decisions", "threads/1", "questions", "tasks/1", "tasks/1/timeline", "warming", "knowledge", "knowledge/activity", "knowledge/doc?path=decisions/x.md", "team", "analytics"]) {
      const res = await get(`/api/p/p2/${path}`, "tok-a");
      expect(res.status, path).toBe(404);
    }
  });

  it("a thread id from another project 404s even through an authorized project path", async () => {
    // create a thread in p2 via a groomed submission
    const tid = await queue.submit("p2", "bob", { title: "t", body: "b", evidence: [] });
    await worker.waitForJob(await worker.enqueue("p2", "groom", { taskId: tid, submittedBy: "bob" }), 3000);
    const threads = await (await get("/api/p/p2/threads", "tok-b")).json();
    expect(threads.threads.length).toBe(2); // submission root + groom
    const foreignThreadId = threads.threads[0].id;
    const res = await get(`/api/p/p1/threads/${foreignThreadId}`, "tok-a");
    expect(res.status).toBe(404);
  });

  it("terminal errors hide stack traces and internal messages", async () => {
    const originalPrepare = dbRef.prepare.bind(dbRef);
    dbRef.prepare = ((sql: string) => {
      // Queue list SQL joins parent for lineage; match either shape.
      if (
        sql.includes("FROM tasks t WHERE t.project_id")
        || (sql.includes("FROM tasks t") && sql.includes("LEFT JOIN tasks p") && sql.includes("t.project_id"))
      ) {
        throw new Error("secret-stack-token");
      }
      return originalPrepare(sql);
    }) as Db["prepare"];
    try {
      const response = await get("/api/p/p1/queue", "tok-a");
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "internal server error" });
    } finally {
      dbRef.prepare = originalPrepare;
    }
  });
});

describe("dashboard API payloads", () => {
  it("queue: all states with evidence counts and lease info", async () => {
    const taskId = await driveMediatedFlow();
    const body = await (await get("/api/p/p1/queue", "tok-a")).json();
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0]).toMatchObject({
      id: taskId,
      title: "Rate limit ingest",
      state: "CLAIMED",
      priority: 2,
      evidence_count: 1,
      lease_agent: "cc-1",
      submitted_by: "ada",
    });
    expect(body.tasks[0].lease_expires_at).toBeGreaterThan(Date.now());
    expect(body.overview.window.label).toBe("last 7 days");
    expect(body.overview.transitions[0]).toMatchObject({
      task_id: taskId,
      title: "Rate limit ingest",
      from_state: "QUEUED",
      to_state: "CLAIMED",
    });
    expect(body.overview.trends).toMatchObject({ open: 0, active: 1, ready: -1, done: 0 });
  });

  it("queue: a blocked task carries its latest attempt note", async () => {
    const taskId = await driveMediatedFlow();
    await queue.block(taskId, "cc-1", "stuck on migration");
    const body = await (await get("/api/p/p1/queue", "tok-a")).json();
    expect(body.tasks[0]).toMatchObject({
      id: taskId,
      state: "BLOCKED",
      latest_attempt_note: "stuck on migration",
    });
  });

  it("queue and task detail surface parent lineage for follow-ups", async () => {
    const parentId = await queue.submit("p1", "Aaron", {
      title: "Org switcher",
      body: "feature",
      evidence: [],
    });
    // Filer differs from origin author; queue.submit credits the parent.
    const childId = await queue.submit("p1", "andrew", {
      title: "Org-switcher polish",
      body: "followup",
      evidence: [],
      parentId,
    });
    const queueBody = await (await get("/api/p/p1/queue", "tok-a")).json();
    const childRow = queueBody.tasks.find((task: { id: number }) => task.id === childId);
    expect(childRow).toMatchObject({
      id: childId,
      submitted_by: "Aaron",
      parent_id: parentId,
      parent_title: "Org switcher",
      parent_submitted_by: "Aaron",
    });
    const detail = await (await get(`/api/p/p1/tasks/${childId}`, "tok-a")).json();
    expect(detail).toMatchObject({
      id: childId,
      submitted_by: "Aaron",
      parent_id: parentId,
      parent_title: "Org switcher",
      parent_submitted_by: "Aaron",
    });
  });

  it("queue and task detail expose PR number and verification for in-flight merge work", async () => {
    const taskId = await driveMediatedFlow();
    const now = Date.now();
    await dbRef.prepare(
      `UPDATE tasks SET state = 'AWAITING_MERGE',
                          result_pr_url = ?, result_pr_number = ?, pr_verification = ?,
                          result_summary = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      "https://github.com/acme/one/pull/42",
      42,
      "checks-pending",
      "awaiting merge\n\nverification: pnpm test",
      now,
      taskId,
    );

    const queueBody = await (await get("/api/p/p1/queue", "tok-a")).json();
    const row = queueBody.tasks.find((task: { id: number }) => task.id === taskId);
    expect(row).toMatchObject({
      id: taskId,
      state: "AWAITING_MERGE",
      result_pr_url: "https://github.com/acme/one/pull/42",
      result_pr_number: 42,
      pr_verification: "checks-pending",
    });

    const detail = await (await get(`/api/p/p1/tasks/${taskId}`, "tok-a")).json();
    expect(detail).toMatchObject({
      id: taskId,
      result_pr_url: "https://github.com/acme/one/pull/42",
      result_pr_number: 42,
      pr_verification: "checks-pending",
    });
  });

  it("queue projects hold_cause for HELD tasks", async () => {
    const taskId = await queue.submit("p1", "ada", { title: "Parked work", body: "b", evidence: [] });
    await dbRef.prepare("UPDATE tasks SET state='HELD', hold_cause='explicit' WHERE id=?").run(taskId);
    const body = await (await get("/api/p/p1/queue", "tok-a")).json();
    const row = body.tasks.find((task: { id: number }) => task.id === taskId);
    expect(row).toMatchObject({ id: taskId, state: "HELD", hold_cause: "explicit" });
  });

  it("queue: system-domain blocked tasks never leak raw attempt diagnostics", async () => {
    const taskId = await driveMediatedFlow();
    await queue.block(taskId, "cc-1", "set MEMRACER_GITHUB_TOKEN or authenticate gh on the host", {
      kind: "infra_failure",
      retryAfterMs: 60_000,
    });
    const body = await (await get("/api/p/p1/queue", "tok-a")).json();
    const row = body.tasks.find((task: { id: number }) => task.id === taskId);
    expect(row).toMatchObject({ id: taskId, state: "BLOCKED" });
    expect(row.latest_attempt_note).toBe("Blocked on infrastructure — an operator will retry.");
    expect(JSON.stringify(body.tasks)).not.toMatch(/MEMRACER_GITHUB_TOKEN|authenticate gh/i);

    const detail = await (await get(`/api/p/p1/tasks/${taskId}`, "tok-a")).json();
    const blockedAttempt = detail.attempts.find((a: { outcome: string }) => a.outcome === "blocked");
    expect(blockedAttempt?.notes).toBe("Blocked on infrastructure — an operator will retry.");
    expect(JSON.stringify(detail.attempts)).not.toMatch(/MEMRACER_GITHUB_TOKEN|authenticate gh/i);
  });

  it("queue keyset pages preserve operational order and overview truth", async () => {
    const first = await queue.submit("p1", "ada", { title: "first", body: "b", priority: 0, evidence: [] });
    const second = await queue.submit("p1", "ada", { title: "second", body: "b", priority: 1, evidence: [] });
    await queue.submit("p1", "ada", { title: "third", body: "b", priority: 2, evidence: [] });
    const page1 = await (await get("/api/p/p1/queue?limit=1", "tok-a")).json();
    expect(page1.tasks.map((task: { id: number }) => task.id)).toEqual([first]);
    expect(page1.next_cursor).toBeTypeOf("string");
    expect(page1.overview.current).toEqual({ open: 3, active: 0, ready: 3, done: 0 });
    const page2 = await (await get(`/api/p/p1/queue?limit=1&cursor=${encodeURIComponent(page1.next_cursor)}`, "tok-a")).json();
    expect(page2.tasks.map((task: { id: number }) => task.id)).toEqual([second]);
    expect(page2.overview.trends).toEqual(page1.overview.trends);
    expect(page2.overview.transitions).toEqual(page1.overview.transitions);
  });

  it("queue omits completed tasks without changing the overview totals", async () => {
    const open = await queue.submit("p1", "ada", { title: "still open", body: "b", evidence: [] });
    const done = await queue.submit("p1", "ada", { title: "already done", body: "b", evidence: [] });
    await dbRef.prepare("UPDATE tasks SET state = 'DONE', updated_at = ? WHERE id = ?").run(Date.now(), done);

    const body = await (await get("/api/p/p1/queue", "tok-a")).json();
    expect(body.tasks.map((task: { id: number }) => task.id)).toEqual([open]);
    expect(body.overview.current).toEqual({ open: 1, active: 0, ready: 1, done: 1 });
  });

  it("tasks/done is project-scoped, searchable with literal LIKE text, and offset-paginated", async () => {
    const oldest = await queue.submit("p1", "ada", { title: "ordinary archive", body: "old", evidence: [] });
    const special = await queue.submit("p1", "ada_100%", { title: "literal %_\\ archive", body: "special", evidence: [] });
    const newest = await queue.submit("p1", "ada", { title: "newest archive", body: "new", evidence: [] });
    const open = await queue.submit("p1", "ada", { title: "not archived", body: "open", evidence: [] });
    const foreign = await queue.submit("p2", "bob", { title: "foreign archive", body: "foreign", evidence: [] });
    for (const [id, updated] of [[oldest, 100], [special, 200], [newest, 300], [foreign, 400]] as const) {
      await dbRef.prepare("UPDATE tasks SET state = 'DONE', updated_at = ? WHERE id = ?").run(updated, id);
    }

    // Ship PR metadata on one DONE row so archive rows can show TaskPrStatus.
    await dbRef
      .prepare(
        `UPDATE tasks SET result_pr_url = ?, result_pr_number = ?, pr_verification = ? WHERE id = ?`,
      )
      .run("https://github.com/x/y/pull/42", 42, "merged-green", newest);

    const first = await (await get("/api/p/p1/tasks/done?limit=2&offset=0", "tok-a")).json();
    expect(first).toMatchObject({ offset: 0, limit: 2, next_offset: 2 });
    expect(first.tasks.map((task: { id: number }) => task.id)).toEqual([newest, special]);
    expect(first.tasks.every((task: { state: string }) => task.state === "DONE")).toBe(true);
    expect(Object.keys(first.tasks[0]).sort()).toEqual([
      "id",
      "pr_verification",
      "result_pr_number",
      "result_pr_url",
      "state",
      "submitted_by",
      "title",
      "updated_at",
    ]);
    expect(first.tasks[0]).toMatchObject({
      id: newest,
      result_pr_url: "https://github.com/x/y/pull/42",
      result_pr_number: 42,
      pr_verification: "merged-green",
    });
    expect(first.tasks[1]).toMatchObject({
      id: special,
      result_pr_url: null,
      result_pr_number: null,
      pr_verification: null,
    });
    expect(first.tasks.some((task: { id: number }) => task.id === open || task.id === foreign)).toBe(false);

    const second = await (await get("/api/p/p1/tasks/done?limit=2&offset=2", "tok-a")).json();
    expect(second.tasks.map((task: { id: number }) => task.id)).toEqual([oldest]);
    expect(second.next_offset).toBeNull();

    const literal = await (await get(`/api/p/p1/tasks/done?q=${encodeURIComponent("%_\\")}`, "tok-a")).json();
    expect(literal.tasks.map((task: { id: number }) => task.id)).toEqual([special]);
    const submitter = await (await get(`/api/p/p1/tasks/done?q=${encodeURIComponent("ada_100%")}`, "tok-a")).json();
    expect(submitter.tasks.map((task: { id: number }) => task.id)).toEqual([special]);
    const byHashId = await (await get(`/api/p/p1/tasks/done?q=${encodeURIComponent(`#${oldest}`)}`, "tok-a")).json();
    expect(byHashId.tasks.map((task: { id: number }) => task.id)).toEqual([oldest]);

    const bounded = await (await get("/api/p/p1/tasks/done?limit=999&offset=-5", "tok-a")).json();
    expect(bounded).toMatchObject({ offset: 0, limit: 200, next_offset: null });
  });

  it("questions: paginates open first (newest-first), then answered", async () => {
    const taskId = await queue.submit("p1", "ada", { title: "host task", body: "b", evidence: [] });
    const now = Date.now();
    const ins = dbRef.prepare(
      `INSERT INTO questions (project_id, task_id, asked_by, question, answer, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let i = 0; i < 12; i++) {
      await ins.run("p1", taskId, "mediator", `answered ${i}`, `reply ${i}`, "answered", now - 1000 + i);
    }
    await ins.run("p1", taskId, "cc-1", "open older", null, "open", now);
    await ins.run("p1", taskId, "mediator", "open newer", null, "open", now + 1);
    // a question on another project must not leak in
    const foreign = await queue.submit("p2", "bob", { title: "x", body: "y", evidence: [] });
    await ins.run("p2", foreign, "mediator", "foreign q", null, "open", now);
    const body = await (await get("/api/p/p1/questions?limit=12", "tok-a")).json();
    expect(body.questions).toHaveLength(12);
    expect(body.questions[0]).toMatchObject({
      task_id: taskId,
      task_title: "host task",
      asked_by: "mediator",
      question: "open newer",
      answer: null,
      status: "open",
    });
    expect(body.questions[0].id).toBeTypeOf("number");
    expect(body.questions[0].created_at).toBeTypeOf("number");
    expect(body.questions[1].question).toBe("open older");
    const answered = body.questions.slice(2);
    expect(answered.every((q: { status: string }) => q.status === "answered")).toBe(true);
    expect(answered[0].question).toBe("answered 11");
    expect(answered[9].question).toBe("answered 2");
    expect(body.next_cursor).toBeTypeOf("string");
    const next = await (await get(`/api/p/p1/questions?limit=12&cursor=${encodeURIComponent(body.next_cursor)}`, "tok-a")).json();
    expect(next.questions.map((q: { question: string }) => q.question)).toEqual(["answered 1", "answered 0"]);
    expect(next.next_cursor).toBeNull();
    await ins.run("p1", taskId, "mediator", "who answered?", null, "open", now + 2);
    const attributed = await dbRef.prepare("SELECT id FROM questions WHERE question='who answered?'").get<{ id: number }>();
    if (!attributed) throw new Error("attributed question was not inserted");
    await queue.answerQuestion(attributed.id, "ada's answer", "Ada Human");
    expect(await dbRef.prepare("SELECT answer, answered_by FROM questions WHERE id=?").get(attributed.id)).toEqual({ answer: "ada's answer", answered_by: "Ada Human" });
    const attributedPage = await (await get("/api/p/p1/questions?limit=20", "tok-a")).json();
    expect(attributedPage.questions.find((question: { question: string }) => question.question === "who answered?")).toMatchObject({ status: "answered", answered_by: "Ada Human" });
  });

  it("tasks/:id: the full brief plus threads and decisions for that task", async () => {
    const taskId = await driveMediatedFlow();
    const res = await get(`/api/p/p1/tasks/${taskId}`, "tok-a");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      id: taskId,
      title: "Rate limit ingest",
      state: "CLAIMED",
      submitted_by: "ada",
      lease_agent: "cc-1",
      grooming_rationale: "accepted as submitted",
    });
    expect(body.evidence).toEqual([
      expect.objectContaining({ id: expect.any(Number), kind: "log", snippet: "429s everywhere" }),
    ]);
    expect(body.attempts).toEqual([]);
    expect(body.questions).toEqual([]);
    expect(body.threads.map((t: { kind: string }) => t.kind).sort()).toEqual(["groom", "review", "submission"]);
    expect(body.threads[0].id).toBeTypeOf("number");
    // Groom/review children point at the root; the root itself has root_id null.
    expect(body.threads.filter((thread: { kind: string }) => thread.kind !== "submission")
      .every((thread: { root_id: number | null }) => thread.root_id === body.root_thread_id)).toBe(true);
    expect(body.threads[0].created_at).toBeTypeOf("number");
    expect(body.decisions.map((d: { kind: string }) => d.kind)).toEqual(["revise", "create"]);
    expect(body.decisions[0]).toMatchObject({ summary: `revision requested on task ${taskId}` });
    expect(body.decisions[0].citations).toEqual([]);
    expect(body.grooming_citations).toEqual([]);
  });

  it("tasks/:id surfaces a root submission thread even when threads.task_id is NULL (#499)", async () => {
    const taskId = await queue.submit("p1", "ada", {
      title: "Orphan root repro",
      body: "submission should still show",
      evidence: [],
    });
    const rootId = (await dbRef.prepare("SELECT root_thread_id AS r FROM tasks WHERE id=?").get<{ r: number }>(taskId))!.r;
    // Simulate the legacy orphan: root_thread_id set, threads.task_id NULL.
    await dbRef.prepare("UPDATE threads SET task_id=NULL WHERE id=?").run(rootId);
    // Also drop any groom-linked threads so only the orphan root remains.
    await dbRef.prepare("DELETE FROM threads WHERE task_id=? AND id<>?").run(taskId, rootId);

    const body = await (await get(`/api/p/p1/tasks/${taskId}`, "tok-a")).json();
    expect(body.root_thread_id).toBe(rootId);
    expect(body.threads).toEqual([
      expect.objectContaining({ id: rootId, kind: "submission" }),
    ]);
  });

  it("tasks/:id presents project-scoped API-key actors without changing stored lease identity", async () => {
    const coderSeat = await seedMember(dbRef, {
      name: "Readable Coder",
      projectId: "p1",
      projectName: "Project One",
      role: "coder",
    });
    await dbRef.prepare('UPDATE "user" SET name = ? WHERE id = ?').run("Coder Seat Owner", coderSeat.userId);
    const actorLabel = "Coder Seat Owner-Readable Coder";
    const foreignSeat = await seedMember(dbRef, {
      name: "Foreign Coder",
      projectId: "p2",
      projectName: "Project Two",
      role: "coder",
    });
    const taskId = await queue.submit("p1", "ada", {
      title: "Present verified coder identity",
      body: "Keep the key id as authority and show its seat name.",
      priority: 0,
      evidence: [],
    });
    const coder = await connectCoder(coderSeat.token);
    try {
      const claimed = parseTool(await coder.callTool({
        name: "coder_claim_task",
        arguments: { project: "p1" },
      }));
      expect(claimed).toMatchObject({ id: taskId, lease_agent: actorLabel });
      expect(await dbRef.prepare("SELECT lease_agent FROM tasks WHERE id = ?").get(taskId)).toEqual({
        lease_agent: coderSeat.keyId,
      });

      await coder.callTool({
        name: "coder_block",
        arguments: { task_id: taskId, reason: "Need a confirmed retry" },
      });
      const seatQuestion = await dbRef
        .prepare("SELECT id FROM questions WHERE task_id = ? AND asked_by = ?")
        .get<{ id: number }>(taskId, coderSeat.keyId);
      expect(seatQuestion).toBeDefined();
      await queue.answerQuestion(seatQuestion!.id, "Retry now", "ada");
      const reclaimed = parseTool(await coder.callTool({
        name: "coder_claim_task",
        arguments: { project: "p1" },
      }));
      expect(reclaimed).toMatchObject({ id: taskId, lease_agent: actorLabel });

      const queueBody = await (await get("/api/p/p1/queue", "tok-a")).json();
      expect(queueBody.tasks.find((task: { id: number }) => task.id === taskId).lease_agent).toBe(actorLabel);
      const agentsBody = await (await get("/api/p/p1/agents", "tok-a")).json();
      expect(agentsBody.agents).toContainEqual(expect.objectContaining({ task_id: taskId, agent: actorLabel }));

      const insertQuestion = dbRef.prepare(
        `INSERT INTO questions (project_id, task_id, asked_by, question, status, created_at)
         VALUES ('p1', ?, ?, ?, 'open', ?)`,
      );
      await insertQuestion.run(taskId, "mediator", "Mediator question", Date.now());
      await insertQuestion.run(taskId, "ada", "Human question", Date.now() + 1);
      await insertQuestion.run(taskId, "legacy-coder", "Legacy question", Date.now() + 2);
      await insertQuestion.run(taskId, foreignSeat.keyId, "Foreign key question", Date.now() + 3);

      const detail = await (await get(`/api/p/p1/tasks/${taskId}`, "tok-a")).json();
      expect(detail).toMatchObject({
        id: taskId,
        submitted_by: "ada",
        lease_agent: actorLabel,
        attempts: [expect.objectContaining({ agent: actorLabel, outcome: "blocked" })],
      });
      expect(detail.questions.map((question: { asked_by: string }) => question.asked_by)).toEqual([
        actorLabel,
        "mediator",
        "ada",
        "legacy-coder",
        foreignSeat.keyId,
      ]);
    } finally {
      await coder.close();
    }
  });

  it("returns parsed decision citations from task, timeline, and decision feeds", async () => {
    const taskId = await driveMediatedFlow();
    const evidence = (await queue.brief(taskId)).evidence[0];
    const citations = [{ type: "evidence", id: evidence.id, url: `${baseUrl}/dashboard?task=${taskId}#evidence-${evidence.id}`, label: `EVID-${evidence.id}` }];
    await dbRef.prepare("UPDATE decision_log SET citations=? WHERE task_id=? AND kind='create'").run(JSON.stringify(citations), taskId);

    const detail = await (await get(`/api/p/p1/tasks/${taskId}`, "tok-a")).json();
    expect(detail.grooming_citations).toEqual(citations);
    expect(detail.decisions.find((decision: { kind: string }) => decision.kind === "create").citations).toEqual(citations);
    const timeline = await (await get(`/api/p/p1/tasks/${taskId}/timeline`, "tok-a")).json();
    expect(timeline.evidence).toEqual([expect.objectContaining({ id: evidence.id })]);
    expect(timeline.timeline.find((item: { type?: string }) => item.type === "evidence")).toMatchObject({
      kind: "event",
      type: "evidence",
      evidence_id: evidence.id,
      evidence_kind: evidence.kind,
      created_at: detail.created_at,
    });
    expect(timeline.timeline.find((item: { decision_kind?: string }) => item.decision_kind === "create").citations).toEqual(citations);
    const feed = await (await get("/api/p/p1/decisions", "tok-a")).json();
    expect(feed.decisions.find((decision: { kind: string }) => decision.kind === "create").citations).toEqual(citations);
  });

  it("tasks/:id carries persisted progress notes for the replay pane", async () => {
    const taskId = await driveMediatedFlow();
    await queue.progress(taskId, "cc-1", "tests written; starting impl", DEFAULT_LEASE_TTL_MS);
    const body = await (await get(`/api/p/p1/tasks/${taskId}`, "tok-a")).json();
    expect(body.notes).toEqual([
      expect.objectContaining({ agent: "cc-1", note: "tests written; starting impl" }),
    ]);
    expect(body.notes[0].created_at).toBeTypeOf("number");
  });

  it("tasks/:id 404s for a foreign or unknown task via an authorized project path", async () => {
    const foreign = await queue.submit("p2", "bob", { title: "t", body: "b", evidence: [] });
    expect((await get(`/api/p/p1/tasks/${foreign}`, "tok-a")).status).toBe(404);
    expect((await get("/api/p/p1/tasks/9999", "tok-a")).status).toBe(404);
  });

  it("agents: live leases plus queued depth", async () => {
    const taskId = await driveMediatedFlow();
    await queue.submit("p1", "ada", { title: "second", body: "queued", evidence: [] });
    const body = await (await get("/api/p/p1/agents", "tok-a")).json();
    expect(body.agents).toEqual([
      expect.objectContaining({
        agent: "cc-1",
        task_id: taskId,
        title: "Rate limit ingest",
        state: "CLAIMED",
      }),
    ]);
    expect(body.agents[0].lease_expires_at).toBeGreaterThan(Date.now());
    expect(body.queued).toBe(1);
  });

  it("threads: list with previews, transcript with roles; the revise 'why' is readable", async () => {
    const taskId = await driveMediatedFlow();
    const list = await (await get("/api/p/p1/threads", "tok-a")).json();
    expect(list.threads).toHaveLength(3); // submission root + groom + review, newest first
    expect(list.threads[0]).toMatchObject({
      kind: "review", task_id: taskId, task_title: "Rate limit ingest", task_state: "CLAIMED",
      first_human_message: null, last_author: "mediator", last_role: "mediator",
    });
    expect(list.threads[0].first_message).toContain("a bad plan");
    expect(list.threads[0].last_message).toContain("revise");
    expect(list.threads[1]).toMatchObject({ kind: "groom", task_id: taskId, task_title: "Rate limit ingest" });
    expect(list.threads[2]).toMatchObject({ kind: "submission", task_id: taskId, root_id: null });
    // root_id in every row: the UI groups by root_id, sections per task id,
    // messages by (thread_id, id) — monotonic ids, never timestamps
    const rootId = list.threads[2].id;
    expect(list.threads[0].root_id).toBe(rootId);
    expect(list.threads[1].root_id).toBe(rootId);
    // last_activity: the newest message timestamp, so the UI can default-select
    // and pin-hop to the thread that most recently received a message.
    expect(list.threads[0].last_activity).toBeTypeOf("number");
    expect(list.threads[0].last_activity).toBeGreaterThanOrEqual(list.threads[0].created_at);

    const transcript = await (await get(`/api/p/p1/threads/${list.threads[0].id}`, "tok-a")).json();
    expect(transcript.kind).toBe("review");
    expect(transcript.messages.map((m: { role: string }) => m.role)).toEqual(["coder", "mediator"]);
    expect(transcript.messages[0]).toMatchObject({ author: "cc-1", content: "a bad plan" });
    expect(transcript.messages[1].content).toContain("plan flagged as bad");
    expect(transcript.messages[1].created_at).toBeTypeOf("number");
  });

  it("threads keyset pages retain one-pass message previews", async () => {
    await driveMediatedFlow();
    const page1 = await (await get("/api/p/p1/threads?limit=2", "tok-a")).json();
    expect(page1.threads).toHaveLength(2);
    expect(page1.next_cursor).toBeTypeOf("string");
    expect(page1.threads.every((thread: { last_activity: number }) => typeof thread.last_activity === "number")).toBe(true);
    const page2 = await (await get(`/api/p/p1/threads?limit=2&cursor=${encodeURIComponent(page1.next_cursor)}`, "tok-a")).json();
    expect(page2.threads).toHaveLength(1);
    expect(page2.threads[0].kind).toBe("submission");
    expect(page2.next_cursor).toBeNull();
  });

  it("tasks/:id/timeline: bubbles + projected events (decision/steer/pr) in chronological order (#45)", async () => {
    const taskId = await queue.submit("p1", "ada", { title: "woven", body: "b", evidence: [] });
    await worker.waitForJob(await worker.enqueue("p1", "groom", { taskId, submittedBy: "ada" }), 3000);
    // a steer and a completed PR give the timeline event variety
    await dbRef
      .prepare("INSERT INTO steers (task_id, author, instruction, created_at) VALUES (?, 'ada', 'prefer the smaller diff', ?)")
      .run(taskId, Date.now());
    await queue.claimNext("p1", "cc-1", DEFAULT_LEASE_TTL_MS);
    await queue.approvePlan(taskId, "plan");
    await queue.complete(taskId, "cc-1", "shipped it", "https://github.com/acme/one/pull/5");

    const res = await get(`/api/p/p1/tasks/${taskId}/timeline`, "tok-a");
    expect(res.status).toBe(200);
    const { timeline } = await res.json();
    // chronological, non-decreasing created_at
    for (let i = 1; i < timeline.length; i++) {
      expect(timeline[i].created_at).toBeGreaterThanOrEqual(timeline[i - 1].created_at);
    }
    const kinds = new Set(timeline.map((t: { kind: string }) => t.kind));
    expect(kinds).toEqual(new Set(["bubble", "event"]));
    const types = timeline.map((t: { type: string }) => t.type);
    expect(types).toContain("decision"); // groom logged a 'create'
    expect(types).toContain("steer");
    expect(types).toContain("pr");
    // a mediator bubble carries the structured decision even without takeMeta
    const mediatorBubble = timeline.find(
      (t: { kind: string; role?: string }) => t.kind === "bubble" && t.role === "mediator",
    );
    expect(mediatorBubble.structured).toMatchObject({ action: "accept" });
    const pr = timeline.find((t: { type: string }) => t.type === "pr");
    expect(pr.pr_url).toBe("https://github.com/acme/one/pull/5");
  });

  it("tasks/:id/timeline shows only the task's own memory entries (#86)", async () => {
    const taskA = await queue.submit("p1", "ada", { title: "task A", body: "b", evidence: [] });
    const taskB = await queue.submit("p1", "ada", { title: "task B", body: "b", evidence: [] });
    const now = Date.now();
    // A curate entry attributed to A, timestamped BEFORE B was even created —
    // the #82 symptom: whole-project curation leaking into every timeline.
    await dbRef
      .prepare("INSERT INTO memory_log (project_id, entry, task_id, created_at) VALUES ('p1', ?, ?, ?)")
      .run(`curated@1: A learning`, taskA, now - 86_400_000);
    // A curate entry attributed to B.
    await dbRef
      .prepare("INSERT INTO memory_log (project_id, entry, task_id, created_at) VALUES ('p1', ?, ?, ?)")
      .run(`curated@2: B learning`, taskB, now);
    // An unattributed (legacy/unmappable) entry belongs to no task's timeline.
    await dbRef
      .prepare("INSERT INTO memory_log (project_id, entry, task_id, created_at) VALUES ('p1', ?, NULL, ?)")
      .run(`curated@0: orphan`, now);

    const memEntries = async (taskId: number): Promise<string[]> => {
      const { timeline } = await (await get(`/api/p/p1/tasks/${taskId}/timeline`, "tok-a")).json();
      return timeline.filter((t: { type: string }) => t.type === "memory").map((t: { entry: string }) => t.entry);
    };

    // B's timeline has only B's entry — none of A's, none of the orphan.
    expect(await memEntries(taskB)).toEqual(["curated@2: B learning"]);
    // A's timeline has only A's entry; and it contains no curate entry predating
    // A — the entry attributed elsewhere never appears (regression on #82).
    const aEntries = await memEntries(taskA);
    expect(aEntries).toEqual(["curated@1: A learning"]);
    expect(aEntries).not.toContain("curated@2: B learning");
  });

  it("tasks/:id/timeline 404s for a foreign or unknown task", async () => {
    const foreign = await queue.submit("p2", "bob", { title: "t", body: "b", evidence: [] });
    expect((await get(`/api/p/p1/tasks/${foreign}/timeline`, "tok-a")).status).toBe(404);
    expect((await get("/api/p/p1/tasks/9999/timeline", "tok-a")).status).toBe(404);
  });

  it("decisions: newest-first with kind/summary/rationale; approve lands after revise", async () => {
    const taskId = await driveMediatedFlow();
    await worker.waitForJob(
      await worker.enqueue("p1", "review", { taskId, plan: "solid plan", agent: "cc-1" }),
      3000,
    );
    const body = await (await get("/api/p/p1/decisions", "tok-a")).json();
    expect(body.decisions.map((d: { kind: string }) => d.kind)).toEqual(["approve", "revise", "create"]);
    expect(body.decisions[0]).toMatchObject({
      task_id: taskId,
      summary: `approved plan for task ${taskId}`,
      rationale: "plan is sound",
    });
    expect(body.decisions[0].created_at).toBeTypeOf("number");
  });

  it("decisions expose stable descending-id pages", async () => {
    await driveMediatedFlow();
    const page1 = await (await get("/api/p/p1/decisions?limit=1", "tok-a")).json();
    const page2 = await (await get(`/api/p/p1/decisions?limit=1&cursor=${encodeURIComponent(page1.next_cursor)}`, "tok-a")).json();
    expect(page1.decisions).toHaveLength(1);
    expect(page2.decisions).toHaveLength(1);
    expect([...page1.decisions, ...page2.decisions].map((decision: { kind: string }) => decision.kind)).toEqual(["revise", "create"]);
    expect(page2.next_cursor).toBeNull();
  });

  it("projects active knowledge with traversable task, decision, and concept provenance", async () => {
    const taskId = await queue.submit("p1", "ada", { title: "Enforce stacked work", body: "b", evidence: [] });
    const now = Date.now();
    await dbRef.prepare(
      "INSERT INTO memory_docs (project_id,path,type,title,description,tags,body,updated_at) VALUES ('p1',?,?,?,?,?,?,?)",
    ).run("conventions/stacked-prs.md", "Convention", "Stacked PRs", "Every change follows its parent", "[]", "Keep descendants stacked.", now);
    await dbRef.prepare(
      "INSERT INTO memory_docs (project_id,path,type,title,description,tags,body,updated_at) VALUES ('p1',?,?,?,?,?,?,?)",
    ).run("learnings/queue-recovery.md", "Learning", "Queue recovery", "How stale work recovers", "[]", "Recover the queue.", now);
    await dbRef.prepare("INSERT INTO memory_log (project_id,task_id,entry,created_at) VALUES ('p1',?,?,?)")
      .run(taskId, "Updated knowledge: conventions/stacked-prs.md", now + 10);
    const revise = await dbRef.prepare(
      "INSERT INTO decision_log (project_id,task_id,kind,summary,rationale,created_at) VALUES ('p1',?,'revise',?,?,?) RETURNING id",
    ).get<{ id: number }>(taskId, "Plan revised to preserve the stack", "Enforced conventions/stacked-prs.md", now + 11);
    await dbRef.prepare("INSERT INTO memory_log (project_id,task_id,entry,created_at) VALUES ('p1',?,?,?)")
      .run(taskId, "Wrote knowledge: learnings/queue-recovery.md", now + 20);
    const update = await dbRef.prepare(
      "INSERT INTO decision_log (project_id,task_id,kind,summary,rationale,created_at) VALUES ('p1',?,'update',?,?,?) RETURNING id",
    ).get<{ id: number }>(taskId, "Recorded queue recovery", "Updated learnings/queue-recovery.md", now + 21);
    await dbRef.prepare("INSERT INTO memory_log (project_id,task_id,entry,created_at) VALUES ('p1',?,?,?)")
      .run(taskId, `curated@${update!.id}: queue recovery`, now + 22);
    await dbRef.prepare(
      "INSERT INTO memory_docs (project_id,path,type,title,description,tags,body,updated_at) VALUES ('p2','private/only.md','Learning','Private only','hidden','[]','hidden',?)",
    ).run(now);
    const foreignTask = await queue.submit("p2", "bob", { title: "Foreign task title", body: "b", evidence: [] });
    await dbRef.prepare("INSERT INTO memory_log (project_id,task_id,entry,created_at) VALUES ('p1',?,?,?)")
      .run(foreignTask, "Updated knowledge: learnings/queue-recovery.md", now + 30);

    const activity = await (await get("/api/p/p1/knowledge/activity", "tok-a")).json();
    expect(activity.updates).toHaveLength(4);
    expect(activity.updates[0]).toMatchObject({ path: "learnings/queue-recovery.md", task: null, decision: null });
    expect(activity.updates[1]).toMatchObject({
      action: "curated", path: "learnings/queue-recovery.md",
      task: { id: taskId, title: "Enforce stacked work" },
      decision: { id: update!.id, kind: "update", summary: "Recorded queue recovery" },
    });
    expect(activity.conventions).toEqual([expect.objectContaining({
      path: "conventions/stacked-prs.md", title: "Stacked PRs",
      enforcement: expect.objectContaining({ id: revise!.id, kind: "revise", task: { id: taskId, title: "Enforce stacked work" } }),
    })]);
    expect(activity.decisions.map((item: { id: number }) => item.id)).toEqual([update!.id, revise!.id]);
    expect(JSON.stringify(activity)).not.toContain("curated@");
    expect(JSON.stringify(activity)).not.toContain("Private only");
    expect(JSON.stringify(activity)).not.toContain("Foreign task title");

    const doc = await (await get("/api/p/p1/knowledge/doc?path=conventions%2Fstacked-prs.md", "tok-a")).json();
    expect(doc.provenance).toEqual([expect.objectContaining({
      id: revise!.id, summary: "Plan revised to preserve the stack", task: { id: taskId, title: "Enforce stacked work" },
    })]);

    const empty = await (await get("/api/p/p2/knowledge/activity", "tok-b")).json();
    expect(empty).toEqual({ updates: [], conventions: [], decisions: [] });
  });
});

describe("retired verifier surface", () => {
  it("GET /api/projects exposes no verifier degradation contract", async () => {
    const res = await get("/api/projects", "tok-a");
    const body = await res.json();
    expect(body).not.toHaveProperty("verifier_degraded");
  });
});

describe("warming view (#63)", () => {
  const HOUR = 60 * 60 * 1000;

  it("lists only INCUBATING tasks, soonest graduation first, with the canonical spec", async () => {
    const warmLater = await queue.submit("p1", "ada", {
      title: "warm later",
      body: "the evolving canonical spec",
      evidence: [],
      warmForMs: 2 * HOUR,
    });
    const warmSoon = await queue.submit("p1", "ada", {
      title: "warm soon",
      body: "b",
      evidence: [],
      warmForMs: HOUR,
    });
    // a plain (QUEUED) task must not appear on the warming surface
    await queue.submit("p1", "ada", { title: "plain queued", body: "b", evidence: [] });

    const body = await (await get("/api/p/p1/warming?limit=1", "tok-a")).json();
    expect(body.tasks.map((t: { id: number }) => t.id)).toEqual([warmSoon]);
    expect(body.tasks[0]).toMatchObject({
      id: warmSoon,
      title: "warm soon",
      state: "INCUBATING",
      submitted_by: "ada",
    });
    expect(body.tasks[0].incubate_until).toBeGreaterThan(Date.now());
    const next = await (await get(`/api/p/p1/warming?limit=1&cursor=${encodeURIComponent(body.next_cursor)}`, "tok-a")).json();
    expect(next.tasks[0]).toMatchObject({ id: warmLater, body: "the evolving canonical spec" });
    expect(next.next_cursor).toBeNull();
  });

  it("counts distinct contributors from the task's threads", async () => {
    const id = await queue.submit("p1", "ada", { title: "warm", body: "b", evidence: [], warmForMs: HOUR });
    let body = await (await get("/api/p/p1/warming", "tok-a")).json();
    // the submission root thread carries one author (the submitter)
    expect(body.tasks[0].contributor_count).toBe(1);
    expect(body.tasks[0].thread_count).toBe(1);

    // a second human weighs in on the task's thread → two contributors
    const rootId = (
      await dbRef.prepare("SELECT root_thread_id AS r FROM tasks WHERE id = ?").get<{ r: number }>(id)
    )!.r;
    await dbRef
      .prepare(
        "INSERT INTO thread_messages (thread_id, role, author, content, created_at) VALUES (?, 'human', 'bob', 'a note', ?)",
      )
      .run(rootId, Date.now());
    body = await (await get("/api/p/p1/warming", "tok-a")).json();
    expect(body.tasks[0].contributor_count).toBe(2);
  });

  it("empty when nothing is warming — degrades gracefully", async () => {
    await queue.submit("p1", "ada", { title: "plain", body: "b", evidence: [] });
    const body = await (await get("/api/p/p1/warming", "tok-a")).json();
    expect(body.tasks).toEqual([]);
  });

  it("a graduated task leaves warming and enters the queue", async () => {
    const id = await queue.submit("p1", "ada", { title: "warm", body: "b", evidence: [], warmForMs: HOUR });
    let warming = await (await get("/api/p/p1/warming", "tok-a")).json();
    expect(warming.tasks.map((t: { id: number }) => t.id)).toContain(id);

    await queue.graduate(id);

    warming = await (await get("/api/p/p1/warming", "tok-a")).json();
    expect(warming.tasks.map((t: { id: number }) => t.id)).not.toContain(id);
    const queueBody = await (await get("/api/p/p1/queue", "tok-a")).json();
    expect(queueBody.tasks.find((t: { id: number }) => t.id === id).state).toBe("QUEUED");
  });

  it("401 without a token; 404 for a non-member project", async () => {
    expect((await get("/api/p/p1/warming")).status).toBe(401);
    expect((await get("/api/p/p1/warming", "tok-b")).status).toBe(404);
  });
});

describe("auth UI endpoints (#73)", () => {
  it("GET /api/me returns the caller's identity + memberships; 401 without creds", async () => {
    expect((await get("/api/me")).status).toBe(401);
    const res = await get("/api/me", "tok-a");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("ada");
    expect(body.memberships).toEqual([
      { projectId: "p1", projectName: "Project One", repo: "acme/one", role: "human", orgId: null, orgName: null },
    ]);
  });

  it("GET /api/p/:project/team lists the project's members and roles", async () => {
    // add a second member to p1
    await seedMember(dbRef, { name: "cleo", projectId: "p1", projectName: "Project One", role: "coder" });
    const res = await get("/api/p/p1/team", "tok-a");
    expect(res.status).toBe(200);
    const { members } = await res.json();
    expect(members).toEqual(
      expect.arrayContaining([
        // better-auth members carry a real email + userId (#90: legacy null-token members gone).
        expect.objectContaining({ name: "ada", role: "human", email: expect.any(String), userId: expect.any(String), joinedAt: expect.any(Number) }),
        expect.objectContaining({ name: "cleo", role: "coder", email: expect.any(String), userId: expect.any(String), joinedAt: expect.any(Number) }),
      ]),
    );
    expect(members).toHaveLength(2);
  });

  it("GET /api/p/:project/analytics returns project-scoped contributors and coder activity", async () => {
    const coder = await seedMember(dbRef, { name: "cleo", projectId: "p1", projectName: "Project One", role: "coder" });
    const taskId = await queue.submit("p1", "ada", { title: "Analytics task", body: "b", evidence: [] });
    const now = Date.now();
    await dbRef.prepare("UPDATE tasks SET state='DONE', lease_agent=?, updated_at=? WHERE id=?").run(coder.keyId, now, taskId);
    await dbRef.prepare("INSERT INTO attempts (task_id, agent, outcome, notes, created_at) VALUES (?, ?, 'completed', 'done', ?)").run(taskId, coder.keyId, now);

    const res = await get("/api/p/p1/analytics?period=all", "tok-a");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.period).toBe("all");
    expect(body.headline).toMatchObject({ members: 2, tasks: 1, completed_tasks: 1, task_completion_rate: 100 });
    expect(body.contributors).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "ada", task_count: 1, idle: false }),
      expect.objectContaining({ name: "cleo", task_count: 0, idle: false }),
    ]));
    expect(body.agents).toEqual([expect.objectContaining({ id: coder.keyId, attempt_count: 1, completed_attempts: 1, revoked: false, unresolved: false })]);
  });

  it("analytics attributes legacy names and canonical user ids to the same person", async () => {
    const ada = await dbRef.prepare('SELECT id FROM "user" WHERE name = ?').get<{ id: string }>("ada");
    if (!ada) throw new Error("seeded ada user missing");
    const canonical = await queue.submit("p1", ada.id, { title: "Canonical submitter", body: "b", evidence: [] });
    const legacy = await queue.submit("p1", " ADA ", { title: "Legacy submitter", body: "b", evidence: [] });
    await dbRef.prepare("UPDATE tasks SET state='DONE', updated_at=? WHERE id IN (?, ?)").run(Date.now(), canonical, legacy);

    const res = await get("/api/p/p1/analytics?period=all", "tok-a");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.contributors).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "ada", task_count: 2, completed_count: 2, idle: false }),
    ]));
  });

  it("analytics folds completed coder attempts into the owning member total", async () => {
    const coder = await seedMember(dbRef, { name: "cleo", projectId: "p1", projectName: "Project One", role: "coder" });
    const taskId = await queue.submit("p1", "ada", { title: "Coder completion", body: "b", evidence: [] });
    const now = Date.now();
    await dbRef.prepare("UPDATE tasks SET state='DONE', lease_agent=?, updated_at=? WHERE id=?").run(coder.keyId, now, taskId);
    await dbRef.prepare("INSERT INTO attempts (task_id, agent, outcome, notes, created_at) VALUES (?, ?, 'completed', 'done', ?)").run(taskId, coder.keyId, now);

    const res = await get("/api/p/p1/analytics?period=all", "tok-a");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.contributors).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "cleo", completed_count: 1, idle: false }),
    ]));
  });

  it("analytics refuses to guess between duplicate display names", async () => {
    const first = await seedMember(dbRef, { name: "same", projectId: "p1", projectName: "Project One", role: "human" });
    const second = await seedMember(dbRef, { name: "same", projectId: "p1", projectName: "Project One", role: "human" });
    const byName = await queue.submit("p1", "same", { title: "Ambiguous submitter", body: "b", evidence: [] });
    const byId = await queue.submit("p1", second.userId, { title: "Stable submitter", body: "b", evidence: [] });
    await dbRef.prepare("UPDATE tasks SET state='DONE', updated_at=? WHERE id IN (?, ?)").run(Date.now(), byName, byId);

    const res = await get("/api/p/p1/analytics?period=all", "tok-a");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.contributors).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.userId, name: "same", task_count: 0, completed_count: 0, name_collision: true }),
      expect.objectContaining({ id: second.userId, name: "same", task_count: 1, completed_count: 1, name_collision: true }),
    ]));
  });

  it("analytics data-viz contract attributes contribution types and scales telemetry", async () => {
    const coder = await seedMember(dbRef, { name: "cleo", projectId: "p1", projectName: "Project One", role: "coder" });
    const taskId = await queue.submit("p1", "ada", { title: "Data viz task", body: "b", evidence: [] });
    const now = Date.now();
    const rootId = (await dbRef.prepare("SELECT root_thread_id AS root FROM tasks WHERE id=?").get<{ root: number }>(taskId))!.root;
    await dbRef.prepare("INSERT INTO thread_messages (thread_id, role, author, content, created_at) VALUES (?, 'human', ?, ?, ?)").run(rootId, "ada", "steer", now);
    await dbRef.prepare("INSERT INTO questions (project_id, task_id, asked_by, question, answer, answered_by, status, created_at, answered_at) VALUES (?, ?, 'mediator', ?, ?, ?, 'answered', ?, ?)").run("p1", taskId, "question", "answer", "ada", now, now);
    await dbRef.prepare("UPDATE tasks SET state='DONE', lease_agent=?, created_at=?, updated_at=? WHERE id=?").run(coder.keyId, now, now, taskId);
    await dbRef.prepare("INSERT INTO attempts (task_id, agent, outcome, notes, created_at) VALUES (?, ?, 'completed', 'done', ?)").run(taskId, coder.keyId, now);
    const job = await dbRef.prepare("INSERT INTO jobs (project_id, kind, payload, status, created_at, updated_at) VALUES (?, 'groom', '{}', 'done', ?, ?) RETURNING id").get<{ id: number }>("p1", now, now);
    await dbRef.prepare("INSERT INTO mediator_usage (job_id, project_id, kind, resolved_model, cost_usd, completion_count, created_at) VALUES (?, ?, 'groom', ?, ?, ?, ?)").run(job!.id, "p1", "gemini-2.5-pro", 4.5, 3, now);
    await dbRef.prepare("INSERT INTO job_policy_log (project_id, job_id, attempt, invocation, kind, model, effort, max_tokens, rollout_arm, latency_ms, outcome, started_at, finished_at, created_at, updated_at) VALUES (?, ?, 1, 1, 'groom', 'gemini-2.5-pro', 'high', 1000, 'routed', ?, 'fail', ?, ?, ?, ?)").run("p1", job!.id, 49944, now - 49944, now, now, now);
    // Second usage row: cheap flash-lite model with sub-cent unit cost that must not vanish.
    const job2 = await dbRef.prepare("INSERT INTO jobs (project_id, kind, payload, status, created_at, updated_at) VALUES (?, 'groom', '{}', 'done', ?, ?) RETURNING id").get<{ id: number }>("p1", now, now);
    await dbRef.prepare("INSERT INTO mediator_usage (job_id, project_id, kind, resolved_model, cost_usd, completion_count, created_at) VALUES (?, ?, 'groom', ?, ?, ?, ?)").run(job2!.id, "p1", "gemini-3.1-flash-lite", 0.004, 2, now);
    // Null resolved_model must bucket under "unknown", not drop — when it has spend.
    const job3 = await dbRef.prepare("INSERT INTO jobs (project_id, kind, payload, status, created_at, updated_at) VALUES (?, 'refresh', '{}', 'done', ?, ?) RETURNING id").get<{ id: number }>("p1", now, now);
    await dbRef.prepare("INSERT INTO mediator_usage (job_id, project_id, kind, resolved_model, cost_usd, completion_count, created_at) VALUES (?, ?, 'refresh', NULL, ?, ?, ?)").run(job3!.id, "p1", 0.001, 1, now);
    // Empty resolved_model + $0 is noise and must not invent a routing row.
    const job4 = await dbRef.prepare("INSERT INTO jobs (project_id, kind, payload, status, created_at, updated_at) VALUES (?, 'refresh', '{}', 'done', ?, ?) RETURNING id").get<{ id: number }>("p1", now, now);
    await dbRef.prepare("INSERT INTO mediator_usage (job_id, project_id, kind, resolved_model, cost_usd, completion_count, created_at) VALUES (?, ?, 'refresh', '', ?, ?, ?)").run(job4!.id, "p1", 0, 0, now);

    const res = await get("/api/p/p1/analytics", "tok-a");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.period).toBe("7d");
    expect(body.headline).toMatchObject({ contributions: 5, tasks_shipped: 1, frigg_jobs: 4 });
    expect(body.headline.trends).toEqual(expect.objectContaining({ contributions: expect.any(Number), frigg_spend: expect.any(Number) }));
    expect(body.contributors.find((member: { name: string }) => member.name === "ada")).toMatchObject({
      contributions: { steer: 2, create: 1, complete: 0, answer: 1, total: 4 },
    });
    const cleo = body.contributors.find((member: { name: string }) => member.name === "cleo");
    expect(cleo).toMatchObject({ contributions: { steer: 0, create: 0, complete: 1, answer: 0, total: 1 } });
    expect(cleo.agent_contributions[0]).toMatchObject({ contributions: { complete: 1, total: 1 } });
    const geminiRoute = body.routing.find((row: { model: string }) => row.model === "gemini-2.5-pro");
    expect(geminiRoute).toMatchObject({ model: "gemini-2.5-pro", invocations: 1, average_latency_ms: 49944, cost_usd: 4.5 });
    const flashRoute = body.routing.find((row: { model: string }) => row.model === "gemini-3.1-flash-lite");
    expect(flashRoute).toMatchObject({ model: "gemini-3.1-flash-lite", cost_usd: 0.004 });
    expect(flashRoute.cost_usd).toBeGreaterThan(0);
    const unknownRoute = body.routing.find((row: { model: string }) => row.model === "unknown");
    expect(unknownRoute).toMatchObject({ model: "unknown", cost_usd: 0.001 });
    expect(body.routing.some((row: { model: string; invocations: number; cost_usd: number }) =>
      row.model === "unknown" && row.invocations === 0 && !(row.cost_usd > 0),
    )).toBe(false);
    const groom = body.scorecard.find((row: { kind: string }) => row.kind === "groom");
    expect(groom).toMatchObject({ kind: "groom", jobs: 2, completions: 5, failed: 1, cost_usd: 4.504 });
    expect(groom.by_model).toEqual([
      expect.objectContaining({ model: "gemini-2.5-pro", completions: 3, cost_usd: 4.5 }),
      expect.objectContaining({ model: "gemini-3.1-flash-lite", completions: 2, cost_usd: 0.004 }),
    ]);
    const refresh = body.scorecard.find((row: { kind: string }) => row.kind === "refresh");
    expect(refresh.by_model).toEqual([expect.objectContaining({ model: "unknown", completions: 1, cost_usd: 0.001 })]);
  });

  it("analytics splits model spend across rollout arms by invocation share", async () => {
    const now = Date.now();
    // One model, $10 spend, 1 flat + 3 routed invocations → flat $2.50, routed $7.50
    const job = await dbRef
      .prepare(
        "INSERT INTO jobs (project_id, kind, payload, status, created_at, updated_at) VALUES (?, 'groom', '{}', 'done', ?, ?) RETURNING id",
      )
      .get<{ id: number }>("p1", now, now);
    await dbRef
      .prepare(
        "INSERT INTO mediator_usage (job_id, project_id, kind, resolved_model, cost_usd, completion_count, created_at) VALUES (?, ?, 'groom', ?, ?, ?, ?)",
      )
      .run(job!.id, "p1", "z-ai/glm-5.2", 10, 4, now);
    for (let i = 0; i < 3; i++) {
      await dbRef
        .prepare(
          "INSERT INTO job_policy_log (project_id, job_id, attempt, invocation, kind, model, effort, max_tokens, rollout_arm, latency_ms, outcome, started_at, finished_at, created_at, updated_at) VALUES (?, ?, 1, ?, 'groom', 'z-ai/glm-5.2', 'high', 1000, 'routed', 100, 'ok', ?, ?, ?, ?)",
        )
        .run("p1", job!.id, i + 1, now - 100, now, now, now);
    }
    await dbRef
      .prepare(
        "INSERT INTO job_policy_log (project_id, job_id, attempt, invocation, kind, model, effort, max_tokens, rollout_arm, latency_ms, outcome, started_at, finished_at, created_at, updated_at) VALUES (?, ?, 1, 4, 'groom', 'z-ai/glm-5.2', 'high', 1000, 'flat', 100, 'ok', ?, ?, ?, ?)",
      )
      .run("p1", job!.id, now - 100, now, now, now);

    const res = await get("/api/p/p1/analytics?period=all", "tok-a");
    expect(res.status).toBe(200);
    const body = await res.json();
    const arms = body.routing.filter((row: { model: string }) => row.model === "z-ai/glm-5.2");
    expect(arms.length).toBe(2);
    const flat = arms.find((row: { rollout_arm: string }) => row.rollout_arm === "flat");
    const routed = arms.find((row: { rollout_arm: string }) => row.rollout_arm === "routed");
    expect(flat).toMatchObject({ invocations: 1, cost_usd: 2.5 });
    expect(routed).toMatchObject({ invocations: 3, cost_usd: 7.5 });
    // Must not dump all spend on alphabetically first arm (flat) with routed at $0.
    expect(routed.cost_usd).toBeGreaterThan(0);
    expect(flat.cost_usd + routed.cost_usd).toBeCloseTo(10, 5);
  });

  it("team is membership-scoped: a non-member project is a 404", async () => {
    expect((await get("/api/p/p1/team", "tok-b")).status).toBe(404); // bob is only in p2
    expect((await get("/api/p/p1/team")).status).toBe(401);
  });
});

describe("dashboard SSE", () => {
  it("streams changed events for the member's project via query-param token, then cleans up", async () => {
    const baseline = queue.changedListenerCount();
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/api/p/p1/events?token=${encodeURIComponent(tokens["tok-a"])}`, {
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(queue.changedListenerCount()).toBe(baseline + 1);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const readUntil = async (marker: string, count = 1) => {
      const deadline = Date.now() + 5000;
      while (buffer.split(marker).length - 1 < count) {
        if (Date.now() > deadline) throw new Error(`SSE marker not seen: ${marker}\ngot: ${buffer}`);
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended early");
        buffer += decoder.decode(value, { stream: true });
      }
    };

    // keepalive comment arrives without any activity (interval is 40ms in this harness)
    await readUntil(":");

    await queue.submit("p1", "ada", { title: "t", body: "b", evidence: [] });
    await readUntil('event: changed\ndata: {"project":"p1"}');

    // a mutation on a project the stream is not watching must not appear
    await queue.submit("p2", "bob", { title: "x", body: "y", evidence: [] });
    await queue.submit("p1", "ada", { title: "t2", body: "b2", evidence: [] });
    await readUntil('event: changed\ndata: {"project":"p1"}', 2);
    expect(buffer).not.toContain('"project":"p2"');

    controller.abort();
    const deadline = Date.now() + 3000;
    while (queue.changedListenerCount() > baseline && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(queue.changedListenerCount()).toBe(baseline);
  });

  it("SSE auth: 401 with no/bad token, 404 for a non-member project", async () => {
    expect((await fetch(`${baseUrl}/api/p/p1/events`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/p/p1/events?token=bad`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/p/p2/events?token=${encodeURIComponent(tokens["tok-a"])}`)).status).toBe(404);
    // header auth works too
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/api/p/p1/events`, {
      headers: { Authorization: `Bearer ${tokens["tok-a"]}` },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    controller.abort();
  });
});

describe("dashboard Knowledge (OKF) API", () => {
  async function seedOkf() {
    const ins = dbRef.prepare(
      `INSERT INTO memory_docs (project_id, path, type, title, description, tags, body, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = Date.now();
    await ins.run(
      "p1", "decisions/rate-limit.md", "Decision", "Rate limiting",
      "Token bucket at ingest", JSON.stringify(["queue", "ingest"]),
      "We chose a token bucket. See [[Ingest pipeline]] and thread #7 for the debate.", now,
    );
    await ins.run(
      "p1", "ingest/pipeline.md", "Learning", "Ingest pipeline",
      "How ingest feeds the queue", JSON.stringify(["ingest"]),
      "The pipeline feeds the queue. Related: [[Rate limiting]].", now + 1,
    );
    // a concept on p2 must never leak into p1's Knowledge
    await ins.run(
      "p2", "decisions/other.md", "Decision", "Other project decision",
      "unrelated", JSON.stringify(["x"]), "body", now,
    );
  }

  it("lists p1 concepts with parsed tags, grouped-ready by type; no p2 leakage", async () => {
    await seedOkf();
    const res = await get("/api/p/p1/knowledge", "tok-a");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.concepts.map((c: { path: string }) => c.path)).toEqual([
      "decisions/rate-limit.md",
      "ingest/pipeline.md",
    ]);
    expect(body.concepts[0]).toMatchObject({
      path: "decisions/rate-limit.md",
      type: "Decision",
      title: "Rate limiting",
      description: "Token bucket at ingest",
      tags: ["queue", "ingest"],
    });
    expect(body.concepts[0].updated_at).toBeTypeOf("number");
    expect(body.concepts[0]).not.toHaveProperty("body");
  });

  it("?q= does case-insensitive full-text search over title, description, and body", async () => {
    await seedOkf();
    const hit = await (await get("/api/p/p1/knowledge?q=BUCKET", "tok-a")).json();
    expect(hit.concepts.map((c: { path: string }) => c.path)).toEqual(["decisions/rate-limit.md"]);
    const miss = await (await get("/api/p/p1/knowledge?q=nonexistent-term", "tok-a")).json();
    expect(miss.concepts).toEqual([]);
  });

  it("treats malformed or non-string tag JSON as an empty list", async () => {
    await seedOkf();
    await dbRef.prepare("UPDATE memory_docs SET tags = '{broken' WHERE project_id = 'p1' AND path = 'ingest/pipeline.md'").run();
    const list = await (await get("/api/p/p1/knowledge", "tok-a")).json();
    expect(list.concepts.find((concept: { path: string }) => concept.path === "ingest/pipeline.md").tags).toEqual([]);
    const doc = await (await get("/api/p/p1/knowledge/doc?path=ingest%2Fpipeline.md", "tok-a")).json();
    expect(doc.tags).toEqual([]);
  });

  it("knowledge/doc returns the full concept with resolved links and backlinks", async () => {
    await seedOkf();
    const res = await get("/api/p/p1/knowledge/doc?path=ingest/pipeline.md", "tok-a");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      path: "ingest/pipeline.md",
      title: "Ingest pipeline",
      body: "The pipeline feeds the queue. Related: [[Rate limiting]].",
      tags: ["ingest"],
    });
    expect(body.links).toEqual([{ path: "decisions/rate-limit.md", title: "Rate limiting" }]);
    expect(body.backlinks).toEqual([{ path: "decisions/rate-limit.md", title: "Rate limiting" }]);
  });

  it("knowledge/doc 404s for an unknown path and a missing path param", async () => {
    await seedOkf();
    expect((await get("/api/p/p1/knowledge/doc?path=decisions/nope.md", "tok-a")).status).toBe(404);
    expect((await get("/api/p/p1/knowledge/doc", "tok-a")).status).toBe(404);
  });
});

describe("orchestrator health endpoint (#82)", () => {
  it("401s without a token", async () => {
    expect((await get("/api/p/p1/health")).status).toBe(401);
  });

  it("returns the worker status shape and is healthy on a quiet worker", async () => {
    const res = await get("/api/p/p1/health", "tok-a");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      inFlight: expect.any(Number),
      sweepErrors: { count: 0, escalated: false },
      drainErrors: { count: 0, escalated: false },
    });
    expect(body.sweepErrors).toHaveProperty("lastMessage");
    expect(body.sweepErrors).toHaveProperty("lastAt");
  });
});

describe("dashboard API: conflict conversations (#77)", () => {
  /** Open a conflict conversation on p1 between ada and rui; returns its id + task ids. */
  async function openConflict(): Promise<{ convId: number; adaTask: number; ruiTask: number }> {
    const adaTask = await queue.submit("p1", "ada", { title: "Add cache", body: "add a cache", evidence: [] });
    const ruiTask = await queue.submit("p1", "rui", { title: "Add cache", body: "add a cache", evidence: [] });
    const job = await worker.waitForJob(await worker.enqueue("p1", "groom", { taskId: ruiTask, submittedBy: "rui" }), 3000);
    const convId = JSON.parse(job.result!).conversation_id as number;
    return { convId, adaTask, ruiTask };
  }

  it("lists conversations with state, participants and task links; scoped to the project", async () => {
    const { convId, adaTask, ruiTask } = await openConflict();
    const res = await get("/api/p/p1/conversations", "tok-a");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.conversations).toHaveLength(1);
    const c = body.conversations[0];
    expect(c.id).toBe(convId);
    expect(c.state).toBe("OPEN");
    expect(c.participants.map((p: { member: string }) => p.member).sort()).toEqual(["ada", "rui"]);
    expect(c.task_ids.sort((x: number, y: number) => x - y)).toEqual([adaTask, ruiTask].sort((x, y) => x - y));
    expect(c.message_count).toBeGreaterThanOrEqual(1);
    // bob (p2 only) cannot see p1's conversations
    expect((await get("/api/p/p1/conversations", "tok-b")).status).toBe(404);
  });

  it("returns one conversation's full read view: messages, participants, tasks, and decisions", async () => {
    const { convId } = await openConflict();
    const res = await get(`/api/p/p1/conversations/${convId}`, "tok-a");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.state).toBe("OPEN");
    expect(body.messages.length).toBeGreaterThanOrEqual(1); // the mediator's opening framing
    expect(body.messages[0].role).toBe("mediator");
    expect(body.participants).toHaveLength(2);
    expect(body.tasks.length).toBe(2);
    // the open is provenance-linked to a decision, surfaced in the read view
    expect(body.decisions.length).toBeGreaterThanOrEqual(1);
    // a missing conversation 404s
    expect((await get("/api/p/p1/conversations/99999", "tok-a")).status).toBe(404);
  });
});
