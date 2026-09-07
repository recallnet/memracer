// tests/server-conversations.test.ts
// Multi-human conflict conversations over MCP (#77): two members' conflicting
// submissions open a conversation; each replies from their own session at their
// own time; human_status surfaces it; the last reply conciliates it closed.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Db } from "../src/db.js";
import { createApp } from "../src/server.js";
import { FakeDriver } from "../src/mediator/fake.js";
import type { MediatorWorker } from "../src/mediator/worker.js";
import { openDb } from "../src/db.js";
import { betterAuthReady, seedMember } from "./helpers/auth.js";
import { submitAndWait, waitForHumanJob } from "./helpers/async-human.js";

let httpServer: Server;
let baseUrl: string;
let worker: MediatorWorker;
let db: Db;
const tokens: Record<string, string> = {};

beforeEach(async () => {
  db = openDb(":memory:");
  await betterAuthReady(db);
  await db.prepare("INSERT INTO projects (id, name, repo) VALUES ('demo','Demo','recallnet/demo-app')").run();
  for (const [tok, name] of [["tok-dana", "dana"], ["tok-rui", "rui"], ["tok-mara", "mara"]]) {
    tokens[tok] = (await seedMember(db, { name, projectId: "demo", role: "human" })).token;
  }
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

const args = (title: string, body: string) => ({ title, body, project: "demo" });

describe("multi-human conflict conversations over MCP", () => {
  it("conflicting submissions open a conversation; both reply cross-session; last reply closes it into a decision", async () => {
    const dana = await connect("tok-dana");
    const rui = await connect("tok-rui");

    const first = await submitAndWait(dana, args("Add cache", "add a cache layer"));
    expect(first.grooming.action).toBe("accept");
    const danaTask = first.task.id;

    // rui files the same ask — groom opens a conflict conversation, holds both.
    const second = await submitAndWait(rui, args("Add cache", "add a cache layer"));
    expect(second.grooming.action).toBe("conflict");
    const convId = second.grooming.conversation_id;
    const ruiTask = second.grooming.with_task_id === danaTask ? second.task.id : second.grooming.task_id;
    expect(second.task.state).toBe("HELD");

    // Both see it in human_status, awaiting both replies.
    const danaStatus = parse(await dana.callTool({ name: "human_status", arguments: {} }));
    expect(danaStatus.open_conversations).toHaveLength(1);
    expect(danaStatus.open_conversations[0].conversation_id).toBe(convId);
    expect(danaStatus.open_conversations[0].awaiting_reply_from.sort()).toEqual(["dana", "rui"]);
    const ruiStatus = parse(await rui.callTool({ name: "human_status", arguments: {} }));
    expect(ruiStatus.open_conversations[0].conversation_id).toBe(convId);

    // A non-participant cannot reply.
    const mara = await connect("tok-mara");
    const maraTry = (await mara.callTool({
      name: "human_conversation_reply",
      arguments: { conversation_id: convId, message: "hi" },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(maraTry.isError).toBe(true);
    expect(maraTry.content[0].text).toMatch(/not a participant/);
    await mara.close();

    // dana replies first (own session, own time) — recorded, awaiting rui.
    const r1 = parse(
      await dana.callTool({
        name: "human_conversation_reply",
        arguments: { conversation_id: convId, message: `keep #${danaTask}. RESOLVE: merge into ${danaTask}` },
      }),
    );
    expect(r1.recorded).toBe(true);
    expect(r1.all_replied).toBe(false);
    expect(r1.awaiting_reply_from).toEqual(["rui"]);

    // rui replies second — the round completes, the mediator conciliates & closes.
    const r2 = parse(
      await rui.callTool({
        name: "human_conversation_reply",
        arguments: { conversation_id: convId, message: "agreed" },
      }),
    );
    const conciliation = await waitForHumanJob(rui, r2.job_id);
    expect(r2.all_replied).toBe(true);
    expect(conciliation.settled).toBe(true);
    expect(conciliation.state).toBe("CLOSED");

    // Outcome applied: dana's task survives (QUEUED), rui's dup closed.
    const danaBrief = await db.prepare("SELECT state FROM tasks WHERE id=?").get<{ state: string }>(danaTask);
    const ruiBrief = await db.prepare("SELECT state FROM tasks WHERE id=?").get<{ state: string }>(ruiTask);
    expect(danaBrief?.state).toBe("QUEUED");
    expect(ruiBrief?.state).toBe("DONE");

    // The close is provenance-linked to a decision.
    const linked = await db
      .prepare("SELECT COUNT(*) AS n FROM conversation_decisions WHERE conversation_id=?")
      .get<{ n: number }>(convId);
    expect(linked!.n).toBeGreaterThanOrEqual(1);

    // Once closed, it drops out of human_status.
    const after = parse(await dana.callTool({ name: "human_status", arguments: {} }));
    expect(after.open_conversations).toHaveLength(0);

    await dana.close();
    await rui.close();
  });
});
