// tests/github-ci-fix.test.ts
// CI-fix child tasks from check_suite.completed (failure) + poller backstop.
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { betterAuthReady } from "./helpers/auth.js";
import { Queue, DEFAULT_LEASE_TTL_MS } from "../src/queue.js";
import {
  GhTokenSource,
  PrMergePoller,
  PrVerifier,
  type FetchLike,
} from "../src/github-pr.js";
import { GitHubWebhookHandler } from "../src/github-webhook.js";
import {
  ciFixMarker,
  isFailingConclusion,
  isUniqueConstraintError,
  maybeFileCiFix,
  listTasksWithPr,
} from "../src/github-ci-fix.js";

function jsonResponse(status: number, body: unknown, etag: string | null = null) {
  return {
    status,
    headers: { get: (name: string) => (name.toLowerCase() === "etag" ? etag : null) },
    json: async () => body,
  };
}

function failingOpenFetch(prNumber: number): FetchLike {
  return async (url) => {
    if (url.includes(`/pulls/${prNumber}`)) {
      return jsonResponse(200, { state: "open", merged: false, head: { sha: "deadbeef" } }, "e-fail");
    }
    if (url.includes("/status")) {
      return jsonResponse(200, {
        state: "failure",
        total_count: 1,
        statuses: [{ state: "failure" }],
      });
    }
    if (url.includes("/check-runs")) {
      return jsonResponse(200, {
        total_count: 1,
        check_runs: [{ status: "completed", conclusion: "failure" }],
      });
    }
    throw new Error(url);
  };
}

function mergedFetch(prNumber: number): FetchLike {
  return async (url) => {
    if (url.includes(`/pulls/${prNumber}`)) {
      return jsonResponse(200, { state: "closed", merged: true, head: { sha: "abc" } }, "e-merged");
    }
    throw new Error(url);
  };
}

async function setupAwaitingMerge(prNumber = 9) {
  const db = openDb(":memory:");
  await betterAuthReady(db);
  await db.prepare("INSERT INTO projects (id, name, repo) VALUES ('demo','Demo','x/y')").run();
  const queue = new Queue(db);
  const id = await queue.submit("demo", "dana", {
    title: "ship feature X",
    body: "implement X end-to-end",
    evidence: [],
  });
  await queue.claimNext("demo", "cc-7f2", DEFAULT_LEASE_TTL_MS);
  await queue.complete(id, "cc-7f2", "opened", `https://github.com/x/y/pull/${prNumber}`, {
    prDescription: "delivers the work as specified in the plan",
    terminal: "AWAITING_MERGE",
    prVerification: "open",
  });
  const worker = { findOrEnqueue: async () => 1 };
  return { db, queue, id, worker };
}

describe("isFailingConclusion", () => {
  it("accepts failure-class conclusions and rejects neutral/success/pending", () => {
    expect(isFailingConclusion("failure")).toBe(true);
    expect(isFailingConclusion("timed_out")).toBe(true);
    expect(isFailingConclusion("cancelled")).toBe(true);
    expect(isFailingConclusion("action_required")).toBe(true);
    expect(isFailingConclusion("neutral")).toBe(false);
    expect(isFailingConclusion("success")).toBe(false);
    expect(isFailingConclusion(null)).toBe(false);
    expect(isFailingConclusion(undefined)).toBe(false);
  });
});

describe("maybeFileCiFix", () => {
  it("files a QUEUED child linked to the parent with the marker and no groom", async () => {
    const { db, queue, id } = await setupAwaitingMerge(9);
    const parents = await listTasksWithPr(db, { repo: "x/y", prNumber: 9 });
    expect(parents).toHaveLength(1);

    const result = await maybeFileCiFix(db, queue, parents[0], {
      conclusion: "failure",
      headSha: "deadbeef",
    });
    expect(result).toMatchObject({ filed: true });
    if (!result.filed) throw new Error("expected filed");

    const child = await queue.brief(result.taskId);
    expect(child.state).toBe("QUEUED");
    expect(child.parent_id).toBe(id);
    expect(child.submitted_by).toBe("system");
    expect(child.priority).toBe(1);
    expect(child.title).toMatch(/^CI fix: PR #9/);
    expect(child.body).toContain(ciFixMarker(9));
    expect(child.body).toContain("https://github.com/x/y/pull/9");
    expect(child.body).toContain(`parent task #${id}`);
  });

  it("is idempotent while a non-DONE CI-fix child exists", async () => {
    const { db, queue } = await setupAwaitingMerge(9);
    const parents = await listTasksWithPr(db, { repo: "x/y", prNumber: 9 });
    const first = await maybeFileCiFix(db, queue, parents[0], { conclusion: "failure" });
    const second = await maybeFileCiFix(db, queue, parents[0], { conclusion: "failure" });
    expect(first.filed).toBe(true);
    expect(second).toEqual({ filed: false, reason: "ci-fix already open" });

    const kids = await db
      .prepare("SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ?")
      .get<{ n: number }>(parents[0].id);
    expect(kids?.n).toBe(1);
  });

  it("allows a new CI-fix after the previous child reaches DONE", async () => {
    const { db, queue } = await setupAwaitingMerge(9);
    const parents = await listTasksWithPr(db, { repo: "x/y", prNumber: 9 });
    const first = await maybeFileCiFix(db, queue, parents[0], { conclusion: "failure" });
    if (!first.filed) throw new Error("expected first filed");
    await db
      .prepare("UPDATE tasks SET state='DONE', updated_at=? WHERE id=?")
      .run(Date.now(), first.taskId);

    const again = await maybeFileCiFix(db, queue, parents[0], { conclusion: "failure" });
    expect(again.filed).toBe(true);
    if (!again.filed) throw new Error("expected refile");
    expect(again.taskId).not.toBe(first.taskId);
  });

  it("stores ci_fix_key so the partial unique index can enforce open-child uniqueness", async () => {
    const { db, queue } = await setupAwaitingMerge(9);
    const parents = await listTasksWithPr(db, { repo: "x/y", prNumber: 9 });
    const first = await maybeFileCiFix(db, queue, parents[0], { conclusion: "failure" });
    expect(first.filed).toBe(true);
    if (!first.filed) throw new Error("expected filed");

    const row = await db
      .prepare("SELECT ci_fix_key FROM tasks WHERE id = ?")
      .get<{ ci_fix_key: string | null }>(first.taskId);
    expect(row?.ci_fix_key).toBe(ciFixMarker(9));

    // Direct second insert of the same (parent_id, ci_fix_key) while open
    // must hit the partial unique index — this is the real atomic guard.
    // (Promise.all concurrency tests are no-ops under SQLite/PGlite mutexes.)
    await expect(
      db
        .prepare(
          `INSERT INTO tasks (
             project_id, title, body, priority, state, submitted_by,
             parent_id, ci_fix_key, queue_generation, created_at, updated_at
           ) VALUES ('demo', 'dup', 'dup body', 1, 'QUEUED', 'system', ?, ?, 1, ?, ?)`,
        )
        .run(parents[0].id, ciFixMarker(9), Date.now(), Date.now()),
    ).rejects.toThrow(/unique|UNIQUE|constraint/i);
  });

  it("releases the partial unique index when the open CI-fix child reaches DONE", async () => {
    const { db, queue } = await setupAwaitingMerge(9);
    const parents = await listTasksWithPr(db, { repo: "x/y", prNumber: 9 });
    const first = await maybeFileCiFix(db, queue, parents[0], { conclusion: "failure" });
    if (!first.filed) throw new Error("expected first filed");

    await db
      .prepare("UPDATE tasks SET state='DONE', updated_at=? WHERE id=?")
      .run(Date.now(), first.taskId);

    // Same key is allowed again once the prior child is terminal.
    await expect(
      db
        .prepare(
          `INSERT INTO tasks (
             project_id, title, body, priority, state, submitted_by,
             parent_id, ci_fix_key, queue_generation, created_at, updated_at
           ) VALUES ('demo', 'refile', 'refile body', 1, 'QUEUED', 'system', ?, ?, 1, ?, ?)`,
        )
        .run(parents[0].id, ciFixMarker(9), Date.now(), Date.now()),
    ).resolves.toBeTruthy();
  });

  it("classifies unique-violation errors for the submit catch path", () => {
    expect(isUniqueConstraintError({ code: "23505" })).toBe(true);
    expect(isUniqueConstraintError({ code: "SQLITE_CONSTRAINT_UNIQUE" })).toBe(true);
    expect(
      isUniqueConstraintError({
        code: "SQLITE_CONSTRAINT",
        message: "UNIQUE constraint failed: tasks.ci_fix_key",
      }),
    ).toBe(true);
    // FK / CHECK / not-null must not be swallowed as benign CI-fix dedup.
    expect(isUniqueConstraintError({ code: "SQLITE_CONSTRAINT_FOREIGNKEY" })).toBe(false);
    expect(isUniqueConstraintError({ code: "SQLITE_CONSTRAINT_CHECK" })).toBe(false);
    expect(isUniqueConstraintError({ code: "23503" })).toBe(false);
    expect(isUniqueConstraintError(new Error("boom"))).toBe(false);
  });

  it("queue.submit raises a classifiable unique error when the open CI-fix key collides", async () => {
    const { db, queue } = await setupAwaitingMerge(9);
    const parents = await listTasksWithPr(db, { repo: "x/y", prNumber: 9 });
    const first = await maybeFileCiFix(db, queue, parents[0], { conclusion: "failure" });
    expect(first.filed).toBe(true);

    // Simulate the post-pre-check loser: same key insert via the real submit path.
    let thrown: unknown;
    try {
      await queue.submit("demo", "system", {
        title: "race loser",
        body: `${ciFixMarker(9)}\nrace`,
        priority: 1,
        parentId: parents[0].id,
        ciFixKey: ciFixMarker(9),
        evidence: [],
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect(isUniqueConstraintError(thrown)).toBe(true);

    // Sequential maybeFileCiFix still returns filed:false (pre-check path).
    const second = await maybeFileCiFix(db, queue, parents[0], { conclusion: "failure" });
    expect(second).toEqual({ filed: false, reason: "ci-fix already open" });

    const openKids = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM tasks
         WHERE parent_id = ? AND state <> 'DONE' AND ci_fix_key = ?`,
      )
      .get<{ n: number }>(parents[0].id, ciFixMarker(9));
    expect(openKids?.n).toBe(1);
  });
});

describe("GitHubWebhookHandler CI-fix", () => {
  it("files one CI-fix on check_suite.completed failure for an open AWAITING_MERGE PR", async () => {
    const { db, queue, id, worker } = await setupAwaitingMerge(9);
    const verifier = new PrVerifier({
      tokens: new GhTokenSource(async () => "tok"),
      fetchImpl: failingOpenFetch(9),
    });
    const handler = new GitHubWebhookHandler(db, queue, worker as never, verifier);

    const result = await handler.handle("check_suite", {
      action: "completed",
      check_suite: {
        conclusion: "failure",
        head_sha: "deadbeef",
        pull_requests: [{ number: 9 }],
      },
      repository: { full_name: "x/y" },
    });
    expect(result.status).toBe("settled");

    const kids = await db
      .prepare(
        "SELECT id, parent_id, state, submitted_by, body, title FROM tasks WHERE parent_id = ?",
      )
      .all<{
        id: number;
        parent_id: number;
        state: string;
        submitted_by: string;
        body: string;
        title: string;
      }>(id);
    expect(kids).toHaveLength(1);
    expect(kids[0].state).toBe("QUEUED");
    expect(kids[0].submitted_by).toBe("system");
    expect(kids[0].body).toContain(ciFixMarker(9));
    // Parent still AWAITING_MERGE — CI-fix does not gate complete/DONE
    expect((await queue.brief(id)).state).toBe("AWAITING_MERGE");
    expect((await queue.brief(id)).pr_verification).toBe("checks-failing");
  });

  it("does not file a second child on webhook redelivery", async () => {
    const { db, queue, id, worker } = await setupAwaitingMerge(9);
    const verifier = new PrVerifier({
      tokens: new GhTokenSource(async () => "tok"),
      fetchImpl: failingOpenFetch(9),
    });
    const handler = new GitHubWebhookHandler(db, queue, worker as never, verifier);
    const payload = {
      action: "completed",
      check_suite: {
        conclusion: "failure",
        head_sha: "deadbeef",
        pull_requests: [{ number: 9 }],
      },
      repository: { full_name: "x/y" },
    };
    await handler.handle("check_suite", payload);
    await handler.handle("check_suite", payload);
    const kids = await db
      .prepare("SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ?")
      .get<{ n: number }>(id);
    expect(kids?.n).toBe(1);
  });

  it("ignores neutral conclusions (informational suites)", async () => {
    const { db, queue, id, worker } = await setupAwaitingMerge(9);
    const verifier = new PrVerifier({
      tokens: new GhTokenSource(async () => "tok"),
      fetchImpl: failingOpenFetch(9), // even if checks look red, conclusion gate wins first
    });
    const handler = new GitHubWebhookHandler(db, queue, worker as never, verifier);
    await handler.handle("check_suite", {
      action: "completed",
      check_suite: {
        conclusion: "neutral",
        pull_requests: [{ number: 9 }],
      },
      repository: { full_name: "x/y" },
    });
    const kids = await db
      .prepare("SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ?")
      .get<{ n: number }>(id);
    expect(kids?.n).toBe(0);
  });

  it("does not file CI-fix when the PR is already merged (DONE promote still works)", async () => {
    const { db, queue, id, worker } = await setupAwaitingMerge(9);
    const enqueued: unknown[] = [];
    const workerTrack = {
      findOrEnqueue: async (...args: unknown[]) => {
        enqueued.push(args);
        return 1;
      },
    };
    const verifier = new PrVerifier({
      tokens: new GhTokenSource(async () => "tok"),
      fetchImpl: mergedFetch(9),
    });
    const handler = new GitHubWebhookHandler(db, queue, workerTrack as never, verifier);
    const result = await handler.handle("check_suite", {
      action: "completed",
      check_suite: {
        conclusion: "failure", // post-merge noise must not file a fix task
        pull_requests: [{ number: 9 }],
      },
      repository: { full_name: "x/y" },
    });
    expect(result).toEqual({ status: "settled", outcomes: ["promoted"] });
    expect((await queue.brief(id)).state).toBe("DONE");
    const kids = await db
      .prepare("SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ?")
      .get<{ n: number }>(id);
    expect(kids?.n).toBe(0);
    expect(enqueued).toHaveLength(1); // reconcile only
  });

  it("files for a DONE parent whose PR is still open (legacy complete-before-merge)", async () => {
    const db = openDb(":memory:");
    await betterAuthReady(db);
    await db.prepare("INSERT INTO projects (id, name, repo) VALUES ('demo','Demo','x/y')").run();
    const queue = new Queue(db);
    const id = await queue.submit("demo", "dana", { title: "legacy", body: "b", evidence: [] });
    await queue.claimNext("demo", "cc-7f2", DEFAULT_LEASE_TTL_MS);
    // Force DONE with an open PR number (pre-#450 shape)
    await db
      .prepare(
        `UPDATE tasks SET state='DONE', result_pr_url=?, result_pr_number=?, result_pr_description=?,
                          result_summary=?, lease_agent=NULL, lease_expires_at=NULL, updated_at=?
         WHERE id=?`,
      )
      .run(
        "https://github.com/x/y/pull/42",
        42,
        "legacy description of the PR work",
        "done before merge gate",
        Date.now(),
        id,
      );

    const verifier = new PrVerifier({
      tokens: new GhTokenSource(async () => "tok"),
      fetchImpl: failingOpenFetch(42),
    });
    const handler = new GitHubWebhookHandler(db, queue, { findOrEnqueue: async () => 1 } as never, verifier);
    await handler.handle("check_suite", {
      action: "completed",
      check_suite: {
        conclusion: "failure",
        pull_requests: [{ number: 42 }],
      },
      repository: { full_name: "x/y" },
    });
    const kids = await db
      .prepare("SELECT id, parent_id, state FROM tasks WHERE parent_id = ?")
      .all<{ id: number; parent_id: number; state: string }>(id);
    expect(kids).toHaveLength(1);
    expect(kids[0].state).toBe("QUEUED");
  });
});

describe("PrMergePoller CI-fix backstop", () => {
  it("files a CI-fix when the poller sees checks-failing", async () => {
    const { db, queue, id, worker } = await setupAwaitingMerge(9);
    const verifier = new PrVerifier({
      tokens: new GhTokenSource(async () => "tok"),
      fetchImpl: failingOpenFetch(9),
    });
    const poller = new PrMergePoller(db, queue, worker as never, verifier, 60_000);
    await poller.tick();

    expect((await queue.brief(id)).pr_verification).toBe("checks-failing");
    const kids = await db
      .prepare("SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ?")
      .get<{ n: number }>(id);
    expect(kids?.n).toBe(1);

    // Second tick does not duplicate
    await poller.tick();
    const kids2 = await db
      .prepare("SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ?")
      .get<{ n: number }>(id);
    expect(kids2?.n).toBe(1);
  });
});
