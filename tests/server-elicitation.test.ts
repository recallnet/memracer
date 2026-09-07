// tests/server-elicitation.test.ts
// Session-aware mediator->human clarification delivery. Capable connected
// humans get live elicitation; headless clients retain the durable text path.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Db } from "../src/db.js";
import { createApp } from "../src/server.js";
import { FakeDriver } from "../src/mediator/fake.js";
import type { MediatorWorker } from "../src/mediator/worker.js";
import { openDb } from "../src/db.js";
import { betterAuthReady, seedMember } from "./helpers/auth.js";
import { submitAndWait } from "./helpers/async-human.js";

let httpServer: Server;
let baseUrl: string;
let worker: MediatorWorker;
let db: Db;
let tokH: string;

beforeEach(async () => {
  db = openDb(":memory:");
  await betterAuthReady(db);
  await db.prepare("INSERT INTO projects (id, name, repo) VALUES ('demo','Demo','recallnet/demo-app')").run();
  tokH = (await seedMember(db, { name: "dana", projectId: "demo", role: "human" })).token;
  const made = createApp(db, {
    driverFor: () => new FakeDriver(),
    workerOpts: { tickMs: 20, jobTimeoutMs: 2000 },
  });
  worker = made.worker;
  await new Promise<void>((resolve) => {
    httpServer = made.app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`;
});

afterEach(() => {
  worker.stop();
  return new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

async function connect(opts?: { elicitation?: boolean }): Promise<Client> {
  const { client, transport } = makeClient(opts);
  await client.connect(transport);
  return client;
}

function makeClient(opts?: { elicitation?: boolean }): {
  client: Client;
  transport: StreamableHTTPClientTransport;
} {
  const client = new Client(
    { name: "test", version: "0.0.1" },
    opts?.elicitation ? { capabilities: { elicitation: {} } } : undefined,
  );
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
    requestInit: { headers: { Authorization: `Bearer ${tokH}` } },
  });
  return { client, transport };
}

async function connectWithToken(token: string, opts?: { elicitation?: boolean }): Promise<Client> {
  const client = new Client(
    { name: "test", version: "0.0.1" },
    opts?.elicitation ? { capabilities: { elicitation: {} } } : undefined,
  );
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

function parse(result: { content?: unknown }) {
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0].text);
}

const submitArgs = {
  title: "t",
  body: "CLARIFY: Which region should host it? Recommended: eu-west-1 — it matches the current deployment.",
  project: "demo",
};

describe("session-aware delivery on groom clarify", () => {
  it("delivers a durable clarification live to a capable connected human", async () => {
    const client = await connect({ elicitation: true });
    const seen: string[] = [];
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      seen.push(req.params.message);
      return { action: "accept", content: { answer: "eu-west-1" } };
    });

    const result = await submitAndWait(client, submitArgs);

    // Live elicit must fire at least once. Under load the same open question
    // can redispatch once before accept lands; assert delivery, not exact count.
    await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(1));
    expect(seen[0]).toMatch(/which region/i);
    expect(result.grooming.action).toBe("clarify");
    expect(result.grooming.question).toMatch(/which region/i);

    await vi.waitFor(async () => expect(await db
      .prepare("SELECT status, answer FROM questions WHERE task_id=? AND asked_by='mediator' ORDER BY id LIMIT 1")
      .get(result.task.id)).toEqual({ status: "answered", answer: "eu-west-1" }));
    await client.close();
  });

  it("keeps a declined live clarification open for the text fallback", async () => {
    const client = await connect({ elicitation: true });
    let count = 0;
    client.setRequestHandler(ElicitRequestSchema, async () => { count += 1; return { action: "decline" as const }; });

    const result = await submitAndWait(client, submitArgs);

    expect(result.grooming.action).toBe("clarify");
    await vi.waitFor(() => expect(count).toBe(1));
    const q = (await db
      .prepare("SELECT status FROM questions WHERE task_id=? AND asked_by='mediator'")
      .get<{ status: string }>(result.grooming.task_id)) as { status: string };
    expect(q.status).toBe("open");
    expect(await db.prepare("SELECT state FROM tasks WHERE id=?").get(result.grooming.task_id)).toEqual({ state: "BLOCKED" });
    await client.close();
  });

  it("clients without elicitation keep the offline path: queued question + human_answer", async () => {
    // No elicitation capability or handler is required for the queued path.
    const client = await connect();

    const result = await submitAndWait(client, submitArgs);

    expect(result.grooming.action).toBe("clarify");
    expect(result.grooming.question_id).toEqual(expect.any(Number));
    const answered = parse(
      await client.callTool({
        name: "human_answer",
        arguments: { question_id: result.grooming.question_id, answer: "us-east-2" },
      }),
    );
    expect(answered.answered).toBe(result.grooming.question_id);
    const q = await db
      .prepare("SELECT status, answer FROM questions WHERE id=?")
      .get<{ status: string; answer: string }>(result.grooming.question_id);
    expect(q).toEqual({ status: "answered", answer: "us-east-2" });
    await client.close();
  });

  it("piggybacks open clarifications onto the next human call without elicitation", async () => {
    const client = await connect();
    const submitted = parse(await client.callTool({ name: "human_submit", arguments: submitArgs }));
    const groom = await worker.waitForJob(submitted.job_id, 3_000);
    expect(groom.status).toBe("done");
    const result = JSON.parse(groom.result!);

    const next = parse(await client.callTool({
      name: "human_task_status",
      arguments: { task_id: submitted.task_id },
    }));
    expect(next.pending_clarifications).toEqual([{
      question_id: result.question_id,
      task_id: submitted.task_id,
      task_title: "t",
      question: result.question,
    }]);
    expect(next.pending_clarifications_page).toEqual({
      cursor: 0,
      limit: 5,
      returned: 1,
      total: 1,
      next_cursor: null,
    });

    const answered = parse(await client.callTool({
      name: "human_answer",
      arguments: { question_id: result.question_id, answer: "us-east-2" },
    }));
    expect(answered.pending_clarifications).toEqual([]);
    expect(answered.pending_clarifications_page.total).toBe(0);
    await client.close();
  });

  it("bounds clarification pages and isolates them by submitter and membership", async () => {
    const ruiToken = (await seedMember(db, { name: "rui", projectId: "demo", role: "human" })).token;
    await db.prepare("INSERT INTO projects (id, name) VALUES ('private','Private')").run();
    const insertTask = db.prepare(
      `INSERT INTO tasks (project_id, title, body, priority, state, submitted_by, created_at, updated_at)
       VALUES (?, ?, 'body', 2, 'BLOCKED', ?, ?, ?) RETURNING id`,
    );
    const insertQuestion = db.prepare(
      `INSERT INTO questions (project_id, task_id, asked_by, question, status, created_at)
       VALUES (?, ?, 'mediator', ?, 'open', ?)`,
    );
    for (let i = 1; i <= 7; i += 1) {
      const task = await insertTask.get<{ id: number }>("demo", `Dana ${i}`, "dana", i, i);
      await insertQuestion.run("demo", task!.id, `Question ${i}?`, i);
    }
    const ruiTask = await insertTask.get<{ id: number }>("demo", "Rui only", "rui", 20, 20);
    await insertQuestion.run("demo", ruiTask!.id, "Rui question?", 20);
    const privateTask = await insertTask.get<{ id: number }>("private", "Private Dana", "dana", 30, 30);
    await insertQuestion.run("private", privateTask!.id, "Private question?", 30);
    expect(await db.prepare(
      `SELECT COUNT(*) AS n FROM questions q JOIN tasks t ON t.id=q.task_id
       WHERE q.status='open' AND q.asked_by='mediator' AND t.submitted_by='dana' AND q.project_id='demo'`,
    ).get()).toEqual({ n: 7 });

    const dana = await connect();
    const first = parse(await dana.callTool({
      name: "human_status",
      arguments: { project: "demo", sections: ["projects"] },
    }));
    expect(first.pending_clarifications.map((item: { question: string }) => item.question)).toEqual([
      "Question 1?", "Question 2?", "Question 3?", "Question 4?", "Question 5?",
    ]);
    expect(first.pending_clarifications_page).toEqual({
      cursor: 0, limit: 5, returned: 5, total: 7, next_cursor: 5,
    });
    const second = parse(await dana.callTool({
      name: "human_status",
      arguments: {
        project: "demo",
        sections: ["projects"],
        pending_clarifications_cursor: first.pending_clarifications_page.next_cursor,
      },
    }));
    expect(second.pending_clarifications.map((item: { question: string }) => item.question)).toEqual([
      "Question 6?", "Question 7?",
    ]);
    expect(second.pending_clarifications_page).toEqual({
      cursor: 5, limit: 5, returned: 2, total: 7, next_cursor: null,
    });

    const rui = await connectWithToken(ruiToken);
    const ruiStatus = parse(await rui.callTool({
      name: "human_status",
      arguments: { project: "demo", sections: ["projects"] },
    }));
    expect(ruiStatus.pending_clarifications.map((item: { question: string }) => item.question)).toEqual([
      "Rui question?",
    ]);
    await dana.close();
    await rui.close();
  });

  it("wait=true returns an in-window groom verdict and clarification inline", async () => {
    const client = await connect();
    const result = parse(await client.callTool({
      name: "human_submit",
      arguments: { ...submitArgs, title: "waited", wait: true },
    }));
    expect(result.state).toBe("BLOCKED");
    expect(result.grooming).toMatchObject({
      status: "done",
      result: { action: "clarify", question_id: expect.any(Number) },
    });
    expect(result.pending_clarifications).toEqual([{
      question_id: result.grooming.result.question_id,
      task_id: result.task_id,
      task_title: "waited",
      question: result.grooming.result.question,
    }]);
    await client.close();
  });

  it("redispatches an open clarification to a reconnected capable session", async () => {
    const first = await connect({ elicitation: true });
    let releaseFirst!: (value: { action: "decline" }) => void;
    let firstSeen = 0;
    first.setRequestHandler(ElicitRequestSchema, async () => {
      firstSeen += 1;
      return new Promise<{ action: "decline" }>((resolve) => { releaseFirst = resolve; });
    });
    const result = await submitAndWait(first, { ...submitArgs, title: "reconnect-clarify" });
    await vi.waitFor(() => expect(firstSeen).toBe(1));
    await first.close();

    const { client: resumed, transport: resumedTransport } = makeClient({ elicitation: true });
    let resumedSeen = 0;
    resumed.setRequestHandler(ElicitRequestSchema, async () => {
      resumedSeen += 1;
      return { action: "accept", content: { answer: "ca-central-1" } };
    });
    await resumed.connect(resumedTransport);
    await vi.waitFor(() => expect(resumedSeen).toBe(1));
    await vi.waitFor(async () => expect(await db
      .prepare("SELECT status, answer FROM questions WHERE id=?")
      .get(result.grooming.question_id)).toEqual({ status: "answered", answer: "ca-central-1" }));
    releaseFirst({ action: "decline" });
    await resumed.close();
  });

  it("uses connected capability presence instead of legacy clarification metadata", async () => {
    const seat = await seedMember(db, {
      name: "agent-seat",
      projectId: "demo",
      role: "human",
      metadata: { projectId: "demo", type: "human", clarificationMode: "text" },
    });
    const token = seat.token;
    const client = await connectWithToken(token, { elicitation: true });
    let elicitationCount = 0;
    client.setRequestHandler(ElicitRequestSchema, async () => {
      elicitationCount += 1;
      return { action: "accept", content: { answer: "ap-southeast-2" } };
    });

    const result = await submitAndWait(client, submitArgs);

    await vi.waitFor(() => expect(elicitationCount).toBe(1));
    expect(result.grooming).toMatchObject({
      action: "clarify",
      question: expect.stringMatching(/which region/i),
      question_id: expect.any(Number),
    });
    await vi.waitFor(async () => expect(await db
      .prepare("SELECT status, answer FROM questions WHERE id=?")
      .get(result.grooming.question_id)).toEqual({ status: "answered", answer: "ap-southeast-2" }));
    await client.close();

    // Legacy metadata does not override capability-based connected presence.
    const key = await db
      .prepare('SELECT id FROM apikey WHERE "referenceId" = ? AND name = ?')
      .get<{ id: string }>(seat.userId, "agent-seat");
    await db
      .prepare("UPDATE apikey SET metadata = ? WHERE id = ?")
      .run(
        JSON.stringify({ projectId: "demo", type: "human", clarificationMode: "form" }),
        key!.id,
      );
    const formClient = await connectWithToken(token, { elicitation: true });
    let formCount = 0;
    formClient.setRequestHandler(ElicitRequestSchema, async () => {
      formCount += 1;
      return { action: "accept", content: { answer: "eu-central-1" } };
    });
    const formResult = await submitAndWait(formClient, { ...submitArgs, title: "t-form" });
    await vi.waitFor(() => expect(formCount).toBe(1));
    expect(formResult.grooming.action).toBe("clarify");
    await vi.waitFor(async () => expect(await db
      .prepare("SELECT status, answer FROM questions WHERE id=?")
      .get(formResult.grooming.question_id)).toEqual({ status: "answered", answer: "eu-central-1" }));
    await formClient.close();
  });
});
