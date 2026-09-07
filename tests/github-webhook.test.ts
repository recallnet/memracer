// tests/github-webhook.test.ts
// Signed GitHub App webhook → AWAITING_MERGE settle (primary path).
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp } from "../src/server.js";
import { openDb } from "../src/db.js";
import { betterAuthReady } from "./helpers/auth.js";
import { FakeDriver } from "../src/mediator/fake.js";
import type { MediatorWorker } from "../src/mediator/worker.js";
import type { Db } from "../src/db.js";
import { Queue, DEFAULT_LEASE_TTL_MS } from "../src/queue.js";
import {
  GhTokenSource,
  MERGE_PROBE_STALLED_REASON,
  MERGE_PROBE_TRANSIENT_BUDGET_MS,
  PrVerifier,
  type FetchLike,
} from "../src/github-pr.js";
import {
  verifyGitHubWebhookSignature,
  GitHubWebhookHandler,
} from "../src/github-webhook.js";

const SECRET = "test-webhook-secret";

function sign(body: string, secret = SECRET): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

function jsonResponse(status: number, body: unknown, etag: string | null = null) {
  return {
    status,
    headers: { get: (name: string) => (name.toLowerCase() === "etag" ? etag : null) },
    json: async () => body,
  };
}

describe("verifyGitHubWebhookSignature", () => {
  it("accepts a valid HMAC and rejects tamper / wrong secret / missing header", () => {
    const raw = Buffer.from('{"ok":true}');
    const good = sign(raw.toString());
    expect(verifyGitHubWebhookSignature(raw, good, SECRET)).toBe(true);
    expect(verifyGitHubWebhookSignature(raw, sign(raw.toString(), "other"), SECRET)).toBe(false);
    expect(verifyGitHubWebhookSignature(Buffer.from('{"ok":false}'), good, SECRET)).toBe(false);
    expect(verifyGitHubWebhookSignature(raw, undefined, SECRET)).toBe(false);
    expect(verifyGitHubWebhookSignature(raw, good, "")).toBe(false);
  });
});

describe("GitHubWebhookHandler", () => {
  it("promotes AWAITING_MERGE on pull_request closed+merged when verifier says merged-green", async () => {
    const db = openDb(":memory:");
    await betterAuthReady(db);
    await db.prepare("INSERT INTO projects (id, name, repo) VALUES ('demo','Demo','x/y')").run();
    const queue = new Queue(db);
    const id = await queue.submit("demo", "dana", { title: "t", body: "b", evidence: [] });
    await queue.claimNext("demo", "cc-7f2", DEFAULT_LEASE_TTL_MS);
    await queue.complete(id, "cc-7f2", "opened", "https://github.com/x/y/pull/9", {
      prDescription: "delivers the work as specified in the plan",
      terminal: "AWAITING_MERGE",
      prVerification: "open",
    });

    const enqueued: unknown[] = [];
    const worker = {
      findOrEnqueue: async (...args: unknown[]) => {
        enqueued.push(args);
        return 1;
      },
    };
    const verifier = new PrVerifier({
      tokens: new GhTokenSource(async () => "tok"),
      fetchImpl: async (url) => {
        if (url.includes("/pulls/")) {
          return jsonResponse(200, { state: "closed", merged: true, head: { sha: "abc" } }, "e1");
        }
        throw new Error(url);
      },
    });
    const handler = new GitHubWebhookHandler(db, queue, worker as never, verifier);
    const result = await handler.handle("pull_request", {
      action: "closed",
      number: 9,
      pull_request: { number: 9, merged: true, state: "closed" },
      repository: { full_name: "x/y" },
    });
    expect(result).toEqual({ status: "settled", outcomes: ["promoted"] });
    expect((await queue.brief(id)).state).toBe("DONE");
    expect(enqueued).toHaveLength(1);

    // Idempotent redelivery
    const again = await handler.handle("pull_request", {
      action: "closed",
      number: 9,
      pull_request: { number: 9, merged: true, state: "closed" },
      repository: { full_name: "x/y" },
    });
    expect(again).toEqual({ status: "ignored", reason: "no matching AWAITING_MERGE task" });
  });

  it("requeues AWAITING_MERGE when the PR is closed without merge and branch tip is abandoned in place", async () => {
    const db = openDb(":memory:");
    await betterAuthReady(db);
    await db.prepare("INSERT INTO projects (id, name, repo) VALUES ('demo','Demo','x/y')").run();
    const queue = new Queue(db);
    const id = await queue.submit("demo", "dana", { title: "t", body: "b", evidence: [] });
    await queue.claimNext("demo", "cc-7f2", DEFAULT_LEASE_TTL_MS);
    await queue.complete(id, "cc-7f2", "opened", "https://github.com/x/y/pull/9", {
      prDescription: "delivers the work as specified in the plan",
      terminal: "AWAITING_MERGE",
      prVerification: "open",
    });

    const worker = { findOrEnqueue: async () => 1 };
    const verifier = new PrVerifier({
      tokens: new GhTokenSource(async () => "tok"),
      fetchImpl: async (url) => {
        const path = new URL(url).pathname;
        if (path === "/repos/x/y/pulls/9") {
          return jsonResponse(200, {
            state: "closed",
            merged: false,
            head: { sha: "abc", ref: "feat" },
          }, "e2");
        }
        if (path === "/repos/x/y") return jsonResponse(200, { default_branch: "main" });
        if (path === "/repos/x/y/compare/main...abc") {
          return jsonResponse(200, { ahead_by: 1, status: "ahead" });
        }
        if (path === "/repos/x/y/commits/abc/pulls") {
          return jsonResponse(200, [{ number: 9, merged: false }]);
        }
        if (path === "/repos/x/y/git/ref/heads/feat") {
          return jsonResponse(200, { object: { sha: "abc" } });
        }
        throw new Error(`unexpected fetch ${url}`);
      },
    });
    const handler = new GitHubWebhookHandler(db, queue, worker as never, verifier);
    const result = await handler.handle("pull_request", {
      action: "closed",
      pull_request: { number: 9, merged: false, state: "closed", head: { sha: "abc", ref: "feat" } },
      repository: { full_name: "x/y" },
    });
    expect(result).toEqual({ status: "settled", outcomes: ["requeued"] });
    const brief = await queue.brief(id);
    expect(brief.state).toBe("QUEUED");
    expect(brief.pr_verification).toBe("closed-unmerged");
    expect(brief.result_pr_url).toBeNull();
    expect(brief.attempts.some((a) => a.outcome === "released" && /closed without merge/i.test(a.notes ?? ""))).toBe(
      true,
    );
  });

  it("ignores unknown PR numbers", async () => {
    const db = openDb(":memory:");
    await betterAuthReady(db);
    await db.prepare("INSERT INTO projects (id, name, repo) VALUES ('demo','Demo','x/y')").run();
    const queue = new Queue(db);
    const worker = { findOrEnqueue: async () => 1 };
    const verifier = new PrVerifier({
      tokens: new GhTokenSource(async () => "tok"),
      fetchImpl: async () => jsonResponse(200, {}),
    });
    const handler = new GitHubWebhookHandler(db, queue, worker as never, verifier);
    const result = await handler.handle("pull_request", {
      action: "closed",
      pull_request: { number: 999, merged: true },
      repository: { full_name: "x/y" },
    });
    expect(result).toEqual({ status: "ignored", reason: "no matching AWAITING_MERGE task" });
  });

  it("check_suite.completed re-verifies and promotes when merged-green", async () => {
    const db = openDb(":memory:");
    await betterAuthReady(db);
    await db.prepare("INSERT INTO projects (id, name, repo) VALUES ('demo','Demo','x/y')").run();
    const queue = new Queue(db);
    const id = await queue.submit("demo", "dana", { title: "t", body: "b", evidence: [] });
    await queue.claimNext("demo", "cc-7f2", DEFAULT_LEASE_TTL_MS);
    await queue.complete(id, "cc-7f2", "opened", "https://github.com/x/y/pull/9", {
      prDescription: "delivers the work as specified in the plan",
      terminal: "AWAITING_MERGE",
      prVerification: "merged-checks-pending",
    });

    const worker = { findOrEnqueue: async () => 1 };
    const verifier = new PrVerifier({
      tokens: new GhTokenSource(async () => "tok"),
      fetchImpl: async (url) => {
        if (url.includes("/pulls/")) {
          return jsonResponse(200, { state: "closed", merged: true, head: { sha: "abc" } }, "e3");
        }
        throw new Error(url);
      },
    });
    const handler = new GitHubWebhookHandler(db, queue, worker as never, verifier);
    const result = await handler.handle("check_suite", {
      action: "completed",
      check_suite: { conclusion: "success", pull_requests: [{ number: 9 }] },
      repository: { full_name: "x/y" },
    });
    expect(result).toEqual({ status: "settled", outcomes: ["promoted"] });
    expect((await queue.brief(id)).state).toBe("DONE");
  });

  it("check_suite reverify stays AWAITING_MERGE on transient check failure within budget", async () => {
    const db = openDb(":memory:");
    await betterAuthReady(db);
    await db.prepare("INSERT INTO projects (id, name, repo) VALUES ('demo','Demo','x/y')").run();
    const queue = new Queue(db);
    const id = await queue.submit("demo", "dana", { title: "t", body: "b", evidence: [] });
    await queue.claimNext("demo", "cc-7f2", DEFAULT_LEASE_TTL_MS);
    await queue.complete(id, "cc-7f2", "opened", "https://github.com/x/y/pull/21", {
      prDescription: "delivers the work as specified in the plan",
      terminal: "AWAITING_MERGE",
      prVerification: "open",
    });

    const worker = { findOrEnqueue: async () => 1 };
    const verifier = new PrVerifier({
      tokens: new GhTokenSource(async () => "tok"),
      fetchImpl: async () => jsonResponse(503, { message: "Service Unavailable" }),
    });
    const handler = new GitHubWebhookHandler(db, queue, worker as never, verifier);
    const result = await handler.handle("check_suite", {
      action: "completed",
      check_suite: { conclusion: "success", pull_requests: [{ number: 21 }] },
      repository: { full_name: "x/y" },
    });
    expect(result).toEqual({ status: "settled", outcomes: ["noop"] });
    expect((await queue.brief(id)).state).toBe("AWAITING_MERGE");
  });

  it("check_suite reverify escalates when transient budget is exhausted", async () => {
    const db = openDb(":memory:");
    await betterAuthReady(db);
    await db.prepare("INSERT INTO projects (id, name, repo) VALUES ('demo','Demo','x/y')").run();
    const queue = new Queue(db);
    const id = await queue.submit("demo", "dana", { title: "t", body: "b", evidence: [] });
    await queue.claimNext("demo", "cc-7f2", DEFAULT_LEASE_TTL_MS);
    await queue.complete(id, "cc-7f2", "opened", "https://github.com/x/y/pull/22", {
      prDescription: "delivers the work as specified in the plan",
      terminal: "AWAITING_MERGE",
      prVerification: "open",
    });
    const past = Date.now() - MERGE_PROBE_TRANSIENT_BUDGET_MS - 1;
    await db.prepare("UPDATE tasks SET merge_probe_transient_since = ? WHERE id = ?").run(past, id);

    const worker = { findOrEnqueue: async () => 1 };
    const verifier = new PrVerifier({
      tokens: new GhTokenSource(async () => "tok"),
      fetchImpl: async () => jsonResponse(429, { message: "API rate limit exceeded" }),
    });
    const handler = new GitHubWebhookHandler(db, queue, worker as never, verifier);
    const result = await handler.handle("check_suite", {
      action: "completed",
      check_suite: { conclusion: "success", pull_requests: [{ number: 22 }] },
      repository: { full_name: "x/y" },
    });
    expect(result).toEqual({ status: "settled", outcomes: ["blocked"] });
    const brief = await queue.brief(id);
    expect(brief.state).toBe("BLOCKED");
    expect(
      brief.questions.some(
        (qq) => qq.status === "open" && qq.question.includes(MERGE_PROBE_STALLED_REASON),
      ),
    ).toBe(true);
  });
});

describe("POST /api/github/webhooks HTTP", () => {
  let httpServer: Server;
  let baseUrl: string;
  let worker: MediatorWorker;
  let db: Db;
  let queue: Queue;

  beforeEach(async () => {
    db = openDb(":memory:");
    await betterAuthReady(db);
    await db.prepare("INSERT INTO projects (id, name, repo) VALUES ('demo','Demo','x/y')").run();
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes("/pulls/")) {
        return jsonResponse(200, { state: "closed", merged: true, head: { sha: "abc" } }, "e1");
      }
      throw new Error(url);
    };
    const prVerifier = new PrVerifier({
      tokens: new GhTokenSource(async () => "tok"),
      fetchImpl,
    });
    const made = createApp(db, {
      driverFor: () => new FakeDriver(),
      workerOpts: { tickMs: 20, jobTimeoutMs: 2000 },
      prVerifier,
      githubWebhookSecret: SECRET,
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

  async function postWebhook(body: object, headers: Record<string, string> = {}) {
    const raw = JSON.stringify(body);
    return fetch(`${baseUrl}/api/github/webhooks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sign(raw),
        "x-github-event": "pull_request",
        ...headers,
      },
      body: raw,
    });
  }

  it("rejects bad signatures with 401", async () => {
    const res = await postWebhook(
      { action: "closed" },
      { "x-hub-signature-256": sign("{}", "wrong") },
    );
    expect(res.status).toBe(401);
  });

  it("accepts a signed merge event and promotes the matching task", async () => {
    const id = await queue.submit("demo", "dana", { title: "t", body: "b", evidence: [] });
    await queue.claimNext("demo", "cc-7f2", DEFAULT_LEASE_TTL_MS);
    await queue.complete(id, "cc-7f2", "opened", "https://github.com/x/y/pull/9", {
      prDescription: "delivers the work as specified in the plan",
      terminal: "AWAITING_MERGE",
      prVerification: "open",
    });

    const res = await postWebhook({
      action: "closed",
      pull_request: { number: 9, merged: true, state: "closed" },
      repository: { full_name: "x/y" },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { status: string; outcomes: string[] };
    expect(json.status).toBe("settled");
    expect(json.outcomes).toContain("promoted");
    expect((await queue.brief(id)).state).toBe("DONE");
  });
});
