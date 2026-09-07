// tests/server-dedup.test.ts
// Deterministic submission dedup + async clarify continuation on human_submit.
// A resubmission of the same content by the same submitter, while the original
// is blocked awaiting a mediator clarification, must not fork a second task:
// the submit response points at the pending task/question inline and tells the
// submitter to answer it. Answering a mediator clarification re-grooms the
// same submission rather than minting a new task.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Db } from "../src/db.js";
import { createApp } from "../src/server.js";
import { FakeDriver } from "../src/mediator/fake.js";
import { DEDUP_WINDOW_MS } from "../src/queue.js";
import type { MediatorWorker } from "../src/mediator/worker.js";
import { openDb } from "../src/db.js";
import { betterAuthReady, seedMember } from "./helpers/auth.js";
import { submitAndWait, waitForHumanJob } from "./helpers/async-human.js";

let httpServer: Server;
let baseUrl: string;
let worker: MediatorWorker;
let db: Db;
let tokH: string; // dana — demo human

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

async function connect(): Promise<Client> {
  const client = new Client({ name: "test", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
    requestInit: { headers: { Authorization: `Bearer ${tokH}` } },
  });
  await client.connect(transport);
  return client;
}

function parse(result: { content?: unknown }) {
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0].text);
}

const clarifyArgs = {
  title: "vague ask",
  body: "CLARIFY: Which region should host it? Recommended: eu-west-1 — it matches the current deployment.",
  project: "demo",
};

async function taskCount(): Promise<number> {
  const row = (await db.prepare("SELECT COUNT(*) AS n FROM tasks").get<{ n: number }>()) as { n: number };
  return row.n;
}

describe("human_submit dedup + async clarify", () => {
  it("resubmitting clarify-pending content returns needs_clarification inline, forks nothing", async () => {
    const client = await connect();

    const first = await submitAndWait(client, clarifyArgs);
    expect(first.grooming.action).toBe("clarify");
    expect(first.grooming.question_id).toEqual(expect.any(Number));
    expect(await taskCount()).toBe(1);

    // Same submitter resubmits the same content while the clarify is open.
    const again = parse(await client.callTool({ name: "human_submit", arguments: clarifyArgs }));
    expect(again.status).toBe("needs_clarification");
    expect(again.duplicate_of).toBe(first.task.id);
    expect(again.task_id).toBe(first.task.id);
    expect(again.question_id).toBe(first.grooming.question_id);
    expect(again.question).toMatch(/which region/i);
    expect(again.question).toContain("Recommended:");
    expect(again.instruction).toMatch(/human_answer/);
    expect(again.instruction).toMatch(/do not resubmit|rather than resubmitting/i);

    // No forked task, and no second question row (double-ask suppression).
    expect(await taskCount()).toBe(1);
    const qn = (await db
      .prepare("SELECT COUNT(*) AS n FROM questions WHERE task_id=? AND asked_by='mediator'")
      .get<{ n: number }>(first.task.id)) as { n: number };
    expect(qn.n).toBe(1);
    await client.close();
  });

  it("answering a mediator clarification re-grooms the same task, no new task", async () => {
    const client = await connect();
    const first = await submitAndWait(client, clarifyArgs);
    expect(await taskCount()).toBe(1);

    const answered = parse(
      await client.callTool({
        name: "human_answer",
        arguments: { question_id: first.grooming.question_id, answer: "eu-west-1" },
      }),
    );
    const grooming = await waitForHumanJob(client, answered.job_id);
    expect(answered.answered).toBe(first.grooming.question_id);
    expect(answered.regroomed).toBe(true);
    // The re-groom saw the answered Q&A and admitted the same submission.
    expect(grooming.action).toBe("accept");
    const task = parse(await client.callTool({
      name: "human_task_status", arguments: { task_id: first.task.id },
    })).task;
    expect(task.id).toBe(first.task.id);
    expect(task.state).toBe("QUEUED");
    expect(await taskCount()).toBe(1);
    await client.close();
  });

  it("a resubmission outside the dedup window opens a fresh task (window-miss)", async () => {
    const client = await connect();
    const first = await submitAndWait(client, clarifyArgs);
    // Age the original past the dedup window.
    await db
      .prepare("UPDATE tasks SET created_at=? WHERE id=?")
      .run(Date.now() - DEDUP_WINDOW_MS - 1000, first.task.id);

    const again = parse(await client.callTool({ name: "human_submit", arguments: clarifyArgs }));
    // Fresh submission: it grooms normally, not a dedup pointer.
    expect(again.status).not.toBe("needs_clarification");
    expect(again.task.id).not.toBe(first.task.id);
    expect(await taskCount()).toBe(2);
    await client.close();
  });
});
