// tests/server.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openDb } from "../src/db.js";
import { createApp } from "../src/server.js";
import { FakeDriver } from "../src/mediator/fake.js";
import type { MediatorWorker } from "../src/mediator/worker.js";
import { betterAuthReady, seedMember, grantMembership } from "./helpers/auth.js";
import { mergedGreenPrVerifier } from "./helpers/pr-verifier.js";
import { MAX_IMAGE_BYTES, type ImageBlobStore, type ImageMimeType } from "../src/image-attachments.js";
import { submitAndWait } from "./helpers/async-human.js";

let httpServer: Server;
let baseUrl: string;
let appBaseUrl: string;
let worker: MediatorWorker;
let db: ReturnType<typeof openDb>;
let imageBlobs: MemoryImageBlobStore;
// better-auth API keys, minted per test run (replace the old static tokens).
let tokH: string; // dana — demo human
let tokC: string; // cc-7f2 — demo coder
let tokMulti: string; // mara — demo + beta human
let tokMc: string; // bot-9 — demo + beta coder
let tokBeta: string; // bella — beta human

class MemoryImageBlobStore implements ImageBlobStore {
  readonly objects = new Map<string, { bytes: Uint8Array; mimeType: ImageMimeType }>();
  readonly reads: string[] = [];
  failReads = false;

  async put(key: string, bytes: Uint8Array, mimeType: ImageMimeType): Promise<void> {
    this.objects.set(key, { bytes: Uint8Array.from(bytes), mimeType });
  }

  async get(key: string): Promise<Uint8Array> {
    this.reads.push(key);
    if (this.failReads) throw new Error("injected R2 read failure");
    const object = this.objects.get(key);
    if (!object) throw new Error("missing object");
    return Uint8Array.from(object.bytes);
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

beforeEach(async () => {
  db = openDb(":memory:");
  imageBlobs = new MemoryImageBlobStore();
  await betterAuthReady(db);
  db.prepare(
    "INSERT INTO projects (id, name, repo) VALUES ('demo','Demo','recallnet/demo-app')",
  ).run();
  db.prepare(
    "INSERT INTO projects (id, name, repo) VALUES ('beta','Beta','recallnet/beta-app')",
  ).run();
  tokH = (await seedMember(db, { name: "dana", projectId: "demo", role: "human" })).token;
  tokC = (await seedMember(db, { name: "cc-7f2", projectId: "demo", role: "coder" })).token;
  tokBeta = (await seedMember(db, { name: "bella", projectId: "beta", role: "human" })).token;
  const multi = await seedMember(db, { name: "mara", projectId: "demo", role: "human" });
  await grantMembership(db, multi.userId, { projectId: "beta", role: "human" });
  tokMulti = multi.token;
  const mc = await seedMember(db, { name: "bot-9", projectId: "demo", role: "coder" });
  await grantMembership(db, mc.userId, { projectId: "beta", role: "coder" });
  tokMc = mc.token;
  const made = createApp(db, {
    driverFor: () => new FakeDriver(),
    workerOpts: { tickMs: 20, jobTimeoutMs: 2000 },
    publicUrl: "https://memracer.example/",
    imageBlobStore: imageBlobs,
    prVerifier: mergedGreenPrVerifier(),
  });
  worker = made.worker;
  await new Promise<void>((resolve) => {
    httpServer = made.app.listen(0, () => resolve());
  });
  appBaseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  baseUrl = `${appBaseUrl}/mcp`;
});

afterEach(() => {
  worker.stop();
  return new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: "test", version: "0.0.1" });
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

describe("MCP server", () => {
  it("rejects a bad token", async () => {
    await expect(connect("nope")).rejects.toThrow();
  });

  it("serves role-filtered tool lists plus list_projects", async () => {
    const human = await connect(tokH);
    const coder = await connect(tokC);
    const humanTools = (await human.listTools()).tools.map((t) => t.name).sort();
    const listedCoderTools = (await coder.listTools()).tools;
    const coderTools = listedCoderTools.map((t) => t.name).sort();
    expect(humanTools).toEqual([
      "human_answer", "human_attach_image", "human_conversation_reply", "human_discuss", "human_enhance", "human_extend_incubation", "human_followup",
      "human_job_status", "human_seal_incubation", "human_status", "human_submit", "human_task_status", "human_warm_task", "list_projects",
    ]);
    expect(coderTools).toEqual([
      "coder_answer", "coder_ask", "coder_block", "coder_check_work", "coder_claim_task", "coder_complete", "coder_heartbeat", "coder_park",
      "coder_progress", "coder_propose_plan", "coder_release", "coder_report_finding", "list_projects",
    ]);
    expect(listedCoderTools.find((tool) => tool.name === "coder_check_work")?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(listedCoderTools.find((tool) => tool.name === "coder_claim_task")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    await human.close();
    await coder.close();
  });

  it("list_projects returns only the API key's declared project", async () => {
    const multi = await connect(tokMulti);
    const listed = parse(await multi.callTool({ name: "list_projects", arguments: {} }));
    expect(listed.member).toBe("mara");
    expect(listed.projects).toEqual([
      { projectId: "demo", projectName: "Demo", repo: "recallnet/demo-app", role: "human", orgId: null, orgName: null },
    ]);
    await multi.close();
  });

  it("round-trips: submit → check → explicit claim → progress → complete → status shows DONE", async () => {
    const human = await connect(tokH);
    const coder = await connect(tokC);

    const submitted = await submitAndWait(human, {
          title: "Add rate limiting to /api/ingest",
          body: "429 + Retry-After on >100 req/min/key",
          priority: 0,
          evidence: [{ kind: "code", path: "middleware/ingest.ts", lines: "40-52", snippet: "app.use(rawIngest)" }],
        });
    expect(submitted.task.state).toBe("QUEUED");
    expect(submitted.task.project_id).toBe("demo"); // sole membership default
    expect(submitted.grooming.action).toBe("accept");

    expect(parse(await coder.callTool({ name: "coder_check_work", arguments: { timeout_s: 5 } }))).toEqual({
      available_count: 1,
      peek: [],
      open_negotiations: [],
    });
    const brief = parse(await coder.callTool({ name: "coder_claim_task", arguments: {} }));
    expect(brief.id).toBe(submitted.task.id);
    expect(brief.evidence).toHaveLength(1);

    parse(await coder.callTool({ name: "coder_progress", arguments: { task_id: brief.id, note: "working" } }));

    // strict completion: pr_url must be a URL, pr_description must carry substance,
    // verification claim is mandatory (non-empty after trim)
    const noUrl = await coder.callTool({
      name: "coder_complete",
      arguments: {
        task_id: brief.id, summary: "shipped", pr_description: "adds a rate limiter with tests",
        verification: "pnpm test — all green",
      },
    });
    expect(noUrl.isError).toBe(true);
    const badUrl = await coder.callTool({
      name: "coder_complete",
      arguments: {
        task_id: brief.id, summary: "shipped", pr_url: "not a url",
        pr_description: "adds a rate limiter with tests", verification: "pnpm test — all green",
      },
    });
    expect(badUrl.isError).toBe(true);
    const thinDescription = await coder.callTool({
      name: "coder_complete",
      arguments: {
        task_id: brief.id, summary: "shipped", pr_url: "https://github.com/x/y/pull/1",
        pr_description: "done", verification: "pnpm test — all green",
      },
    });
    expect(thinDescription.isError).toBe(true);
    const missingVerification = await coder.callTool({
      name: "coder_complete",
      arguments: {
        task_id: brief.id, summary: "shipped",
        pr_url: "https://github.com/recallnet/demo-app/pull/17",
        pr_description: "Adds token-bucket rate limiting to /api/ingest with tests.",
      },
    });
    expect(missingVerification.isError).toBe(true);
    const emptyVerification = await coder.callTool({
      name: "coder_complete",
      arguments: {
        task_id: brief.id, summary: "shipped",
        pr_url: "https://github.com/recallnet/demo-app/pull/17",
        pr_description: "Adds token-bucket rate limiting to /api/ingest with tests.",
        verification: "   ",
      },
    });
    expect(emptyVerification.isError).toBe(true);

    // Non-GitHub / wrong-repo PRs stay refused (parse + repo match gates).
    const nonGithub = await coder.callTool({
      name: "coder_complete",
      arguments: {
        task_id: brief.id,
        summary: "shipped",
        pr_url: "https://gitlab.example/acme/demo/-/merge_requests/17",
        pr_description: "Adds token-bucket rate limiting to /api/ingest with tests.",
        verification: "pnpm test — all green",
      },
    });
    expect(nonGithub.isError).toBe(true);
    const wrongRepo = await coder.callTool({
      name: "coder_complete",
      arguments: {
        task_id: brief.id,
        summary: "shipped",
        pr_url: "https://github.com/x/y/pull/17",
        pr_description: "Adds token-bucket rate limiting to /api/ingest with tests.",
        verification: "pnpm test — all green",
      },
    });
    expect(wrongRepo.isError).toBe(true);

    const done = parse(
      await coder.callTool({
        name: "coder_complete",
        arguments: {
          task_id: brief.id, summary: "shipped",
          pr_url: "https://github.com/recallnet/demo-app/pull/17",
          pr_description: "Adds token-bucket rate limiting to /api/ingest with tests.",
          verification: "pnpm test — server.test rate-limit cases green",
        },
      }),
    );
    expect(done.state).toBe("DONE");
    expect(done.result_pr_number).toBe(17);
    expect(done.result_summary).toContain("verification: pnpm test — server.test rate-limit cases green");

    const status = parse(await human.callTool({ name: "human_status", arguments: { project: "demo" } }));
    expect(status.projects.demo.tasks[0]).toMatchObject({ id: brief.id, state: "DONE" });
    expect(status).not.toHaveProperty("verifier_degraded");

    await human.close();
    await coder.close();
  });

  it("declares a bounded lease, renews it by heartbeat, and reconciles completion during grace", async () => {
    const coder = await connect(tokC);
    const now = Date.now();
    await db.prepare(
      `INSERT INTO tasks (project_id, title, body, state, submitted_by, created_at, updated_at)
       VALUES ('demo','long task','b','QUEUED','dana',?,?),('demo','next task','b','QUEUED','dana',?,?)`,
    ).run(now, now, now + 1, now + 1);

    const tooLong = await coder.callTool({
      name: "coder_claim_task",
      arguments: { project: "demo", lease_duration_ms: 120 * 60_000 + 1 },
    });
    expect(tooLong.isError).toBe(true);

    const claimed = parse(await coder.callTool({
      name: "coder_claim_task",
      arguments: { project: "demo", lease_duration_ms: 120_000 },
    }));
    expect(claimed).toMatchObject({ title: "long task", lease_ttl_ms: 120_000 });
    const approved = parse(await coder.callTool({
      name: "coder_propose_plan",
      arguments: { task_id: claimed.id, plan: "implement and verify", lease_duration_ms: 180_000 },
    }));
    expect(approved.verdict).toBe("approved");

    await db.prepare("UPDATE tasks SET lease_expires_at=? WHERE id=?").run(Date.now() - 1, claimed.id);
    const heartbeat = parse(await coder.callTool({ name: "coder_heartbeat", arguments: {} }));
    expect(heartbeat.live_leases).toEqual([
      expect.objectContaining({ task_id: claimed.id, lease_duration_ms: 180_000 }),
    ]);
    expect(heartbeat.live_leases[0].lease_expires_at).toBeGreaterThan(Date.now() + 175_000);
    expect(parse(await coder.callTool({ name: "coder_claim_task", arguments: { project: "demo" } }))).toBeNull();

    await db.prepare("UPDATE tasks SET lease_expires_at=? WHERE id=?").run(Date.now() - 1, claimed.id);
    const done = parse(await coder.callTool({
      name: "coder_complete",
      arguments: {
        task_id: claimed.id,
        summary: "reconciled",
        pr_url: "https://github.com/recallnet/demo-app/pull/11",
        pr_description: "Completes the long task after recovering its expired lease.",
        verification: "pnpm test — lease grace reconciliation green",
      },
    }));
    expect(done.state).toBe("DONE");
    expect((await db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE task_id=? AND outcome='lease_expired'").get(claimed.id))).toEqual({ n: 0 });
    await coder.close();
  });

  it("bounds human_status by default and supports section, page, and full-detail selection", async () => {
    const human = await connect(tokH);
    const largeText = "detail ".repeat(4_000);
    const inserted: number[] = [];
    for (let index = 0; index < 55; index += 1) {
      await db.prepare(
        `INSERT INTO tasks
         (project_id, title, body, priority, state, submitted_by, result_pr_description, plan, grooming_rationale, created_at, updated_at)
         VALUES ('demo', ?, ?, 2, 'QUEUED', 'dana', ?, ?, ?, ?, ?)`,
      ).run(`Large task ${index}`, largeText, largeText, largeText, largeText, index + 1, index + 1);
      const insertedTask = await db.prepare(
        "SELECT id FROM tasks WHERE project_id = 'demo' AND title = ?",
      ).get<{ id: number }>(`Large task ${index}`);
      inserted.push(insertedTask!.id);
    }

    const compactText = (await human.callTool({
      name: "human_status",
      arguments: { project: "demo", sections: ["projects"] },
    })).content?.[0];
    expect(compactText?.type).toBe("text");
    const compactSerialized = compactText?.type === "text" ? compactText.text : "";
    const compact = JSON.parse(compactSerialized);
    expect(compactSerialized.length).toBeLessThan(50_000);
    expect(compact).toEqual({
      pending_clarifications: [],
      pending_clarifications_page: {
        cursor: 0, limit: 5, returned: 0, total: 0, next_cursor: null,
      },
      open_negotiations: [],
      projects: {
        demo: {
          name: "Demo",
          tasks: expect.any(Array),
          task_page: {
            detail: "compact", offset: 0, limit: 50, returned: 50,
            total: 55, next_offset: 50,
          },
        },
      },
    });
    expect(compact.projects.demo.tasks[0]).not.toHaveProperty("body");
    expect(compact).not.toHaveProperty("open_questions");
    expect(compact).not.toHaveProperty("attention_alerts");

    const full = parse(await human.callTool({
      name: "human_status",
      arguments: {
        project: "demo", sections: ["projects"], task_detail: "full",
        task_limit: 1, task_offset: 54,
      },
    }));
    expect(full.projects.demo.task_page).toEqual({
      detail: "full", offset: 54, limit: 1, returned: 1, total: 55, next_offset: null,
    });
    expect(full.projects.demo.tasks[0]).toMatchObject({
      id: inserted[54], body: largeText, plan: largeText, result_pr_description: largeText,
    });

    await human.close();
  }, 60_000);

  it("pages every compact human-directed attention item with a truthful total", async () => {
    const human = await connect(tokH);
    await db.prepare("UPDATE projects SET attention_grace_ms = 0 WHERE id = 'demo'").run();
    const now = Date.now();

    for (let index = 0; index < 60; index += 1) {
      await db.prepare(
        `INSERT INTO tasks
         (project_id, title, body, priority, state, submitted_by, block_kind, created_at, updated_at)
         VALUES ('demo', ?, 'compact body', 2, 'BLOCKED', 'dana', 'human', ?, ?)`,
      ).run(`Blocked task ${index}`, now + index, now + index);
      const task = await db.prepare(
        "SELECT id FROM tasks WHERE project_id='demo' AND title=?",
      ).get<{ id: number }>(`Blocked task ${index}`);
      await db.prepare(
        `INSERT INTO questions (project_id, task_id, asked_by, question, created_at)
         VALUES ('demo', ?, ?, ?, ?)`,
      ).run(
        task!.id,
        index % 2 === 0 ? "coder-seat" : "mediator",
        `Decision ${index}?\nRecommended: option ${index}`,
        now + index,
      );
    }

    const projectQuestionIds: number[] = [];
    for (let index = 0; index < 60; index += 1) {
      await db.prepare(
        `INSERT INTO questions (project_id, task_id, asked_by, question, created_at)
         VALUES ('demo', NULL, 'mediator', ?, ?)`,
      ).run(`Project direction ${index}?\nRecommended: path ${index}`, now + 100 + index);
      const question = await db.prepare(
        "SELECT id FROM questions WHERE project_id='demo' AND task_id IS NULL AND question=?",
      ).get<{ id: number }>(`Project direction ${index}?\nRecommended: path ${index}`);
      projectQuestionIds.push(question!.id);
    }
    await db.prepare(
      `INSERT INTO questions (project_id, task_id, asked_by, question, created_at)
       VALUES ('beta', NULL, 'mediator', 'Foreign question?', ?)`,
    ).run(now);
    await db.prepare(
      `INSERT INTO tasks
       (project_id, title, body, priority, state, submitted_by, queued_at, created_at, updated_at)
       VALUES ('demo', 'Unattended queue item', 'compact body', 2, 'QUEUED', 'dana', ?, ?, ?)`,
    ).run(now - 1, now - 1, now - 1);

    const readPage = async (cursor: number) => {
      const result = await human.callTool({
        name: "human_status",
        arguments: { project: "demo", sections: ["attention_alerts"], attention_cursor: cursor },
      });
      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text.length).toBeLessThan(50_000);
      return JSON.parse(text);
    };
    const first = await readPage(0);
    const second = await readPage(first.attention_page.next_cursor);
    const third = await readPage(second.attention_page.next_cursor);

    // 60 blocked + 60 project questions — queue_alert aging is excluded from Needs-You.
    expect(first.attention_page).toEqual({ cursor: 0, limit: 50, returned: 50, total: 120, next_cursor: 50 });
    expect(second.attention_page).toEqual({ cursor: 50, limit: 50, returned: 50, total: 120, next_cursor: 100 });
    expect(third.attention_page).toEqual({ cursor: 100, limit: 50, returned: 20, total: 120, next_cursor: null });
    const items = [...first.attention_alerts, ...second.attention_alerts, ...third.attention_alerts];
    expect(new Set(items.map((item: { episode_id: string }) => item.episode_id)).size).toBe(120);
    expect(items[0]).toMatchObject({
      task_id: expect.any(Number),
      title: "Blocked task 0",
      reason: "Decision 0? Recommended: option 0",
      recovery: expect.stringContaining("human_answer"),
      question_id: expect.any(Number),
    });
    // Project questions still appear; aging QUEUED items do not.
    expect(items.some((item: { task_id: number | null; title: string }) =>
      item.task_id === null && item.title === "Project question · Demo",
    )).toBe(true);
    expect(items.every((item: { kind: string }) => item.kind !== "queue_alert")).toBe(true);
    expect(items.every((item: Record<string, unknown>) => !("question" in item) && !("task_title" in item) && !("queued_age" in item))).toBe(true);
    expect(items.every((item: unknown) => JSON.stringify(item).length < 1_000)).toBe(true);

    await db.prepare(
      "UPDATE questions SET status='answered', answer='Use the recommended path', answered_at=? WHERE id=?",
    ).run(Date.now(), projectQuestionIds.at(-1));
    const afterAnswer = await readPage(100);
    expect(afterAnswer.attention_page.total).toBe(119);
    expect(afterAnswer.attention_alerts.some((item: { episode_id: string }) => item.episode_id === `question:${projectQuestionIds.at(-1)}`)).toBe(false);

    await human.close();
  });

  it("stores task images out of band, keeps ordinary payload sizes stable, and delivers ImageContent", async () => {
    const human = await connect(tokH);
    const coder = await connect(tokC);
    const png = Buffer.from("iVBORw0KGgo=", "base64");
    const imageBase64 = png.toString("base64");

    const submitted = parse(await human.callTool({
      name: "human_submit",
      arguments: { title: "Match this screenshot", body: "Implement the visible state", evidence: [] },
    }));
    const taskId = submitted.task.id as number;

    const readText = async (path: string) => {
      const response = await fetch(`${appBaseUrl}${path}`, {
        headers: { Authorization: `Bearer ${tokH}` },
      });
      expect(response.status).toBe(200);
      return response.text();
    };
    const before = {
      resource: (await human.readResource({ uri: `task://${taskId}` })).contents[0]!.text,
      queue: await readText("/api/p/demo/queue"),
      detail: await readText(`/api/p/demo/tasks/${taskId}`),
      status: JSON.stringify(parse(await human.callTool({ name: "human_status", arguments: {} }))),
    };

    const attachResult = await human.callTool({
      name: "human_attach_image",
      arguments: {
        task_id: taskId,
        image_base64: imageBase64,
        mimeType: "image/png",
        caption: "Empty state reference",
      },
    });
    const attached = parse(attachResult);
    expect(attached).toEqual({
      attached: true,
      task_id: taskId,
      image: { id: expect.any(Number), mimeType: "image/png", caption: "Empty state reference" },
      pending_clarifications: [],
      pending_clarifications_page: {
        cursor: 0, limit: 5, returned: 0, total: 0, next_cursor: null,
      },
    });
    expect(JSON.stringify(attachResult)).not.toContain(imageBase64);
    expect(JSON.stringify(attachResult)).not.toContain("images/demo");

    const evidence = await db.prepare(
      "SELECT kind, path, lines, snippet, note, blob_ref, mime_type, caption FROM evidence WHERE id = ?",
    ).get<Record<string, unknown>>(attached.image.id);
    expect(evidence).toEqual({
      kind: "image",
      path: null,
      lines: null,
      snippet: null,
      note: null,
      blob_ref: expect.stringMatching(/^images\/demo\//),
      mime_type: "image/png",
      caption: "Empty state reference",
    });
    expect(imageBlobs.objects.size).toBe(1);

    const after = {
      resource: (await human.readResource({ uri: `task://${taskId}` })).contents[0]!.text,
      queue: await readText("/api/p/demo/queue"),
      detail: await readText(`/api/p/demo/tasks/${taskId}`),
      status: JSON.stringify(parse(await human.callTool({ name: "human_status", arguments: {} }))),
    };
    expect(after.resource).toBe(before.resource);
    expect(after.detail).toBe(before.detail);
    expect(after.status).toBe(before.status);
    expect(after.queue.length).toBe(before.queue.length);
    for (const value of Object.values(after)) {
      expect(value).not.toContain(imageBase64);
      expect(value).not.toContain("blob_ref");
    }

    const metadataResponse = await fetch(`${appBaseUrl}/api/p/demo/tasks/${taskId}/images`, {
      headers: { Authorization: `Bearer ${tokH}` },
    });
    expect(await metadataResponse.json()).toEqual({
      images: [{ id: attached.image.id, mime_type: "image/png", caption: "Empty state reference" }],
    });
    const rawResponse = await fetch(`${appBaseUrl}/p/demo/images/${attached.image.id}`, {
      headers: { Authorization: `Bearer ${tokH}` },
    });
    expect(rawResponse.status).toBe(200);
    expect(rawResponse.headers.get("content-type")).toBe("image/png");
    expect(rawResponse.headers.get("cache-control")).toBe("private, no-store");
    expect(rawResponse.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await rawResponse.arrayBuffer())).toEqual(png);
    expect((await fetch(`${appBaseUrl}/p/demo/images/${attached.image.id}`)).status).toBe(401);
    expect((await fetch(`${appBaseUrl}/p/demo/images/${attached.image.id}`, {
      headers: { Authorization: `Bearer ${tokBeta}` },
    })).status).toBe(404);

    const claim = await coder.callTool({ name: "coder_claim_task", arguments: {} });
    const content = claim.content as Array<Record<string, unknown>>;
    expect(JSON.parse(content[0]!.text as string)).toMatchObject({ id: taskId, evidence: [] });
    expect(content[1]).toEqual({ type: "image", data: imageBase64, mimeType: "image/png" });

    await human.close();
    await coder.close();
  });

  it("keeps an atomic image task claim when R2 delivery fails and returns an authenticated URL", async () => {
    const human = await connect(tokH);
    const coder = await connect(tokC);
    const submitted = parse(await human.callTool({
      name: "human_submit",
      arguments: { title: "Fallback screenshot", body: "Use the attached reference", evidence: [] },
    }));
    const taskId = submitted.task.id as number;
    await human.callTool({
      name: "human_attach_image",
      arguments: {
        task_id: taskId,
        image_base64: "iVBORw0KGgo=",
        mimeType: "image/png",
      },
    });
    imageBlobs.failReads = true;

    const claimed = await coder.callTool({ name: "coder_claim_task", arguments: {} });
    expect(claimed.isError).not.toBe(true);
    const content = claimed.content as Array<{ type: string; text?: string }>;
    expect(JSON.parse(content[0]!.text!)).toMatchObject({ id: taskId, state: "CLAIMED" });
    expect(JSON.parse(content[1]!.text!)).toMatchObject({
      image_fallbacks: [{
        id: expect.any(Number),
        mimeType: "image/png",
        url: expect.stringMatching(/^https:\/\/memracer\.example\/p\/demo\/images\//),
        reason: "unavailable",
      }],
    });
    expect(await db.prepare("SELECT state FROM tasks WHERE id = ?").get(taskId)).toEqual({ state: "CLAIMED" });

    await human.close();
    await coder.close();
  });

  it("accepts an exact 10 MiB MCP image envelope and rejects malformed or oversized uploads", async () => {
    const human = await connect(tokH);
    const beta = await connect(tokBeta);
    const coder = await connect(tokC);
    const submitted = parse(await human.callTool({
      name: "human_submit",
      arguments: { title: "Large screenshot", body: "Preserve fine visual detail", evidence: [] },
    }));
    const bytes = Buffer.alloc(MAX_IMAGE_BYTES);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
    const exact = await human.callTool({
      name: "human_attach_image",
      arguments: {
        task_id: submitted.task.id,
        image_base64: bytes.toString("base64"),
        mimeType: "image/png",
      },
    });
    expect(exact.isError, JSON.stringify(exact.content)).not.toBe(true);
    expect(imageBlobs.objects.size).toBe(1);

    const oversized = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    bytes.subarray(0, 8).copy(oversized);
    expect((await human.callTool({
      name: "human_attach_image",
      arguments: {
        task_id: submitted.task.id,
        image_base64: oversized.toString("base64"),
        mimeType: "image/png",
      },
    })).isError).toBe(true);
    expect((await human.callTool({
      name: "human_attach_image",
      arguments: {
        task_id: submitted.task.id,
        image_base64: "iVBORw0KGgo",
        mimeType: "image/png",
      },
    })).isError).toBe(true);
    expect((await human.callTool({
      name: "human_attach_image",
      arguments: {
        task_id: submitted.task.id,
        image_base64: "iVBORw0KGgo=",
        mimeType: "image/jpeg",
      },
    })).isError).toBe(true);
    expect(imageBlobs.objects.size).toBe(1);

    const foreign = parse(await beta.callTool({
      name: "human_submit",
      arguments: { title: "Private beta screenshot", body: "Do not expose across projects", evidence: [] },
    }));
    expect((await human.callTool({
      name: "human_attach_image",
      arguments: {
        task_id: foreign.task.id,
        image_base64: "iVBORw0KGgo=",
        mimeType: "image/png",
      },
    })).isError).toBe(true);

    const second = parse(await human.callTool({
      name: "human_attach_image",
      arguments: {
        task_id: submitted.task.id,
        image_base64: "iVBORw0KGgo=",
        mimeType: "image/png",
        caption: "second image",
      },
    }));
    const claimed = await coder.callTool({ name: "coder_claim_task", arguments: {} });
    const claimContent = claimed.content as Array<{ type: string; data?: string; text?: string; mimeType?: string }>;
    expect(claimContent[1]).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(Buffer.from(claimContent[1]!.data!, "base64").byteLength).toBe(MAX_IMAGE_BYTES);
    expect(JSON.parse(claimContent[2]!.text!)).toMatchObject({
      image_fallbacks: [{ id: second.image.id, reason: "inline_budget" }],
    });
    expect(imageBlobs.reads).toHaveLength(1);

    await human.close();
    await beta.close();
    await coder.close();
  });

  it("concurrent explicit claims return one unique winner", async () => {
    const human = await connect(tokH);
    const first = await connect(tokC);
    const second = await connect(tokMc);
    const submitted = parse(await human.callTool({
      name: "human_submit",
      arguments: { title: "One owner", body: "Claim exactly once", evidence: [] },
    }));

    const [one, two] = await Promise.all([
      first.callTool({ name: "coder_claim_task", arguments: {} }),
      second.callTool({ name: "coder_claim_task", arguments: {} }),
    ]);
    const results = [parse(one), parse(two)];
    expect(results.filter((brief) => brief?.id === submitted.task.id)).toHaveLength(1);
    expect(results.filter((brief) => brief === null)).toHaveLength(1);
    expect(await db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE id=? AND state='CLAIMED'").get(submitted.task.id))
      .toEqual({ count: 1 });

    await human.close();
    await first.close();
    await second.close();
  });

  it("human_status omits aging-queue alerts and still surfaces human-owned blocks", async () => {
    const human = await connect(tokH);
    const coder = await connect(tokC);
    // Operationally configurable per project; zero makes this transport test
    // deterministic while service tests pin the conservative defaults/edges.
    await db.prepare("UPDATE projects SET attention_grace_ms = 0 WHERE id = 'demo'").run();
    const submitted = parse(await human.callTool({
      name: "human_submit",
      arguments: { title: "Unattended import", body: "Restore imports", evidence: [] },
    }));
    const dbTaskId = submitted.task.id;

    // Aging QUEUED work is not a Needs-You / attention_alerts item.
    const unattended = parse(await human.callTool({ name: "human_status", arguments: {} }));
    expect(unattended.attention_alerts).toEqual([]);
    expect(unattended.attention_page).toEqual({
      cursor: 0, limit: 50, returned: 0, total: 0, next_cursor: null,
    });
    expect(Object.keys(unattended.projects)).toEqual(["demo"]);

    const claimed = parse(await coder.callTool({ name: "coder_claim_task", arguments: {} }));
    expect(claimed.id).toBe(dbTaskId);
    const active = parse(await human.callTool({ name: "human_status", arguments: {} }));
    expect(active.attention_alerts).toEqual([]);
    expect(active.projects.demo.tasks[0].lease_agent).toBe("cc-7f2-cc-7f2");

    await coder.callTool({
      name: "coder_block",
      arguments: { task_id: dbTaskId, reason: "Need an operator decision" },
    });
    const waiting = parse(await human.callTool({ name: "human_status", arguments: {} }));
    expect(waiting.open_questions).toContainEqual(expect.objectContaining({
      task_id: dbTaskId,
      asked_by: "cc-7f2-cc-7f2",
    }));
    // Human-owned block becomes real Needs-You attention.
    expect(waiting.attention_alerts.some((item: { kind: string; task_id: number }) =>
      item.task_id === dbTaskId && (item.kind === "blocked" || item.kind === "question"),
    )).toBe(true);

    await human.close();
    await coder.close();
  });

  it("project-scoped human key cannot act on or observe another membership", async () => {
    const multi = await connect(tokMulti);

    const denied = await multi.callTool({
      name: "human_submit",
      arguments: { project: "beta", title: "cross-tenant", body: "b", evidence: [] },
    });
    expect(denied.isError).toBe(true);

    const explicit = parse(
      await multi.callTool({
        name: "human_submit",
        arguments: { project: "demo", title: "demo task", body: "b", evidence: [] },
      }),
    );
    expect(explicit.task.project_id).toBe("demo");

    const status = parse(await multi.callTool({ name: "human_status", arguments: {} }));
    expect(Object.keys(status.projects)).toEqual(["demo"]);
    expect(status.projects.demo.tasks).toHaveLength(1);

    await multi.close();
  });

  it("project-scoped coder claim cannot take work from another membership", async () => {
    const beta = await connect(tokBeta);
    const demo = await connect(tokMulti);
    const mcoder = await connect(tokMc);

    await beta.callTool({
      name: "human_submit",
      arguments: { title: "beta work", body: "b", evidence: [], priority: 0 },
    });
    await demo.callTool({
      name: "human_submit",
      arguments: { title: "demo work", body: "b", evidence: [], priority: 1 },
    });
    const denied = await mcoder.callTool({
      name: "coder_claim_task",
      arguments: { project: "beta" },
    });
    expect(denied.isError).toBe(true);
    const brief = parse(
      await mcoder.callTool({ name: "coder_claim_task", arguments: {} }),
    );
    expect(brief.project_id).toBe("demo");
    expect(brief.title).toBe("demo work");
    expect(brief.lease_agent).toBe("bot-9-bot-9");

    await beta.close();
    await demo.close();
    await mcoder.close();
  });

  it("a parked read-only check wakes when a submission lands, then claim is explicit", async () => {
    const human = await connect(tokH);
    const coder = await connect(tokC);

    const parked = coder.callTool({ name: "coder_check_work", arguments: { timeout_s: 30, peek_limit: 1 } });
    await new Promise((r) => setTimeout(r, 100));
    await human.callTool({
      name: "human_submit",
      arguments: { title: "wake up", body: "b", evidence: [] },
    });
    const available = parse(await parked);
    expect(available).toEqual({
      available_count: 1,
      peek: [{ project_id: "demo", title: "wake up", priority: 2 }],
      open_negotiations: [],
    });
    const brief = parse(await coder.callTool({ name: "coder_claim_task", arguments: {} }));
    expect(brief.title).toBe("wake up");

    await human.close();
    await coder.close();
  });
});
