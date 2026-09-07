// tests/mcp-resource-db-contract.test.ts
// The new read-only MCP resources execute through both production DB dialects.
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Member } from "../src/auth.js";
import { openDb, type Db } from "../src/db.js";
import { MemoryStore } from "../src/mediator/memory.js";
import type { MediatorWorker } from "../src/mediator/worker.js";
import { Queue } from "../src/queue.js";
import { buildServer } from "../src/tools.js";
import { openPgliteDb } from "./helpers/pglite.js";

const backends: Array<{ name: string; open: () => Promise<Db> }> = [
  { name: "sqlite", open: async () => openDb(":memory:") },
  { name: "postgres", open: openPgliteDb },
];

const member: Member = {
  token: "unused-direct-transport-token",
  name: "db-contract-human",
  memberships: [{
    projectId: "demo",
    projectName: "Demo",
    repo: "recallnet/demo-app",
    role: "human",
    orgId: null,
    orgName: null,
  }],
};

describe.each(backends)("MCP resource DB contract ($name)", ({ open }) => {
  it("lists and reads project, queue, question, and OKF resources", async () => {
    const db = await open();
    await db.prepare("INSERT INTO projects (id, name, repo) VALUES ('demo','Demo','recallnet/demo-app')").run();
    const now = Date.now();
    const task = await db.prepare(
      `INSERT INTO tasks (project_id, title, body, submitted_by, created_at, updated_at)
       VALUES ('demo','Portable resource','private body','dana',?,?) RETURNING id`,
    ).get<{ id: number }>(now, now);
    const question = await db.prepare(
      `INSERT INTO questions (project_id, task_id, asked_by, question, created_at)
       VALUES ('demo',?,'mediator','Which boundary?',?) RETURNING id`,
    ).get<{ id: number }>(task!.id, now);
    await new MemoryStore(db).upsert("demo", {
      path: "tech/portable.md",
      type: "Architecture",
      title: "Portable MCP",
      description: "The protocol is host-neutral.",
      tags: ["mcp"],
      body: "# Overview\n\nThe DB is authoritative.",
    });

    const server = buildServer(new Queue(db), member, {} as MediatorWorker, db);
    const client = new Client({ name: "db-contract", version: "0.0.1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const uris = (await client.listResources()).resources.map((resource) => resource.uri);
    expect(uris).toEqual(expect.arrayContaining([
      "project://demo",
      "queue://demo",
      `question://${question!.id}`,
      "okf://demo/index.md",
      "okf://demo/tech/portable.md",
    ]));
    const queueSnapshot = JSON.parse((await client.readResource({ uri: "queue://demo" })).contents[0].text!);
    expect(queueSnapshot).toEqual(expect.objectContaining({ project_id: "demo", total: 1, returned: 1 }));
    const concept = (await client.readResource({ uri: "okf://demo/tech/portable.md" })).contents[0].text!;
    expect(concept).toContain("The DB is authoritative.");

    await client.close();
    await server.close();
    await db.close();
  });
});
