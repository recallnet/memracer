import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createDashboardApi } from "../src/dashboard/web/data/api.js";
import type { CompletedTasksDto, DecisionsDto, QueueDto, TaskDetailDto } from "../src/dashboard/web/data/dto.js";
import { openDb, type Db } from "../src/db.js";
import { createApp } from "../src/server.js";
import { FakeDriver } from "../src/mediator/fake.js";
import type { MediatorWorker } from "../src/mediator/worker.js";
import { betterAuthReady, seedMember } from "./helpers/auth.js";

let db: Db;
let server: Server;
let worker: MediatorWorker;
let baseUrl: string;
let token: string;
let taskId: number;

beforeEach(async () => {
  db = openDb(":memory:");
  await betterAuthReady(db);
  await db.prepare("INSERT INTO projects (id, name, repo) VALUES (?, ?, ?)").run("p1", "Project One", "acme/one");
  token = (await seedMember(db, { name: "ada", projectId: "p1", projectName: "Project One", role: "human" })).token;
  const made = createApp(db, { driverFor: () => new FakeDriver() });
  worker = made.worker;
  taskId = await made.queue.submit("p1", "ada", {
    title: "Typed dashboard task",
    body: "exercise real response contracts",
    evidence: [{ kind: "log", snippet: "representative evidence" }],
  });
  const now = Date.now();
  await db.prepare("UPDATE tasks SET grooming_rationale = ? WHERE id = ?").run("accepted fixture", taskId);
  await db.prepare(
    `INSERT INTO decision_log (project_id, task_id, kind, summary, rationale, created_at, citations)
     VALUES (?, ?, 'create', ?, ?, ?, '[]')`,
  ).run("p1", taskId, "created typed fixture", "accepted fixture", now);
  await new Promise<void>((resolve, reject) => {
    server = made.app.listen(0, "127.0.0.1", (error?: Error) => error ? reject(error) : resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  worker.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function authenticatedApi() {
  return createDashboardApi(async <T>(path: string): Promise<T> => {
    const response = await fetch(`${baseUrl}/api${path}`, { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status, path).toBe(200);
    return response.json() as Promise<T>;
  });
}

describe("typed dashboard client against createApp", () => {
  it("consumes the actual authenticated queue and task-detail shapes without conflating projections", async () => {
    const api = authenticatedApi();
    const queue: QueueDto = await api.queue("p1");
    const detail: TaskDetailDto = await api.task("p1", taskId);

    expect(queue.tasks[0]).toMatchObject({ id: taskId, evidence_count: 1, latest_attempt_note: null });
    expect(Object.hasOwn(queue.tasks[0], "evidence_count")).toBe(true);
    expect(detail).toMatchObject({ id: taskId, project_id: "p1", waiting_on: [], evidence: [expect.objectContaining({ kind: "log" })] });
    expect(Object.hasOwn(detail, "evidence_count")).toBe(false);
    expect(Object.hasOwn(detail, "latest_attempt_note")).toBe(false);
  });

  it("keeps project decisions distinct from task-scoped decisions", async () => {
    const api = authenticatedApi();
    const projectFeed: DecisionsDto = await api.decisions("p1");
    const detail: TaskDetailDto = await api.task("p1", taskId);

    expect(projectFeed.decisions[0]).toMatchObject({ task_id: taskId, kind: "create", citations: [] });
    expect(Object.hasOwn(projectFeed.decisions[0], "task_id")).toBe(true);
    expect(detail.decisions[0]).toMatchObject({ kind: "create", citations: [] });
    expect(Object.hasOwn(detail.decisions[0], "task_id")).toBe(false);
  });

  it("consumes the completed-task archive contract", async () => {
    await db.prepare("UPDATE tasks SET state = 'DONE', updated_at = ? WHERE id = ?").run(Date.now(), taskId);
    const archive: CompletedTasksDto = await authenticatedApi().completedTasks("p1", { q: `#${taskId}`, limit: 10, offset: 0 });

    expect(archive).toMatchObject({ offset: 0, limit: 10, next_offset: null });
    expect(archive.tasks).toEqual([expect.objectContaining({ id: taskId, state: "DONE" })]);
  });
});
