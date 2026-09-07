/**
 * Dense marketing project seed for `pnpm marketing:shots`.
 * Pattern mirrored from tests/browser/dashboard-react-home.browser.test.ts.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { openDb, type Db } from "../../src/db.js";
import { createApp } from "../../src/server.js";
import { FakeDriver } from "../../src/mediator/fake.js";
import { DEFAULT_LEASE_TTL_MS, type Queue } from "../../src/queue.js";
import {
  betterAuthReady,
  grantMembership,
  magicLinkSessionCookie,
  latestMagicLink,
} from "../../tests/helpers/auth.js";

export const MARKETING_EMAIL = "operator@marketing-shots.test";
export const PROJECT_ID = "raceway";

export type MarketingShotServer = {
  db: Db;
  queue: Queue;
  baseUrl: string;
  server: Server;
  stopWorker: () => void;
  activeTaskId: number;
  timelineRootThreadId: number;
  blockedTaskId: number;
  email: string;
  /** Full `better-auth.session_token=…` cookie for Playwright. */
  sessionCookie: string;
};

export async function bootMarketingShotApp(): Promise<MarketingShotServer> {
  const db = openDb(":memory:");
  await db.prepare("INSERT INTO projects (id, name, repo) VALUES (?, ?, ?)").run(
    PROJECT_ID,
    "Signal Raceway",
    "recallnet/memracer",
  );
  await betterAuthReady(db);
  const sessionCookie = await magicLinkSessionCookie(db, MARKETING_EMAIL, "Operator");
  const userId = (
    await db.prepare('SELECT id FROM "user" WHERE email = ?').get<{ id: string }>(MARKETING_EMAIL)
  )!.id;
  await grantMembership(db, userId, {
    projectId: PROJECT_ID,
    projectName: "Signal Raceway",
    role: "admin",
  });
  await db
    .prepare("INSERT INTO orgs (id, name, created_by, created_at) VALUES (?, ?, ?, ?)")
    .run("factory-org", "Factory Org", userId, Date.now());
  await db.prepare("UPDATE projects SET org_id = ? WHERE id = ?").run("factory-org", PROJECT_ID);

  const made = createApp(db, {
    driverFor: () => new FakeDriver(),
    workerOpts: { tickMs: 60_000 },
  });
  const queue = made.queue;

  const activeId = await queue.submit(PROJECT_ID, "Operator", {
    title: "Unwedge merge queue",
    body: "Outcome: Restore merge dispatch after stale checks block active work.",
    evidence: [],
  });

  // Detach auto root so hand-built timeline owns activity.
  const autoRootId = (
    (await db
      .prepare("SELECT root_thread_id FROM tasks WHERE id = ?")
      .get<{ root_thread_id: number }>(activeId)) as { root_thread_id: number }
  ).root_thread_id;
  await db.prepare("UPDATE threads SET task_id = NULL WHERE id = ?").run(autoRootId);

  const timelineStart = Date.now();
  await db
    .prepare("INSERT INTO threads (project_id, kind, task_id, created_at) VALUES (?, 'submission', ?, ?)")
    .run(PROJECT_ID, activeId, timelineStart);
  const threadId = (
    await db
      .prepare(
        "SELECT id FROM threads WHERE project_id = ? AND task_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get<{ id: number }>(PROJECT_ID, activeId)
  )!.id;
  await db.prepare("UPDATE tasks SET root_thread_id = ? WHERE id = ?").run(threadId, activeId);

  await db
    .prepare(
      "INSERT INTO session_events (project_id, session_id, thread_id, task_id, seq, type, role, author, content, start_time, end_time) VALUES (?, ?, ?, ?, 1, 'request', 'human', 'Operator', ?, ?, ?)",
    )
    .run(PROJECT_ID, threadId, threadId, activeId, "Please unwedge the queue", timelineStart, timelineStart + 1);
  const requestId = (
    await db
      .prepare("SELECT id FROM session_events WHERE session_id = ? AND seq = 1")
      .get<{ id: number }>(threadId)
  )!.id;
  await db
    .prepare(
      "INSERT INTO session_events (project_id, session_id, parent_id, thread_id, task_id, seq, type, role, author, content, start_time, end_time) VALUES (?, ?, ?, ?, ?, 2, 'reasoning', 'mediator', 'steward', ?, ?, ?)",
    )
    .run(
      PROJECT_ID,
      threadId,
      requestId,
      threadId,
      activeId,
      "The queue is blocked behind a stale speculative build.",
      timelineStart + 10,
      timelineStart + 11,
    );
  const reasoningId = (
    await db
      .prepare("SELECT id FROM session_events WHERE session_id = ? AND seq = 2")
      .get<{ id: number }>(threadId)
  )!.id;
  await db
    .prepare(
      "INSERT INTO session_events (project_id, session_id, parent_id, thread_id, task_id, seq, type, role, author, content, start_time, end_time) VALUES (?, ?, ?, ?, ?, 3, 'text', 'mediator', 'steward', ?, ?, ?)",
    )
    .run(
      PROJECT_ID,
      threadId,
      reasoningId,
      threadId,
      activeId,
      "Plan approved",
      timelineStart + 20,
      timelineStart + 21,
    );
  const approvalId = (
    await db
      .prepare("SELECT id FROM session_events WHERE session_id = ? AND seq = 3")
      .get<{ id: number }>(threadId)
  )!.id;

  await db
    .prepare(
      "INSERT INTO threads (project_id, kind, task_id, root_id, created_at) VALUES (?, 'review', ?, ?, ?)",
    )
    .run(PROJECT_ID, activeId, threadId, timelineStart + 25);
  const childThreadId = (
    await db
      .prepare(
        "SELECT id FROM threads WHERE project_id = ? AND task_id = ? AND root_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get<{ id: number }>(PROJECT_ID, activeId, threadId)
  )!.id;

  await db
    .prepare(
      "INSERT INTO session_events (project_id, session_id, parent_id, thread_id, task_id, seq, type, role, author, content, start_time, end_time) VALUES (?, ?, ?, ?, ?, 4, 'request', 'coder', 'codex', ?, ?, ?)",
    )
    .run(
      PROJECT_ID,
      threadId,
      approvalId,
      childThreadId,
      activeId,
      "Implement the approved recovery",
      timelineStart + 3_000,
      timelineStart + 3_001,
    );
  const coderId = (
    await db
      .prepare("SELECT id FROM session_events WHERE session_id = ? AND seq = 4")
      .get<{ id: number }>(threadId)
  )!.id;
  const recoveryId = (
    await db
      .prepare(
        "INSERT INTO session_events (project_id, session_id, parent_id, thread_id, task_id, seq, type, role, author, content, start_time, end_time) VALUES (?, ?, ?, ?, ?, 5, 'verdict', 'mediator', 'steward', ?, ?, ?) RETURNING id",
      )
      .get<{ id: number }>(
        PROJECT_ID,
        threadId,
        coderId,
        childThreadId,
        activeId,
        JSON.stringify({
          verdict: "approved",
          feedback: "**Recovery verified**\n\n- stale build stopped\n- queue resumed",
          rationale: "The recovery plan preserves queue ordering.",
        }),
        timelineStart + 3_010,
        timelineStart + 3_011,
      )
  )!.id;
  await db
    .prepare(
      "INSERT INTO session_events (project_id, session_id, parent_id, thread_id, task_id, seq, type, role, author, content, start_time, end_time) VALUES (?, ?, ?, ?, ?, 6, 'tool_call', 'coder', 'codex', ?, ?, NULL)",
    )
    .run(
      PROJECT_ID,
      threadId,
      recoveryId,
      childThreadId,
      activeId,
      JSON.stringify({ action: "verify_recovery" }),
      timelineStart + 5_000,
    );

  // Knowledge (3+)
  for (const [path, type, title, body] of [
    [
      "operations/merge-queue.md",
      "Learning",
      "Merge queue recovery",
      "Reset a stale queue entry after proving no merge-group dispatch.",
    ],
    [
      "conventions/prove-inactive.md",
      "Convention",
      "Prove inactive work",
      "A stale run must be proven inactive before replacement.",
    ],
    [
      "tech/runtime/worker-jobs.md",
      "Architecture",
      "Worker jobs",
      "Workers execute durable project jobs.",
    ],
  ] as const) {
    await db
      .prepare(
        "INSERT INTO memory_docs (project_id, path, type, title, description, tags, body, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(PROJECT_ID, path, type, title, title, JSON.stringify(["ops"]), body, Date.now());
  }

  // Multi-state fleet
  await queue.submit(PROJECT_ID, "Operator", { title: "Rebase claimed work", body: "", evidence: [] });
  const blockedId = await queue.submit(PROJECT_ID, "Operator", {
    title: "Repair failed CI",
    body: "",
    evidence: [],
  });
  await queue.claimNext(PROJECT_ID, "codex-home", DEFAULT_LEASE_TTL_MS);
  await queue.claimNext(PROJECT_ID, "claude-coder", DEFAULT_LEASE_TTL_MS);

  await db
    .prepare("UPDATE tasks SET plan = ?, lease_expires_at = ?, state = 'EXECUTING', lease_agent = ?, updated_at = ? WHERE id = ?")
    .run(
      "Preserve queue ordering while replacing the stale dispatch.",
      Date.now() + 120_000,
      "codex-home",
      Date.now(),
      activeId,
    );

  await db
    .prepare("UPDATE tasks SET state = 'BLOCKED', block_kind = 'human', updated_at = ? WHERE id = ?")
    .run(Date.now(), blockedId);
  await db
    .prepare(
      "INSERT INTO questions (project_id, task_id, asked_by, question, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(PROJECT_ID, blockedId, "mediator", "Should this retry wait for the failing check?", Date.now());

  await db
    .prepare(
      `INSERT INTO tasks (project_id, title, body, priority, state, submitted_by, result_pr_url, created_at, updated_at)
       VALUES (?, ?, '', 2, 'AWAITING_MERGE', ?, ?, ?, ?)`,
    )
    .run(
      PROJECT_ID,
      "Ship desktop push recovery",
      "Operator",
      "https://github.com/recallnet/memracer/pull/351",
      Date.now(),
      Date.now(),
    );

  await db
    .prepare(
      `INSERT INTO tasks (project_id, title, body, priority, state, submitted_by, created_at, updated_at)
       VALUES (?, ?, '', 2, 'DONE', ?, ?, ?)`,
    )
    .run(PROJECT_ID, "Archive completed rollout", "Operator", Date.now(), Date.now());

  await db
    .prepare(
      `INSERT INTO tasks (project_id, title, body, priority, state, hold_cause, submitted_by, created_at, updated_at)
       VALUES (?, ?, '', 2, 'HELD', 'explicit', ?, ?, ?)`,
    )
    .run(PROJECT_ID, "Deliberately parked rollout", "Operator", Date.now(), Date.now());

  await db
    .prepare(
      `INSERT INTO tasks (project_id, title, body, priority, state, incubate_until, submitted_by, created_at, updated_at)
       VALUES (?, ?, '', 2, 'INCUBATING', ?, ?, ?, ?)`,
    )
    .run(PROJECT_ID, "Warming consent gate", Date.now() + 3_600_000, "Operator", Date.now(), Date.now());

  await db
    .prepare(
      `INSERT INTO tasks (project_id, title, body, priority, state, submitted_by, created_at, updated_at)
       VALUES (?, ?, '', 1, 'QUEUED', ?, ?, ?)`,
    )
    .run(PROJECT_ID, "Normalize order pipeline", "Operator", Date.now(), Date.now());

  // Analytics spend fixtures
  const analyticsNow = Date.now();
  const groomJob = (
    await db
      .prepare(
        "INSERT INTO jobs (project_id, kind, payload, status, created_at, updated_at) VALUES (?, 'groom', '{}', 'done', ?, ?) RETURNING id",
      )
      .get<{ id: number }>(PROJECT_ID, analyticsNow, analyticsNow)
  )!;
  await db
    .prepare(
      "INSERT INTO mediator_usage (job_id, project_id, kind, resolved_model, cost_usd, completion_count, created_at) VALUES (?, ?, 'groom', ?, ?, ?, ?)",
    )
    .run(groomJob.id, PROJECT_ID, "glm-5.2", 6.43, 47, analyticsNow);
  const flashJob = (
    await db
      .prepare(
        "INSERT INTO jobs (project_id, kind, payload, status, created_at, updated_at) VALUES (?, 'groom', '{}', 'done', ?, ?) RETURNING id",
      )
      .get<{ id: number }>(PROJECT_ID, analyticsNow, analyticsNow)
  )!;
  await db
    .prepare(
      "INSERT INTO mediator_usage (job_id, project_id, kind, resolved_model, cost_usd, completion_count, created_at) VALUES (?, ?, 'groom', ?, ?, ?, ?)",
    )
    .run(flashJob.id, PROJECT_ID, "gemini-3.1-flash-lite", 0.004, 5, analyticsNow);

  let server!: Server;
  await new Promise<void>((resolve) => {
    server = made.app.listen(0, resolve);
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    db,
    queue,
    baseUrl,
    server,
    stopWorker: () => made.worker.stop(),
    activeTaskId: activeId,
    timelineRootThreadId: threadId,
    blockedTaskId: blockedId,
    email: MARKETING_EMAIL,
    sessionCookie,
  };
}

export function magicLinkFor(email: string): string {
  return latestMagicLink(email);
}

export async function shutdownMarketingShotApp(app: MarketingShotServer): Promise<void> {
  app.stopWorker();
  await new Promise<void>((resolve) => app.server.close(() => resolve()));
}
