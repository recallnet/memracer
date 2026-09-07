// tests/server-prompts-resources.test.ts
// Agent-agnostic MCP prompts and read-only resources over Streamable HTTP.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Db } from "../src/db.js";
import { createApp } from "../src/server.js";
import { FakeDriver } from "../src/mediator/fake.js";
import type { MediatorWorker } from "../src/mediator/worker.js";
import { Queue } from "../src/queue.js";
import { MemoryStore } from "../src/mediator/memory.js";
import { openDb } from "../src/db.js";
import { betterAuthReady, seedMember, grantMembership } from "./helpers/auth.js";

let httpServer: Server;
let baseUrl: string;
let worker: MediatorWorker;
let db: Db;
const tokens: Record<string, string> = {};
const actorIds: Record<string, string> = {};
let queue: Queue;

beforeEach(async () => {
  db = openDb(":memory:");
  await betterAuthReady(db);
  await db.prepare("INSERT INTO projects (id, name, repo) VALUES ('demo','Demo','recallnet/demo-app')").run();
  await db.prepare("INSERT INTO projects (id, name, repo) VALUES ('beta','Beta','recallnet/beta-app')").run();
  const human = await seedMember(db, { name: "dana", projectId: "demo", role: "human" });
  await grantMembership(db, human.userId, { projectId: "beta", role: "human" });
  tokens["tok-h"] = human.token;
  const coder = await seedMember(db, { name: "cc-7f2", projectId: "demo", role: "coder" });
  tokens["tok-c"] = coder.token;
  actorIds["tok-c"] = coder.keyId;
  tokens["tok-a"] = (await seedMember(db, { name: "admin-al", projectId: "demo", role: "admin" })).token;
  tokens["tok-beta"] = (await seedMember(db, { name: "bella", projectId: "beta", role: "human" })).token;
  const made = createApp(db, {
    driverFor: () => new FakeDriver(),
    workerOpts: { tickMs: 20, jobTimeoutMs: 2000 },
  });
  worker = made.worker;
  queue = made.queue;
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

function promptText(result: { messages: { role: string; content: unknown }[] }): string {
  const content = result.messages[0].content as { type: string; text: string };
  expect(result.messages[0].role).toBe("user");
  expect(content.type).toBe("text");
  return content.text;
}

function resourceText(result: { contents: unknown[] }): string {
  const content = result.contents[0] as { text?: string };
  expect(content.text).toEqual(expect.any(String));
  return content.text!;
}

describe("MCP prompts", () => {
  it("advertises the role-specific prompt matrix through generic MCP", async () => {
    const human = await connect("tok-h");
    const coder = await connect("tok-c");
    const admin = await connect("tok-a");

    expect((await human.listPrompts()).prompts.map((p) => p.name).sort())
      .toEqual(["answer", "review", "status", "submit"]);
    expect((await coder.listPrompts()).prompts.map((p) => p.name)).toEqual(["drain"]);
    expect((await admin.listPrompts()).prompts.map((p) => p.name).sort())
      .toEqual(["answer", "drain", "review", "status", "submit"]);

    await human.close();
    await coder.close();
    await admin.close();
  });

  it("submit prompt instructs gathering evidence and calling human_submit", async () => {
    const human = await connect("tok-h");
    const got = await human.getPrompt({
      name: "submit",
      arguments: { idea: "rate limit /api/ingest" },
    });
    const text = promptText(got as never);
    expect(text).toContain("rate limit /api/ingest");
    expect(text).toContain("human_submit");
    expect(text).toMatch(/evidence/i);
    await human.close();
  });

  it("status prompt instructs calling human_status", async () => {
    const human = await connect("tok-h");
    const got = await human.getPrompt({ name: "status", arguments: {} });
    const text = promptText(got as never);
    expect(text).toContain("human_status");
    await human.close();
  });

  it("human prompts use only the durable human tools and preserve mediator plan ownership", async () => {
    const human = await connect("tok-h");
    const answer = promptText(await human.getPrompt({
      name: "answer",
      arguments: { question_id: "41", answer: "Keep the existing boundary." },
    }) as never);
    expect(answer).toContain("question://41");
    expect(answer).toContain("human_answer");
    expect(answer).toContain("Keep the existing boundary.");

    const review = promptText(await human.getPrompt({
      name: "review",
      arguments: { task_id: "17" },
    }) as never);
    expect(review).toContain("task://17");
    expect(review).toMatch(/findings/i);
    expect(review).toMatch(/plan approval before execution/i);
    expect(review).toMatch(/mediator.*approv|approv.*mediator/i);
    expect(review).not.toMatch(/call coder_propose_plan/i);

    await expect(human.getPrompt({ name: "answer", arguments: { question_id: "41" } }))
      .rejects.toThrow();
    await human.close();
  });

  it("drain prompt is host-neutral and carries the complete non-claiming check loop", async () => {
    const coder = await connect("tok-c");
    const text = promptText(await coder.getPrompt({ name: "drain", arguments: {} }) as never);
    const lifecycle = [
      "coder_check_work",
      "coder_claim_task",
      "coder_propose_plan",
      "coder_progress",
      "coder_complete",
      "coder_check_work",
    ];
    let cursor = -1;
    for (const tool of lifecycle) {
      cursor = text.indexOf(tool, cursor + 1);
      expect(cursor, `${tool} must appear in lifecycle order`).toBeGreaterThan(-1);
    }
    expect(text).toMatch(/90.second|timeout_s.?=.?90/i);
    expect(text).toMatch(/off.model|background/i);
    expect(text).toMatch(/null|race/i);
    expect(text).not.toMatch(/Claude Code|Stop.?hook|coder_wait_for_work/i);
    await coder.close();
  });
});

describe("MCP task resources", () => {
  it("lists tasks in the member's projects as task://<id> and excludes other projects", async () => {
    const demoTask = await queue.submit("demo", "dana", { title: "Demo task", body: "b", evidence: [] });
    const betaTask = await queue.submit("beta", "bella", { title: "Beta task", body: "b", evidence: [] });

    const human = await connect("tok-h");
    const listed = (await human.listResources()).resources;
    const uris = listed.map((r) => r.uri);
    expect(uris).toContain(`task://${demoTask}`);
    expect(uris).not.toContain(`task://${betaTask}`);
    const demo = listed.find((r) => r.uri === `task://${demoTask}`)!;
    expect(demo.name).toContain("Demo task");
    await human.close();
  });

  it("readResource returns the full task brief JSON", async () => {
    const id = await queue.submit("demo", "dana", {
      title: "Add rate limiting",
      body: "429 + Retry-After",
      evidence: [{ kind: "code", path: "middleware/ingest.ts", lines: "40-52" }],
    });
    const human = await connect("tok-h");
    const got = await human.readResource({ uri: `task://${id}` });
    const content = got.contents[0] as { uri: string; mimeType?: string; text: string };
    expect(content.uri).toBe(`task://${id}`);
    expect(content.mimeType).toBe("application/json");
    const brief = JSON.parse(content.text);
    expect(brief.id).toBe(id);
    expect(brief.title).toBe("Add rate limiting");
    expect(brief.evidence).toEqual([
      { id: expect.any(Number), kind: "code", path: "middleware/ingest.ts", lines: "40-52", snippet: null, note: null },
    ]);
    await human.close();
  });

  it("refuses reading a task outside the member's projects", async () => {
    const betaTask = await queue.submit("beta", "bella", { title: "Beta task", body: "b", evidence: [] });
    const human = await connect("tok-h");
    await expect(human.readResource({ uri: `task://${betaTask}` })).rejects.toThrow();
    await human.close();
  });

  it("refuses reading a task that does not exist", async () => {
    const human = await connect("tok-h");
    await expect(human.readResource({ uri: "task://99999" })).rejects.toThrow();
    await human.close();
  });

  it("coder members can also read task resources in their projects", async () => {
    const id = await queue.submit("demo", "dana", { title: "Coder-visible", body: "b", evidence: [] });
    const coder = await connect("tok-c");
    const got = await coder.readResource({ uri: `task://${id}` });
    const brief = JSON.parse((got.contents[0] as { text: string }).text);
    expect(brief.id).toBe(id);
    await coder.close();
  });
});

describe("MCP project resources", () => {
  async function seedProjectResources() {
    const demoTask = await queue.submit("demo", "dana", {
      title: "Demo task",
      body: "private implementation detail",
      evidence: [],
    });
    const betaTask = await queue.submit("beta", "bella", {
      title: "Beta task",
      body: "foreign implementation detail",
      evidence: [],
    });
    const demoQuestion = await db.prepare(
      `INSERT INTO questions
         (project_id, task_id, asked_by, question, answer, status, created_at, answered_at)
       VALUES ('demo', ?, 'mediator', 'Which retry policy?', 'Bounded exponential backoff', 'answered', 10, 20)
       RETURNING id`,
    ).get<{ id: number }>(demoTask);
    const betaQuestion = await db.prepare(
      `INSERT INTO questions (project_id, task_id, asked_by, question, created_at)
       VALUES ('beta', ?, 'mediator', 'Foreign question?', 10)
       RETURNING id`,
    ).get<{ id: number }>(betaTask);
    const memory = new MemoryStore(db);
    await memory.upsert("demo", {
      path: "tech/routing.md",
      type: "Architecture",
      title: "Request routing",
      description: "How requests reach a project.",
      tags: ["mcp"],
      body: "# Overview\n\nTokens select exactly one project.",
    });
    await memory.upsert("beta", {
      path: "tech/foreign.md",
      type: "Architecture",
      title: "Foreign knowledge",
      description: "Must remain scoped.",
      tags: [],
      body: "# Hidden",
    });
    return {
      demoTask,
      betaTask,
      demoQuestion: demoQuestion!.id,
      betaQuestion: betaQuestion!.id,
    };
  }

  it("advertises host-neutral URI templates", async () => {
    const human = await connect("tok-h");
    const templates = (await human.listResourceTemplates()).resourceTemplates;
    expect(templates.map((template) => template.uriTemplate).sort()).toEqual([
      "okf://{project}/{+path}",
      "project://{id}",
      "question://{id}",
      "queue://{project}",
      "task://{id}",
    ]);
    const listProjects = (await human.listTools()).tools.find((tool) => tool.name === "list_projects");
    expect(listProjects?.annotations).toEqual(expect.objectContaining({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    }));
    await human.close();
  });

  it("lists only bounded resources from the API key's resolved project", async () => {
    const seeded = await seedProjectResources();
    const human = await connect("tok-h");
    const resources = (await human.listResources()).resources;
    const uris = resources.map((resource) => resource.uri);

    expect(uris).toContain("project://demo");
    expect(uris).toContain("queue://demo");
    expect(uris).toContain(`task://${seeded.demoTask}`);
    expect(uris).toContain(`question://${seeded.demoQuestion}`);
    expect(uris).toContain("okf://demo/index.md");
    expect(uris).toContain("okf://demo/tech/index.md");
    expect(uris).toContain("okf://demo/tech/routing.md");
    expect(uris).not.toContain("project://beta");
    expect(uris).not.toContain("queue://beta");
    expect(uris).not.toContain(`task://${seeded.betaTask}`);
    expect(uris).not.toContain(`question://${seeded.betaQuestion}`);
    expect(uris.some((uri) => uri.startsWith("okf://beta/"))).toBe(false);
    await human.close();
  });

  it("reads safe project metadata and a compact, capped queue snapshot", async () => {
    await seedProjectResources();
    for (let i = 0; i < 105; i += 1) {
      await queue.submit("demo", "dana", {
        title: `Bounded task ${i}`,
        body: `secret body ${i}`,
        evidence: [],
      });
    }
    await db.prepare(
      `UPDATE tasks SET state='DONE'
       WHERE id IN (SELECT id FROM tasks WHERE project_id='demo' ORDER BY id ASC LIMIT 101)`,
    ).run();
    const human = await connect("tok-h");

    const project = JSON.parse(resourceText(await human.readResource({ uri: "project://demo" })));
    expect(project).toEqual({ id: "demo", name: "Demo", repo: "recallnet/demo-app", role: "human" });
    expect(JSON.stringify(project)).not.toMatch(/mediator_model|attention_|created_by|token|key/i);

    const snapshot = JSON.parse(resourceText(await human.readResource({ uri: "queue://demo" })));
    expect(snapshot.project_id).toBe("demo");
    expect(snapshot.total).toBe(106);
    expect(snapshot.returned).toBe(100);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.tasks).toHaveLength(100);
    expect(snapshot.state_counts).toEqual({ DONE: 101, QUEUED: 5 });
    expect(snapshot.tasks[0].state).toBe("QUEUED");
    expect(snapshot.tasks[0]).toEqual(expect.objectContaining({
      id: expect.any(Number),
      title: expect.any(String),
      state: expect.any(String),
      priority: expect.any(Number),
    }));
    expect(JSON.stringify(snapshot)).not.toMatch(/secret body|result_pr_description|"plan"|lease_ttl_ms/);
    const listedTasks = (await human.listResources()).resources.filter((resource) => resource.uri.startsWith("task://"));
    expect(listedTasks).toHaveLength(100);
    await human.close();
  });

  it("presents verified actor labels instead of internal API-key ids", async () => {
    const seeded = await seedProjectResources();
    await db.prepare("UPDATE tasks SET lease_agent=? WHERE id=?").run(actorIds["tok-c"], seeded.demoTask);
    await db.prepare("UPDATE questions SET asked_by=? WHERE id=?").run(actorIds["tok-c"], seeded.demoQuestion);
    await db.prepare(
      "INSERT INTO attempts (task_id, agent, outcome, notes, created_at) VALUES (?, ?, 'released', 'retry', 30)",
    ).run(seeded.demoTask, actorIds["tok-c"]);
    const human = await connect("tok-h");

    const queueSnapshot = resourceText(await human.readResource({ uri: "queue://demo" }));
    const question = resourceText(await human.readResource({ uri: `question://${seeded.demoQuestion}` }));
    const task = resourceText(await human.readResource({ uri: `task://${seeded.demoTask}` }));
    expect(queueSnapshot).not.toContain(actorIds["tok-c"]);
    expect(question).not.toContain(actorIds["tok-c"]);
    expect(task).not.toContain(actorIds["tok-c"]);
    expect(queueSnapshot).toContain("cc-7f2-cc-7f2");
    expect(question).toContain("cc-7f2-cc-7f2");
    expect(task).toContain("cc-7f2-cc-7f2");
    await human.close();
  });

  it("reads durable questions and DB-rendered OKF without crossing projects", async () => {
    const seeded = await seedProjectResources();
    const human = await connect("tok-h");

    const question = JSON.parse(resourceText(await human.readResource({ uri: `question://${seeded.demoQuestion}` })));
    expect(question).toEqual(expect.objectContaining({
      id: seeded.demoQuestion,
      project_id: "demo",
      question: "Which retry policy?",
      answer: "Bounded exponential backoff",
      status: "answered",
    }));

    const root = resourceText(await human.readResource({ uri: "okf://demo/index.md" }));
    expect(root).toContain('okf_version: "0.1"');
    expect(root).toContain("tech");
    const directory = resourceText(await human.readResource({ uri: "okf://demo/tech/index.md" }));
    expect(directory).toContain("Request routing");
    const concept = resourceText(await human.readResource({ uri: "okf://demo/tech/routing.md" }));
    expect(concept).toContain('type: "Architecture"');
    expect(concept).toContain("Tokens select exactly one project.");

    await expect(human.readResource({ uri: `question://${seeded.betaQuestion}` })).rejects.toThrow();
    await expect(human.readResource({ uri: "question://0" })).rejects.toThrow();
    await expect(human.readResource({ uri: "question://not-a-number" })).rejects.toThrow();
    await expect(human.readResource({ uri: "okf://beta/tech/foreign.md" })).rejects.toThrow();
    await expect(human.readResource({ uri: "okf://demo/tech/Bad.md" })).rejects.toThrow();
    await human.close();
  });

  it("does not mutate durable state while listing and reading", async () => {
    await seedProjectResources();
    const before = await db.prepare(
      "SELECT (SELECT count(*) FROM tasks) AS tasks, (SELECT count(*) FROM questions) AS questions, (SELECT count(*) FROM memory_docs) AS memory",
    ).get<{ tasks: number; questions: number; memory: number }>();
    const coder = await connect("tok-c");
    await coder.listResources();
    await coder.readResource({ uri: "project://demo" });
    await coder.readResource({ uri: "queue://demo" });
    await coder.readResource({ uri: "okf://demo/index.md" });
    const after = await db.prepare(
      "SELECT (SELECT count(*) FROM tasks) AS tasks, (SELECT count(*) FROM questions) AS questions, (SELECT count(*) FROM memory_docs) AS memory",
    ).get<{ tasks: number; questions: number; memory: number }>();
    expect(after).toEqual(before);
    await coder.close();
  });
});
