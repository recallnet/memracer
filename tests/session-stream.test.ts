// tests/session-stream.test.ts
//
// Task #65: each mediator session is ONE ordered, typed, parent-linked event
// stream over the Vercel AI-SDK UI Message Stream shape. These tests drive the
// FakeDriver deterministically and assert the assembled stream, monotonic
// timestamps, tool-call/tool-result weaving, fork branching via parent_id,
// cross-project isolation, and the AI-SDK SSE vocabulary.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Db } from "../src/db.js";
import { openDb } from "../src/db.js";
import { betterAuthReady, seedMember } from "./helpers/auth.js";
import { createApp } from "../src/server.js";
import { Queue } from "../src/queue.js";
import { FakeDriver } from "../src/mediator/fake.js";
import type { MediatorWorker } from "../src/mediator/worker.js";
import { appendSessionEvents } from "../src/mediator/session.js";
import { buildTraceGraph, projectGenAiLifecycles, type TraceFrame } from "../src/dashboard/trace-model.js";

let httpServer: Server;
let baseUrl: string;
let worker: MediatorWorker;
let queue: Queue;
let db: Db;
const tokens: Record<string, string> = {};

beforeEach(async () => {
  db = openDb(":memory:");
  await betterAuthReady(db);
  const project = db.prepare("INSERT INTO projects (id, name, repo) VALUES (?, ?, ?)");
  await project.run("p1", "Project One", "acme/one");
  await project.run("p2", "Project Two", null);
  tokens["tok-a"] = (await seedMember(db, { name: "ada", projectId: "p1", role: "human" })).token;
  tokens["tok-b"] = (await seedMember(db, { name: "bob", projectId: "p2", role: "human" })).token;
  const made = createApp(db, {
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

interface EventRow {
  id: number;
  parent_id: number | null;
  session_id: number;
  task_id: number | null;
  seq: number;
  type: string;
  start_time: number;
  end_time: number | null;
}

function eventsForSession(sessionId: number): Promise<EventRow[]> {
  return db
    .prepare(
      "SELECT id, parent_id, session_id, task_id, seq, type, start_time, end_time FROM session_events WHERE session_id = ? ORDER BY seq ASC",
    )
    .all<EventRow>(sessionId);
}

function sseData(text: string): string[] {
  return text.split("\n\n").flatMap((block) => {
    const data = block.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6));
    return data.length ? [data.join("\n")] : [];
  });
}

function sseEvents(text: string): Array<{ id: number; data: string }> {
  return text.split("\n\n").flatMap((block) => {
    const lines = block.split("\n");
    const id = lines.find((line) => line.startsWith("id: "))?.slice(4);
    const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
    return id !== undefined && data !== undefined ? [{ id: Number(id), data }] : [];
  });
}

async function groom(project: string, taskId: number): Promise<void> {
  await worker.waitForJob(
    await worker.enqueue(project, "groom", { taskId, submittedBy: "ada" }),
    3000,
  );
}

describe("session event stream", () => {
  it("a groom-with-clarification is ONE ordered typed stream with strictly-increasing timestamps", async () => {
    // Cycle 1: an explicit product decision produces one recommended question.
    const taskId = await queue.submit("p1", "ada", {
      title: "Add search",
      body: "CLARIFY: Should search cover task titles only or titles plus bodies? Recommended: titles plus bodies — it matches full-text search expectations.",
      evidence: [],
    });
    const rootId = (await db
      .prepare("SELECT root_thread_id FROM tasks WHERE id=?")
      .get<{ root_thread_id: number }>(taskId))!.root_thread_id;
    await groom("p1", taskId);

    // The human answers and the submission is narrowed for the next groom.
    await db
      .prepare("UPDATE questions SET answer='titles plus bodies', status='answered' WHERE task_id=? AND asked_by='mediator'")
      .run(taskId);
    await db.prepare("UPDATE tasks SET body='FEATURE: add full-text search across task titles and bodies' WHERE id=?").run(taskId);
    // Cycle 2: re-groom now accepts.
    await groom("p1", taskId);

    const events = await eventsForSession(rootId);
    const types = events.map((e) => e.type);
    // One stream, both cycles, in order.
    expect(types).toEqual([
      "request",
      "reasoning",
      "tool_call",
      "clarification_q",
      "request",
      "clarification_a",
      "reasoning",
      "tool_call",
      "verdict",
    ]);
    // All events share the one session and carry the task.
    expect(new Set(events.map((e) => e.session_id))).toEqual(new Set([rootId]));
    expect(events.every((e) => e.task_id === taskId)).toBe(true);
    // seq is dense and monotonic; start_time strictly increases (no shared tick).
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    for (let i = 1; i < events.length; i++) {
      expect(events[i].start_time).toBeGreaterThan(events[i - 1].start_time);
    }
  });

  it("queue actions are woven in as tool_call + tool_result events", async () => {
    const victim = await queue.submit("p1", "ada", { title: "Obsolete", body: "old", evidence: [] });
    // A project discussion that closes a task → applied action.
    await worker.waitForJob(
      await worker.enqueue("p1", "discuss", { message: `close task ${victim}: superseded`, from: "ada" }),
      3000,
    );
    const disc = (await db
      .prepare("SELECT session_id FROM session_events WHERE type='tool_call' ORDER BY id DESC LIMIT 1")
      .get<{ session_id: number }>())!;
    const events = await eventsForSession(disc.session_id);
    const types = events.map((e) => e.type);
    expect(types).toContain("tool_call");
    expect(types).toContain("tool_result");
    // tool_result immediately follows its tool_call.
    const ci = types.indexOf("tool_call");
    expect(types[ci + 1]).toBe("tool_result");
  });

  it("a forked child task branches off the parent's last event via parent_id", async () => {
    const parent = await queue.submit("p1", "ada", { title: "Parent", body: "plain", evidence: [] });
    await groom("p1", parent);
    const parentLast = (await db
      .prepare("SELECT id, role FROM session_events WHERE task_id=? ORDER BY seq DESC LIMIT 1")
      .get<{ id: number; role: string }>(parent))!;

    const child = await queue.submit("p1", "ada", { title: "Child", body: "plain", evidence: [], parentId: parent });
    await groom("p1", child);
    const citation = { type: "task", id: parent, url: `${baseUrl}/dashboard?task=${parent}`, label: `task #${parent}` };
    await db.prepare("UPDATE decision_log SET citations=? WHERE task_id=?").run(JSON.stringify([citation]), child);

    const childFirst = (await db
      .prepare("SELECT id, parent_id, session_id, role FROM session_events WHERE task_id=? ORDER BY seq ASC LIMIT 1")
      .get<{ id: number; parent_id: number | null; session_id: number; role: string }>(child))!;
    // Same session (child inherits the parent's root), branched off the parent's last event.
    expect(childFirst.parent_id).toBe(parentLast.id);

    const replay = await fetch(`${baseUrl}/api/p/p1/sessions/${childFirst.session_id}/stream?token=${tokens["tok-a"]}`);
    const frames = sseData(await replay.text())
      .filter((value) => value && value !== "[DONE]")
      .map((value) => JSON.parse(value) as Record<string, unknown>);
    const cross = frames.find((frame) => frame.type === "data-cross-thread");
    expect(cross).toMatchObject({
      source: `task #${child} arrived from task #${parent}`,
      fromTaskId: parent,
      toTaskId: child,
    });
    expect(String(cross?.impact)).toMatch(/re-evaluated|began/);
    expect(String(cross?.impact).length).toBeGreaterThan(20);
    expect(frames.find((frame) => frame.type === "data-decision" && frame.taskId === child)).toMatchObject({ citations: [citation] });

    const crossIndex = frames.indexOf(cross!);
    const affectedIndex = frames.findIndex((frame) => frame.eventId === cross?.affectedEventId);
    expect(crossIndex).toBeGreaterThan(-1);
    expect(affectedIndex).toBe(crossIndex + 1);
    expect(frames[affectedIndex].role).toBe("mediator");
    expect(frames.map((frame) => frame.timelineOrder)).toEqual(frames.map((_, index) => index));
    const trace = buildTraceGraph(frames as unknown as TraceFrame[]);
    expect(trace.edges).toContainEqual({
      id: `event-${parentLast.id}-event-${childFirst.id}`,
      from: `event-${parentLast.id}`,
      to: `event-${childFirst.id}`,
      kind: "fork",
    });
    expect(trace.nodes.find((node) => node.eventId === parentLast.id)?.actor).toBe(parentLast.role);
    expect(trace.nodes.find((node) => node.eventId === childFirst.id)?.actor).toBe(childFirst.role);
  });

  it("returns exact fork siblings in one project-scoped request", async () => {
    const parent = await queue.submit("p1", "ada", { title: "Parent", body: "plain", evidence: [] });
    await groom("p1", parent);
    const firstChild = await queue.submit("p1", "ada", { title: "Child one", body: "plain", evidence: [], parentId: parent });
    const secondChild = await queue.submit("p1", "ada", { title: "Child two", body: "plain", evidence: [], parentId: parent });
    await groom("p1", firstChild);
    await groom("p1", secondChild);
    const branches = await db.prepare(
      `SELECT task_id, session_id, thread_id FROM session_events
        WHERE task_id IN (?, ?) ORDER BY task_id, seq`,
    ).all<{ task_id: number; session_id: number; thread_id: number }>(firstChild, secondChild);
    const selected = branches.find((event) => event.task_id === firstChild)!;
    const response = await fetch(
      `${baseUrl}/api/p/p1/sessions/${selected.session_id}/siblings?thread=${selected.thread_id}`,
      { headers: { Authorization: `Bearer ${tokens["tok-a"]}` } },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.originText).toBeTypeOf("string");
    expect(body.siblings).toEqual([expect.objectContaining({ taskId: secondChild, label: `task #${secondChild}` })]);
    const foreign = await fetch(
      `${baseUrl}/api/p/p2/sessions/${selected.session_id}/siblings?thread=${selected.thread_id}`,
      { headers: { Authorization: `Bearer ${tokens["tok-b"]}` } },
    );
    expect(foreign.status).toBe(404);
  });

  it("classifies a same-task mediator-to-coder transition across threads as a handoff", async () => {
    const taskId = await queue.submit("p1", "ada", { title: "Handoff", body: "plain", evidence: [] });
    await groom("p1", taskId);
    const parent = (await db.prepare(
      "SELECT id, session_id, thread_id FROM session_events WHERE task_id=? AND role='mediator' ORDER BY seq DESC LIMIT 1",
    ).get<{ id: number; session_id: number; thread_id: number }>(taskId))!;
    const thread = (await db.prepare(
      "INSERT INTO threads (project_id, kind, task_id, root_id, created_at) VALUES ('p1','review',?,?,?) RETURNING id",
    ).get<{ id: number }>(taskId, parent.session_id, Date.now()))!;
    const [coderId] = await appendSessionEvents(db, {
      projectId: "p1", sessionId: parent.session_id, threadId: thread.id,
      taskId, firstParentEventId: parent.id,
    }, [{ type: "request", role: "coder", author: "cc-handoff", content: "implement plan" }]);

    const response = await fetch(`${baseUrl}/api/p/p1/sessions/${parent.session_id}/stream?token=${tokens["tok-a"]}`);
    const traceFrames = sseData(await response.text())
      .filter((value) => value && value !== "[DONE]")
      .map((value) => JSON.parse(value) as TraceFrame);
    const trace = buildTraceGraph(traceFrames);
    const edge = trace.edges.find((candidate) => candidate.from === `event-${parent.id}` && candidate.to === `event-${coderId}`);
    expect(edge).toEqual({ id: `event-${parent.id}-event-${coderId}`, from: `event-${parent.id}`, to: `event-${coderId}`, kind: "handoff" });
    expect(trace.nodes.find((node) => node.eventId === parent.id)).toMatchObject({ actor: "mediator", taskId, threadId: parent.thread_id });
    expect(trace.nodes.find((node) => node.eventId === coderId)).toMatchObject({ actor: "coder", taskId, threadId: thread.id });
  });

  it("repositions a cross-thread marker before the affected mediator turn on replay", async () => {
    const parent = await queue.submit("p1", "ada", { title: "Parent", body: "plain", evidence: [] });
    await groom("p1", parent);
    const parentState = (await db.prepare(
      `SELECT t.root_thread_id AS session_id,
              (SELECT id FROM session_events WHERE task_id = t.id ORDER BY seq DESC LIMIT 1) AS last_event
         FROM tasks t WHERE t.id = ?`,
    ).get<{ session_id: number; last_event: number }>(parent))!;
    const child = await queue.submit("p1", "ada", { title: "Late branch", body: "arrives", evidence: [], parentId: parent });
    const childThread = (await db.prepare("SELECT root_thread_id FROM tasks WHERE id = ?").get<{ root_thread_id: number }>(child))!.root_thread_id;
    const [arrivalId] = await appendSessionEvents(db, {
      projectId: "p1", sessionId: parentState.session_id, threadId: childThread,
      taskId: child, firstParentEventId: parentState.last_event,
    }, [{ type: "request", role: "human", author: "ada", content: "late branch arrived" }]);

    const replay = async () => {
      const response = await fetch(`${baseUrl}/api/p/p1/sessions/${parentState.session_id}/stream?token=${tokens["tok-a"]}`);
      return sseData(await response.text())
        .filter((value) => value && value !== "[DONE]")
        .map((value) => JSON.parse(value) as Record<string, unknown>);
    };
    const early = await replay();
    expect(early.findIndex((frame) => frame.id === `cross-${arrivalId}`) + 1)
      .toBe(early.findIndex((frame) => frame.eventId === arrivalId));

    const [reasoningId] = await appendSessionEvents(db, {
      projectId: "p1", sessionId: parentState.session_id, threadId: childThread,
      taskId: child, firstParentEventId: arrivalId,
    }, [
      { type: "reasoning", role: "mediator", author: "mediator", content: "reconsider the branch" },
      { type: "verdict", role: "mediator", author: "mediator", content: JSON.stringify({ verdict: "revise", feedback: "priority changed" }) },
    ]);
    const late = await replay();
    const markerIndex = late.findIndex((frame) => frame.id === `cross-${arrivalId}`);
    expect(markerIndex).toBe(late.findIndex((frame) => frame.eventId === reasoningId) - 1);
    expect(markerIndex).toBeGreaterThan(late.findIndex((frame) => frame.eventId === arrivalId));
    expect(String(late[markerIndex].impact)).toContain("priority changed");
  });

  it("/threads/:id assembles the whole session; cross-project read is a 404", async () => {
    const taskId = await queue.submit("p1", "ada", { title: "T", body: "plain", evidence: [] });
    await groom("p1", taskId);
    const thread = (await db
      .prepare("SELECT id FROM threads WHERE task_id=? AND kind='groom'")
      .get<{ id: number }>(taskId))!;
    const res = await fetch(`${baseUrl}/api/p/p1/threads/${thread.id}`, {
      headers: { Authorization: `Bearer ${tokens["tok-a"]}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.session)).toBe(true);
    expect(body.session.map((e: EventRow) => e.type)).toContain("verdict");

    // tok-b (p2) cannot read a p1 thread.
    const cross = await fetch(`${baseUrl}/api/p/p2/threads/${thread.id}`, {
      headers: { Authorization: `Bearer ${tokens["tok-b"]}` },
    });
    expect(cross.status).toBe(404);
  });

  it("session stream endpoint emits AI-SDK UI Message Stream vocabulary in order; cross-project 404", async () => {
    const victim = await queue.submit("p1", "ada", { title: "Obsolete", body: "old", evidence: [] });
    await worker.waitForJob(
      await worker.enqueue("p1", "discuss", { message: `close task ${victim}: superseded`, from: "ada" }),
      3000,
    );
    const sessionId = (await db
      .prepare("SELECT session_id FROM session_events WHERE type='tool_call' ORDER BY id DESC LIMIT 1")
      .get<{ session_id: number }>())!.session_id;

    const res = await fetch(`${baseUrl}/api/p/p1/sessions/${sessionId}/stream?token=${tokens["tok-a"]}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    const frames = sseData(text)
      .filter((s) => s && s !== "[DONE]")
      .map((s) => JSON.parse(s) as Record<string, unknown> & { type: string });
    const kinds = frames.map((f) => f.type);
    expect(kinds[0]).toBe("start");
    expect(kinds).toContain("start-step");
    expect(kinds).toContain("tool-input-available");
    expect(kinds).toContain("tool-output-available");
    expect(kinds).toContain("text-delta");
    expect(kinds[kinds.length - 1]).toBe("finish");
    expect(kinds).toContain("finish-step");
    const eventFrames = frames.filter((frame) => "eventId" in frame);
    expect(eventFrames.length).toBeGreaterThan(0);
    for (const frame of eventFrames) {
      expect(frame).toEqual(expect.objectContaining({
        eventId: expect.any(Number),
        seq: expect.any(Number),
        threadId: expect.anything(),
        role: expect.any(String),
        author: expect.any(String),
        startTime: expect.any(Number),
        status: expect.any(String),
      }));
      expect(frame).toHaveProperty("parentId");
      expect(frame).toHaveProperty("taskId");
      expect(frame).toHaveProperty("endTime");
    }
    const projection = projectGenAiLifecycles(frames as unknown as TraceFrame[], sessionId);
    const tool = projection.lifecycles.find((lifecycle) => lifecycle.kind === "tool")!;
    expect(tool.spanName).toBe(`execute_tool ${tool.attributes["gen_ai.tool.name"]}`);
    expect(tool.events.map((event) => event.eventType)).toEqual(["tool_call", "tool_result"]);
    expect(tool.events[1].parentEventId).toBe(tool.events[0].eventId);
    const projectedEventIds = projection.lifecycles.flatMap((lifecycle) => lifecycle.events.map((event) => event.eventId));
    expect(projectedEventIds).toHaveLength(new Set(projectedEventIds).size);
    expect(projection.lifecycles.some((lifecycle) => lifecycle.attributes["gen_ai.agent.id"] !== undefined)).toBe(false);

    // Unknown / cross-project session id → 404.
    const bad = await fetch(`${baseUrl}/api/p/p1/sessions/999999/stream?token=${tokens["tok-a"]}`);
    expect(bad.status).toBe(404);
  });

  it("resumes replay after Last-Event-ID without duplicating delivered frames", async () => {
    const taskId = await queue.submit("p1", "ada", { title: "Resume", body: "plain", evidence: [] });
    await groom("p1", taskId);
    const sessionId = (await db.prepare("SELECT root_thread_id FROM tasks WHERE id = ?").get<{ root_thread_id: number }>(taskId))!.root_thread_id;
    const fullResponse = await fetch(`${baseUrl}/api/p/p1/sessions/${sessionId}/stream?token=${tokens["tok-a"]}`);
    const full = sseEvents(await fullResponse.text());
    const checkpoint = full[Math.floor(full.length / 2)].id;
    const resumedResponse = await fetch(`${baseUrl}/api/p/p1/sessions/${sessionId}/stream?token=${tokens["tok-a"]}`, {
      headers: { "Last-Event-ID": String(checkpoint) },
    });
    const resumed = sseEvents(await resumedResponse.text());
    expect(resumed).toEqual(full.filter((event) => event.id > checkpoint));
    expect(resumed.every((event) => JSON.parse(event.data).timelineOrder === event.id)).toBe(true);
  });

  it("flushes replay headers promptly for a 5k-event recording", async () => {
    const taskId = await queue.submit("p1", "ada", { title: "Large replay", body: "plain", evidence: [] });
    const sessionId = (await db.prepare("SELECT root_thread_id FROM tasks WHERE id = ?").get<{ root_thread_id: number }>(taskId))!.root_thread_id;
    await appendSessionEvents(
      db,
      { projectId: "p1", sessionId, threadId: sessionId, taskId },
      Array.from({ length: 5_000 }, (_, index) => ({
        type: index % 25 === 24 ? "verdict" as const : "reasoning" as const,
        role: "mediator" as const,
        author: "mediator",
        content: index % 25 === 24 ? '{"verdict":"approve"}' : `frame ${index}`,
      })),
    );
    const originalPrepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      const statement = originalPrepare(sql);
      if (!sql.includes("SELECT e.id, e.parent_id")) return statement;
      return {
        ...statement,
        all: async <T>(...params: Parameters<typeof statement.all>) => {
          await new Promise((resolve) => setTimeout(resolve, 300));
          return statement.all<T>(...params);
        },
      };
    }) as Db["prepare"];
    try {
      const started = performance.now();
      const response = await fetch(`${baseUrl}/api/p/p1/sessions/${sessionId}/stream?token=${tokens["tok-a"]}`);
      const ttfbMs = performance.now() - started;
      expect(response.status).toBe(200);
      expect(ttfbMs).toBeLessThan(250);
      const text = await response.text();
      expect(text).toContain(": keepalive\n\n");
      expect(sseEvents(text).length).toBe(5_003);
    } finally {
      db.prepare = originalPrepare;
    }
  }, 20_000);
});
