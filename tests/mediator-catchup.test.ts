// tests/mediator-catchup.test.ts
// "Catch me up": a windowed activity digest as a conversational move. The server
// owns the clock and resolves the window; gather is deterministic, so these
// assertions target the server-composed digest, not model prose.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Db } from "../src/db.js";
import { openDb } from "../src/db.js";
import { betterAuthReady, seedMember } from "./helpers/auth.js";
import { createApp } from "../src/server.js";
import { FakeDriver } from "../src/mediator/fake.js";
import type { MediatorWorker } from "../src/mediator/worker.js";
import { parseWindowSpec, resolveWindow } from "../src/mediator/pipelines.js";
import { discussAndWait } from "./helpers/async-human.js";

// --- pure resolver unit tests (no server) ---
describe("catchup window resolver", () => {
  // A fixed Wednesday: 2026-07-15T09:00:00 local.
  const now = new Date(2026, 6, 15, 9, 0, 0).getTime();

  it("parses phrasing into a spec, defaulting bare catch-up to since_last_catchup", () => {
    expect(parseWindowSpec("catch me up since yesterday")).toBe("yesterday");
    expect(parseWindowSpec("what changed today?")).toBe("today");
    expect(parseWindowSpec("catch me up on this week")).toBe("this_week");
    expect(parseWindowSpec("what happened in the last 7 days")).toBe("last_7_days");
    expect(parseWindowSpec("catch me up")).toBe("since_last_catchup");
  });

  it("resolves today as [start-of-today, now)", () => {
    const w = resolveWindow("today", now, 0);
    expect(new Date(w.start).getHours()).toBe(0);
    expect(new Date(w.start).getDate()).toBe(15);
    expect(w.end).toBe(now);
    expect(w.label).toBe("today");
  });

  it("resolves yesterday as the full prior day [start, start-of-today)", () => {
    const w = resolveWindow("yesterday", now, 0);
    expect(new Date(w.start).getDate()).toBe(14);
    expect(new Date(w.start).getHours()).toBe(0);
    expect(new Date(w.end).getDate()).toBe(15);
    expect(new Date(w.end).getHours()).toBe(0);
  });

  it("resolves this_week to the ISO-week Monday 00:00", () => {
    const w = resolveWindow("this_week", now, 0);
    // 2026-07-15 is a Wednesday; the ISO week starts Monday the 13th.
    expect(new Date(w.start).getDay()).toBe(1);
    expect(new Date(w.start).getDate()).toBe(13);
    expect(w.end).toBe(now);
  });

  it("resolves since_last_catchup from the stored watermark", () => {
    const wm = now - 3600_000;
    const w = resolveWindow("since_last_catchup", now, wm);
    expect(w.start).toBe(wm);
    expect(w.end).toBe(now);
  });
});

// --- end-to-end over MCP ---
let httpServer: Server;
let baseUrl: string;
let worker: MediatorWorker;
let db: Db;
const tokens: Record<string, string> = {};

const DAY = 86_400_000;

beforeEach(async () => {
  db = openDb(":memory:");
  await betterAuthReady(db);
  await db.prepare("INSERT INTO projects (id, name) VALUES ('demo','Demo')").run();
  tokens["tok-h"] = (await seedMember(db, { name: "dana", projectId: "demo", role: "human" })).token;
  const made = createApp(db, { driverFor: () => new FakeDriver(), workerOpts: { tickMs: 20, jobTimeoutMs: 2000 } });
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

// Seed a completed task whose updated_at lands at `at`, returning its id.
async function seedDone(title: string, at: number): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO tasks (project_id, title, body, state, submitted_by, result_summary, result_pr_url, created_at, updated_at)
       VALUES ('demo', ?, 'b', 'DONE', 'dana', ?, 'https://x/pr/1', ?, ?) RETURNING id`,
    )
    .get<{ id: number }>(title, `did ${title}`, at, at);
  return row!.id;
}

async function seedDecision(taskId: number, at: number): Promise<void> {
  await db
    .prepare(
      "INSERT INTO decision_log (project_id, task_id, kind, summary, rationale, created_at) VALUES ('demo', ?, 'close', ?, 'r', ?)",
    )
    .run(taskId, `closed ${taskId}`, at);
}

describe("catch me up over MCP", () => {
  it("scopes the digest to the resolved window and echoes the boundary", async () => {
    const now = Date.now();
    const startOfToday = new Date(now).setHours(0, 0, 0, 0);
    const yesterdayNoon = startOfToday - DAY / 2;
    const id = await seedDone("rate-limit ingest", yesterdayNoon);
    await seedDecision(id, yesterdayNoon);
    // A change from three days ago must NOT appear in the yesterday window.
    await seedDone("old thing", now - 3 * DAY);

    const dana = await connect("tok-h");
    const res = await discussAndWait(dana, { message: "catch me up since yesterday" });
    await dana.close();

    expect(res.window.label).toBe("yesterday");
    expect(res.reply).toContain("Catch-up: yesterday");
    expect(res.reply).toContain(new Date(res.window.start).toISOString());
    expect(res.reply).toContain(`#${id}`);
    expect(res.reply).toContain("rate-limit ingest");
    expect(res.reply).not.toContain("old thing");
    expect(res.empty).toBe(false);
  });

  it("empty window says so", async () => {
    const dana = await connect("tok-h");
    const res = await discussAndWait(dana, { since: "today" });
    await dana.close();
    expect(res.empty).toBe(true);
    expect(res.reply).toMatch(/no activity/i);
    expect(res.reply).toContain("today");
  });

  it("since_last_catchup advances the watermark: the second call returns only newer changes", async () => {
    await seedDone("shipped feature", Date.now() - 3600_000);
    const dana = await connect("tok-h");

    const first = await discussAndWait(dana, { since: "since_last_catchup" });
    expect(first.empty).toBe(false);
    expect(first.reply).toContain("shipped feature");

    const second = await discussAndWait(dana, { since: "since_last_catchup" });
    await dana.close();
    expect(second.empty).toBe(true);
    expect(second.reply).toMatch(/no activity/i);
  });
});
