// tests/mediator-incubation.test.ts
//
// Warming period end-to-end (#61): human_submit with warm_for lands an
// INCUBATING task off the coder queue; when its clock strikes, the running
// worker's sweep fires the seal groom, which graduates it to QUEUED — at which
// point a coder can finally claim it. Deterministic via FakeDriver.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openDb } from "../src/db.js";
import { betterAuthReady, seedMember } from "./helpers/auth.js";
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
  tokens["tok-h"] = (await seedMember(dbRef, { name: "dana", projectId: "demo", role: "human" })).token;
  tokens["tok-other"] = (await seedMember(dbRef, { name: "erin", projectId: "demo", role: "human" })).token;
  tokens["tok-admin"] = (await seedMember(dbRef, { name: "al", projectId: "demo", role: "admin" })).token;
  tokens["tok-c"] = (await seedMember(dbRef, { name: "cc-7f2", projectId: "demo", role: "coder" })).token;
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

async function stateOf(taskId: number): Promise<string> {
  const row = await dbRef.prepare("SELECT state FROM tasks WHERE id=?").get<{ state: string }>(taskId);
  return row!.state;
}

async function waitForState(taskId: number, want: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await stateOf(taskId)) === want) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  expect(await stateOf(taskId)).toBe(want);
}

describe("warming period over MCP", () => {
  it("human_submit warm_for lands INCUBATING, off the coder queue, then graduates via the seal groom", async () => {
    const dana = await connect("tok-h");
    const submitted = parse(await dana.callTool({
      name: "human_submit",
      arguments: { title: "warm idea", body: "b", evidence: [], warm_for: "1h" },
    }));
    const taskId = submitted.task.id;
    expect(submitted.task.state).toBe("INCUBATING");
    expect(submitted.task.incubate_until).toBeGreaterThan(Date.now());

    // A coder cannot claim it while it incubates.
    expect(await queue.claimNext("demo", "cc-7f2", DEFAULT_LEASE_TTL_MS)).toBeNull();

    // The clock strikes (simulate graduation time arriving).
    await dbRef.prepare("UPDATE tasks SET incubate_until=? WHERE id=?").run(Date.now() - 1, taskId);

    // The worker sweep runs the seal groom and graduates the task.
    await waitForState(taskId, "QUEUED");

    // A seal groom thread was recorded (the graduation groom pass ran).
    const groomThreads = await dbRef
      .prepare("SELECT COUNT(*) AS n FROM threads WHERE task_id=? AND kind='groom'")
      .get<{ n: number }>(taskId);
    expect(groomThreads!.n).toBeGreaterThanOrEqual(1);

    // Now a coder claims it.
    const claimed = await queue.claimNext("demo", "cc-7f2", DEFAULT_LEASE_TTL_MS);
    expect(claimed?.id).toBe(taskId);
  });

  it("human_seal_incubation graduates early; human_extend_incubation pushes the clock; both gated", async () => {
    const dana = await connect("tok-h");
    const cc = await connect("tok-c");

    const submitted = parse(await dana.callTool({
      name: "human_submit",
      arguments: { title: "warm 2", body: "b", evidence: [], warm_for: "1d" },
    }));
    const taskId = submitted.task.id;
    expect(submitted.task.state).toBe("INCUBATING");

    // A coder has no human_seal_incubation tool at all (human-only surface).
    const coderTools = (await cc.listTools()).tools.map((t) => t.name);
    expect(coderTools).not.toContain("human_seal_incubation");

    // Extend pushes the clock further out; still INCUBATING.
    const extended = parse(await dana.callTool({
      name: "human_extend_incubation",
      arguments: { task_id: taskId, warm_for: "1w" },
    }));
    expect(extended.extended).toBe(true);
    expect(extended.task.state).toBe("INCUBATING");
    expect(extended.task.incubate_until).toBeGreaterThan(submitted.task.incubate_until);

    // Seal early graduates it now.
    const sealed = parse(await dana.callTool({
      name: "human_seal_incubation",
      arguments: { task_id: taskId },
    }));
    expect(sealed.sealed).toBe(true);
    expect(sealed.task.state).toBe("QUEUED");

    // Sealing a non-incubating task is refused with a clear reason.
    const again = await dana.callTool({ name: "human_seal_incubation", arguments: { task_id: taskId } });
    expect(again.isError).toBe(true);
    expect((again.content as { text: string }[])[0].text).toMatch(/not INCUBATING/i);
  });

  it("an existing QUEUED task can warm, report its countdown, and auto-graduate through the seal groom", async () => {
    const dana = await connect("tok-h");
    const coder = await connect("tok-c");
    const submitted = parse(await dana.callTool({
      name: "human_submit",
      arguments: { title: "warm after filing", body: "b", evidence: [] },
    }));
    expect(submitted.task.state).toBe("QUEUED");

    const warmed = parse(await dana.callTool({
      name: "human_warm_task",
      arguments: { task_id: submitted.task.id, warm_for: "PT1S" },
    }));
    expect(warmed.task.state).toBe("INCUBATING");
    const status = parse(await dana.callTool({ name: "human_status", arguments: {} }));
    const visible = status.projects.demo.tasks.find((task: { id: number }) => task.id === submitted.task.id);
    expect(visible).toMatchObject({ state: "INCUBATING" });
    expect(visible.incubate_until).toBeGreaterThan(Date.now());
    expect(await queue.claimNext("demo", "cc-7f2", DEFAULT_LEASE_TTL_MS)).toBeNull();

    await waitForState(submitted.task.id, "QUEUED");
    const claimed = parse(await coder.callTool({
      name: "coder_claim_task",
      arguments: {},
    }));
    expect(claimed.id).toBe(submitted.task.id);

    await dana.close();
    await coder.close();
  });

  it("human_warm_task moves QUEUED work off the coder queue; submitter/admin auth and state errors are explicit", async () => {
    const dana = await connect("tok-h");
    const erin = await connect("tok-other");
    const admin = await connect("tok-admin");
    const coder = await connect("tok-c");

    const submitted = parse(await dana.callTool({
      name: "human_submit",
      arguments: { title: "needs research", body: "b", evidence: [] },
    }));
    const taskId = submitted.task.id;
    expect(submitted.task.state).toBe("QUEUED");

    const coderTools = (await coder.listTools()).tools.map((t) => t.name);
    expect(coderTools).not.toContain("human_warm_task");

    const denied = await erin.callTool({
      name: "human_warm_task",
      arguments: { task_id: taskId, warm_for: "1d" },
    });
    expect(denied.isError).toBe(true);
    expect((denied.content as { text: string }[])[0].text).toMatch(/only dana.*submitter.*admin/i);
    expect(await stateOf(taskId)).toBe("QUEUED");

    const warmed = parse(await admin.callTool({
      name: "human_warm_task",
      arguments: { task_id: taskId, warm_for: "PT30M" },
    }));
    expect(warmed.warmed).toBe(true);
    expect(warmed.task).toMatchObject({ id: taskId, state: "INCUBATING" });
    expect(warmed.task.incubate_until).toBeGreaterThan(Date.now());
    expect(await queue.claimNext("demo", "cc-7f2", DEFAULT_LEASE_TTL_MS)).toBeNull();

    const alreadyWarm = await dana.callTool({
      name: "human_warm_task",
      arguments: { task_id: taskId, warm_for: "1h" },
    });
    expect(alreadyWarm.isError).toBe(true);
    expect((alreadyWarm.content as { text: string }[])[0].text).toMatch(
      /already warming.*human_extend_incubation.*human_seal_incubation/i,
    );

    const extended = parse(await dana.callTool({
      name: "human_extend_incubation",
      arguments: { task_id: taskId, warm_for: "1w" },
    }));
    expect(extended.task.state).toBe("INCUBATING");
    expect(extended.task.incubate_until).toBeGreaterThan(warmed.task.incubate_until);

    await dana.callTool({ name: "human_seal_incubation", arguments: { task_id: taskId } });
    const claimed = await queue.claimNext("demo", "cc-7f2", DEFAULT_LEASE_TTL_MS);
    expect(claimed?.id).toBe(taskId);
    const inFlight = await dana.callTool({
      name: "human_warm_task",
      arguments: { task_id: taskId, warm_for: "1h" },
    });
    expect(inFlight.isError).toBe(true);
    expect((inFlight.content as { text: string }[])[0].text).toMatch(
      /CLAIMED, not QUEUED.*only an unclaimed QUEUED task/i,
    );

    const heldId = await queue.submit("demo", "dana", {
      title: "deferred",
      body: "b",
      evidence: [],
    });
    await queue.holdForConversation(heldId, "deferred for discussion");
    const held = await dana.callTool({
      name: "human_warm_task",
      arguments: { task_id: heldId, warm_for: "1h" },
    });
    expect(held.isError).toBe(true);
    expect((held.content as { text: string }[])[0].text).toMatch(
      /HELD, not QUEUED.*human_discuss.*reopen.*QUEUED.*warm/i,
    );

    await dana.close();
    await erin.close();
    await admin.close();
    await coder.close();
  });

  it("human_followup warm_for lands INCUBATING, off the coder queue (#453)", async () => {
    const dana = await connect("tok-h");
    // Seed a DONE parent so followup is legal.
    const parentId = await queue.submit("demo", "dana", {
      title: "done parent",
      body: "already shipped",
      evidence: [],
    });
    await dbRef
      .prepare("UPDATE tasks SET state='DONE', updated_at=? WHERE id=?")
      .run(Date.now(), parentId);

    const followup = parse(
      await dana.callTool({
        name: "human_followup",
        arguments: {
          task_id: parentId,
          title: "held correction",
          body: "do not start yet",
          evidence: [],
          warm_for: "1d",
        },
      }),
    );
    expect(followup.parent_id).toBe(parentId);
    expect(followup.task.state).toBe("INCUBATING");
    expect(followup.task.incubate_until).toBeGreaterThan(Date.now());
    expect(await queue.claimNext("demo", "cc-7f2", DEFAULT_LEASE_TTL_MS)).toBeNull();

    await dana.close();
  });
});
