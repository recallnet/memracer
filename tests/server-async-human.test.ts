import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openDb } from "../src/db.js";
import { createApp } from "../src/server.js";
import { FakeDriver } from "../src/mediator/fake.js";
import type { MediatorContext, Submission } from "../src/mediator/driver.js";
import type { MediatorWorker } from "../src/mediator/worker.js";
import { betterAuthReady, seedMember } from "./helpers/auth.js";
import { parseToolResult, waitForHumanJob } from "./helpers/async-human.js";

class GatedGroomDriver extends FakeDriver {
  private releaseGroom!: () => void;
  private readonly gate = new Promise<void>((resolve) => { this.releaseGroom = resolve; });

  release(): void {
    this.releaseGroom();
  }

  override async groom(ctx: MediatorContext, submission: Submission) {
    await this.gate;
    return super.groom(ctx, submission);
  }
}

let db: ReturnType<typeof openDb>;
let server: Server;
let worker: MediatorWorker;
let baseUrl: string;
let token: string;
let driver: GatedGroomDriver;

beforeEach(async () => {
  db = openDb(":memory:");
  await betterAuthReady(db);
  await db.prepare("INSERT INTO projects (id, name) VALUES ('demo','Demo')").run();
  token = (await seedMember(db, { name: "dana", projectId: "demo", role: "human" })).token;
  driver = new GatedGroomDriver();
  const made = createApp(db, {
    driverFor: () => driver,
    workerOpts: { tickMs: 10, jobTimeoutMs: 300_000 },
  });
  worker = made.worker;
  await new Promise<void>((resolve) => {
    server = made.app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});

afterEach(async () => {
  driver.release();
  worker.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function connect(): Promise<Client> {
  const client = new Client({ name: "async-human-test", version: "0.0.1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(baseUrl), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  return client;
}

describe("asynchronous human write path", () => {
  it("rejects content-free submissions before persistence", async () => {
    driver.release();
    const client = await connect();
    for (const [title, body, field] of [
      ["", "real body", "title"],
      ["real title", "  \n\t", "body"],
      ["...", "…", "title"],
      ["real title", "...", "body"],
    ] as const) {
      const result = await client.callTool({
        name: "human_submit",
        arguments: { project: "demo", title, body, evidence: [] },
      }) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
      expect(result.isError).toBe(true);
      expect(result.content.map((item) => item.text ?? "").join("\n")).toContain(
        `${field} must describe the requested work`,
      );
    }
    expect(await db.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 0 });
    await client.close();
  });

  it("acknowledges a groom that can outlive the edge and deduplicates concurrent retries", async () => {
    const firstClient = await connect();
    const retryClient = await connect();
    const args = {
      project: "demo",
      title: "Long groom",
      body: "FEATURE: hold mediator work beyond the edge deadline",
      evidence: [],
      idempotency_key: "request-123",
    };

    const started = Date.now();
    const [first, retry] = await Promise.all([
      firstClient.callTool({ name: "human_submit", arguments: args }),
      retryClient.callTool({ name: "human_submit", arguments: args }),
    ]).then((results) => results.map(parseToolResult));

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(first.task_id).toBe(retry.task_id);
    expect([first.state, retry.state]).toContain("GROOMING");
    expect(await db.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 1 });

    const jobId = first.job_id ?? retry.job_id;
    expect(jobId).toEqual(expect.any(Number));
    const pending = parseToolResult(await firstClient.callTool({
      name: "human_task_status", arguments: { task_id: first.task_id },
    }));
    expect(pending.task.state).toBe("GROOMING");
    expect(["pending", "running"]).toContain(pending.grooming.status);

    driver.release();
    expect(await waitForHumanJob(firstClient, jobId)).toMatchObject({ action: "accept" });
    const done = parseToolResult(await firstClient.callTool({
      name: "human_task_status", arguments: { task_id: first.task_id },
    }));
    expect(done.task.state).toBe("QUEUED");
    expect(done.grooming).toMatchObject({ status: "done", result: { action: "accept" } });

    const laterRetry = parseToolResult(await retryClient.callTool({
      name: "human_submit",
      arguments: { ...args, title: "Changed retry payload" },
    }));
    expect(laterRetry).toMatchObject({
      task_id: first.task_id,
      state: "QUEUED",
      job_id: jobId,
      idempotent_replay: true,
    });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 1 });

    await firstClient.close();
    await retryClient.close();
  });

  it("returns from human_discuss before applying its edit", async () => {
    driver.release();
    const client = await connect();
    const submit = parseToolResult(await client.callTool({
      name: "human_submit",
      arguments: { title: "Obsolete", body: "b", evidence: [] },
    }));
    await waitForHumanJob(client, submit.job_id);

    const ack = parseToolResult(await client.callTool({
      name: "human_discuss",
      arguments: { message: `close task ${submit.task_id}: superseded` },
    }));
    expect(ack).toMatchObject({ state: "PROCESSING", job_id: expect.any(Number) });
    expect(await waitForHumanJob(client, ack.job_id)).toMatchObject({
      applied: [{ action: "close_task", task_id: submit.task_id, reason: "superseded" }],
    });
    expect(await db.prepare("SELECT state FROM tasks WHERE id=?").get(submit.task_id)).toEqual({ state: "DONE" });
    await client.close();
  });

  it("wait=true falls back to GROOMING when the bounded window expires", async () => {
    const previous = process.env.MEMRACER_GROOM_WAIT_MS;
    process.env.MEMRACER_GROOM_WAIT_MS = "25";
    const client = await connect();
    try {
      const started = Date.now();
      const result = parseToolResult(await client.callTool({
        name: "human_submit",
        arguments: {
          project: "demo",
          title: "Bounded wait",
          body: "FEATURE: groom remains gated beyond the requested wait",
          evidence: [],
          wait: true,
        },
      }));
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(result).toMatchObject({
        state: "GROOMING",
        grooming: { status: expect.stringMatching(/pending|running/) },
        pending_clarifications: [],
      });
      driver.release();
      expect(await waitForHumanJob(client, result.job_id)).toMatchObject({ action: "accept" });
    } finally {
      if (previous === undefined) delete process.env.MEMRACER_GROOM_WAIT_MS;
      else process.env.MEMRACER_GROOM_WAIT_MS = previous;
      await client.close();
    }
  });
});
