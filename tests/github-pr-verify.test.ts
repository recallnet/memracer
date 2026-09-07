// tests/github-pr-verify.test.ts
import { describe, expect, it, vi } from "vitest";
import {
  GhTokenSource,
  GithubHttpError,
  MERGE_PROBE_STALLED_REASON,
  MERGE_PROBE_TRANSIENT_BUDGET_MS,
  PrMergePoller,
  PrVerifier,
  isTransientGithubError,
  parsePrUrl,
  settleAwaitingMerge,
  type FetchLike,
  type PrVerification,
} from "../src/github-pr.js";
import { ProjectKnowledgeState } from "../src/mediator/project-knowledge.js";
import { Queue, DEFAULT_LEASE_TTL_MS } from "../src/queue.js";
import { openTestDb } from "./helpers/db.js";

function jsonResponse(
  status: number,
  body: unknown,
  etag: string | null = null,
  extraHeaders: Record<string, string> = {},
) {
  const headers: Record<string, string> = { ...extraHeaders };
  if (etag) headers.etag = etag;
  return {
    status,
    headers: {
      get: (name: string) => {
        const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
        return key ? headers[key] : null;
      },
    },
    json: async () => body,
  };
}

function fakeFetch(handlers: Record<string, () => ReturnType<typeof jsonResponse>>): FetchLike {
  return async (url) => {
    // Prefer the longest matching key so nested repo paths win over the repo root.
    const key = Object.keys(handlers)
      .filter((k) => url.includes(k))
      .sort((a, b) => b.length - a.length)[0];
    if (!key) throw new Error(`unexpected fetch ${url}`);
    return handlers[key]();
  };
}

/** Route GitHub REST paths by pathname suffix (repo root is exact path match). */
function githubPathFetch(routes: Record<string, () => ReturnType<typeof jsonResponse>>): FetchLike {
  return async (url) => {
    const path = new URL(url).pathname; // e.g. /repos/x/y/pulls/9
    if (routes[path]) return routes[path]();
    const key = Object.keys(routes)
      .filter((k) => path.endsWith(k) || path.includes(k))
      .sort((a, b) => b.length - a.length)[0];
    if (!key) throw new Error(`unexpected fetch ${url}`);
    return routes[key]();
  };
}

describe("parsePrUrl", () => {
  it("extracts owner/repo and number", () => {
    expect(parsePrUrl("https://github.com/recallnet/memracer/pull/294")).toEqual({
      ownerRepo: "recallnet/memracer",
      number: 294,
    });
  });

  it("rejects non-PR URLs", () => {
    expect(parsePrUrl("https://github.com/x/y/pulls")).toBeNull();
  });
});

describe("PrVerifier", () => {
  it("returns not-found on 404", async () => {
    const verifier = new PrVerifier({
      tokens: new GhTokenSource(async () => "tok"),
      fetchImpl: async () => jsonResponse(404, { message: "Not Found" }),
    });
    expect(await verifier.check("x/y", 1)).toEqual({ state: "not-found", etag: null });
  });

  it("returns open for an open PR with green or no checks", async () => {
    const verifier = new PrVerifier({
      tokens: new GhTokenSource(async () => "tok"),
      fetchImpl: fakeFetch({
        "/pulls/1": () =>
          jsonResponse(200, { state: "open", merged: false, head: { sha: "abc", ref: "feat" } }, "e1"),
        "/status": () => jsonResponse(200, { state: "success", total_count: 0, statuses: [] }),
        "/check-runs": () => jsonResponse(200, { total_count: 0, check_runs: [] }),
        "/protection/required_status_checks": () => jsonResponse(404, { message: "Not Found" }),
      }),
    });
    expect(await verifier.check("x/y", 1)).toMatchObject({ state: "open", etag: "e1" });
  });

  it("ignores optional check failures when required contexts are all green", async () => {
    const verifier = new PrVerifier({
      tokens: new GhTokenSource(async () => "tok"),
      fetchImpl: fakeFetch({
        "/pulls/10": () =>
          jsonResponse(200, { state: "open", merged: false, head: { sha: "sha10", ref: "feat" } }, "e10"),
        "/status": () =>
          jsonResponse(200, {
            state: "failure",
            total_count: 1,
            statuses: [{ state: "failure", context: "optional-lint" }],
          }),
        "/check-runs": () =>
          jsonResponse(200, {
            total_count: 2,
            check_runs: [
              { name: "test", status: "completed", conclusion: "success" },
              { name: "optional-browser", status: "completed", conclusion: "failure" },
            ],
          }),
        "/protection/required_status_checks": () =>
          jsonResponse(200, { contexts: ["test"], checks: [{ context: "test" }] }),
      }),
    });
    expect(await verifier.check("x/y", 10)).toMatchObject({ state: "open" });
  });

  it("reports checks-failing when a required check fails", async () => {
    const verifier = new PrVerifier({
      tokens: new GhTokenSource(async () => "tok"),
      fetchImpl: fakeFetch({
        "/pulls/11": () =>
          jsonResponse(200, { state: "open", merged: false, head: { sha: "sha11", ref: "feat" } }, "e11"),
        "/status": () => jsonResponse(200, { state: "success", total_count: 0, statuses: [] }),
        "/check-runs": () =>
          jsonResponse(200, {
            total_count: 1,
            check_runs: [{ name: "test", status: "completed", conclusion: "failure" }],
          }),
        "/protection/required_status_checks": () =>
          jsonResponse(200, { contexts: ["test"], checks: [{ context: "test" }] }),
      }),
    });
    expect(await verifier.check("x/y", 11)).toMatchObject({ state: "checks-failing" });
  });

  it("falls back to all-check failures when branch protection is unreadable", async () => {
    const verifier = new PrVerifier({
      tokens: new GhTokenSource(async () => "tok"),
      fetchImpl: fakeFetch({
        "/pulls/12": () =>
          jsonResponse(200, { state: "open", merged: false, head: { sha: "sha12", ref: "feat" } }, "e12"),
        "/status": () => jsonResponse(200, { state: "success", total_count: 0, statuses: [] }),
        "/check-runs": () =>
          jsonResponse(200, {
            total_count: 1,
            check_runs: [{ name: "optional", status: "completed", conclusion: "failure" }],
          }),
        "/protection/required_status_checks": () => jsonResponse(404, { message: "Not Found" }),
      }),
    });
    expect(await verifier.check("x/y", 12)).toMatchObject({ state: "checks-failing" });
  });

  it("returns merged-green when GitHub reports the PR merged (branch protection already enforced)", async () => {
    const verifier = new PrVerifier({
      tokens: new GhTokenSource(async () => "tok"),
      fetchImpl: fakeFetch({
        "/pulls/2": () =>
          jsonResponse(200, { state: "closed", merged: true, head: { sha: "def" }, merge_commit_sha: "def" }, "e2"),
      }),
    });
    expect(await verifier.check("x/y", 2)).toMatchObject({ state: "merged-green" });
  });

  it("does not re-query checks for a merged PR (optional failures must not block DONE)", async () => {
    let checkFetches = 0;
    const verifier = new PrVerifier({
      tokens: new GhTokenSource(async () => "tok"),
      fetchImpl: async (url) => {
        if (url.includes("/pulls/")) {
          return jsonResponse(200, { state: "closed", merged: true, head: { sha: "ghi" } }, "e3");
        }
        checkFetches += 1;
        return jsonResponse(200, { state: "failure", total_count: 1, statuses: [{ state: "failure" }] });
      },
    });
    expect(await verifier.check("x/y", 3)).toMatchObject({ state: "merged-green" });
    expect(checkFetches).toBe(0);
  });

  it("returns unchanged on 304", async () => {
    const verifier = new PrVerifier({
      tokens: new GhTokenSource(async () => "tok"),
      fetchImpl: async () => jsonResponse(304, null, "e-old"),
    });
    expect(await verifier.check("x/y", 1, "e-old")).toEqual({ state: "unchanged", etag: "e-old" });
  });

  it("throws a verification-unavailable error when no token is available", async () => {
    const verifier = new PrVerifier({
      tokens: new GhTokenSource(async () => null),
      fetchImpl: async () => jsonResponse(200, {}),
    });
    await expect(verifier.check("x/y", 1)).rejects.toThrow(/PR verification unavailable/);
    await expect(verifier.check("x/y", 1)).rejects.toThrow(/Do not infra_failure-requeue/);
  });

  it("prefers the App installation token over PAT when both exist", async () => {
    const auths: string[] = [];
    const installation = {
      tokenForRepo: async (repo: string) => {
        expect(repo).toBe("recallnet/memracer");
        return "install-tok";
      },
      invalidate: () => {},
    };
    const verifier = new PrVerifier({
      tokens: new GhTokenSource(async () => "pat-tok", installation),
      fetchImpl: async (_url, init) => {
        auths.push(init?.headers?.Authorization ?? "");
        return jsonResponse(200, { state: "closed", merged: true, head: { sha: "abc" } }, "e");
      },
    });
    expect(await verifier.check("recallnet/memracer", 9)).toMatchObject({ state: "merged-green" });
    expect(auths).toEqual(["Bearer install-tok"]);
  });

  it("falls back to PAT when installation provider returns null for the repo", async () => {
    const auths: string[] = [];
    const installation = {
      tokenForRepo: async () => null,
      invalidate: () => {},
    };
    const verifier = new PrVerifier({
      tokens: new GhTokenSource(async () => "pat-tok", installation),
      fetchImpl: async (_url, init) => {
        auths.push(init?.headers?.Authorization ?? "");
        return jsonResponse(200, { state: "closed", merged: true, head: { sha: "abc" } }, "e");
      },
    });
    expect(await verifier.check("x/y", 1)).toMatchObject({ state: "merged-green" });
    expect(auths).toEqual(["Bearer pat-tok"]);
  });
});

describe("Queue complete + promote with merge gate", () => {
  async function claimed() {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name, repo) VALUES ('demo','Demo','x/y')").run();
    const q = new Queue(db);
    const id = await q.submit("demo", "dana", { title: "t", body: "b", evidence: [] });
    await q.claimNext("demo", "cc-7f2", DEFAULT_LEASE_TTL_MS);
    return { db, q, id };
  }

  it("complete with open verification lands AWAITING_MERGE and releases the lease", async () => {
    const { q, id, db } = await claimed();
    const brief = await q.complete(id, "cc-7f2", "opened pr", "https://github.com/x/y/pull/9", {
      prDescription: "delivers the work as specified in the plan",
      terminal: "AWAITING_MERGE",
      prVerification: "open",
      prVerificationEtag: "etag-1",
    });
    expect(brief.state).toBe("AWAITING_MERGE");
    expect(brief.lease_agent).toBeNull();
    expect(brief.pr_verification).toBe("open");
    expect(brief.result_pr_number).toBe(9);
    const attempt = await db
      .prepare("SELECT outcome FROM attempts WHERE task_id=? ORDER BY id DESC LIMIT 1")
      .get(id);
    expect(attempt).toEqual({ outcome: "awaiting_merge" });
  });

  it("complete with merged-green lands DONE", async () => {
    const { q, id } = await claimed();
    const brief = await q.complete(id, "cc-7f2", "shipped", "https://github.com/x/y/pull/9", {
      prDescription: "delivers the work as specified in the plan",
      terminal: "DONE",
      prVerification: "merged-green",
    });
    expect(brief.state).toBe("DONE");
    expect(brief.pr_verification).toBe("merged-green");
  });

  it("promoteAwaitingMerge flips AWAITING_MERGE to DONE once", async () => {
    const { q, id, db } = await claimed();
    await q.complete(id, "cc-7f2", "opened", "https://github.com/x/y/pull/9", {
      prDescription: "delivers the work as specified in the plan",
      terminal: "AWAITING_MERGE",
      prVerification: "open",
    });
    const first = await q.promoteAwaitingMerge(id, {
      prVerification: "merged-green",
      prVerificationEtag: "e-m",
    });
    expect(first).toEqual({ agent: "cc-7f2" });
    expect((await q.brief(id)).state).toBe("DONE");
    const second = await q.promoteAwaitingMerge(id, { prVerification: "merged-green" });
    expect(second).toBeNull();
    expect(await db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE task_id=? AND outcome='completed'").get(id)).toEqual({
      n: 1,
    });
  });

  it("complete prefers an explicit prNumber over re-parsing the URL", async () => {
    const { q, id } = await claimed();
    const brief = await q.complete(id, "cc-7f2", "opened", "https://github.com/x/y/pull/9", {
      prDescription: "delivers the work as specified in the plan",
      terminal: "AWAITING_MERGE",
      prVerification: "open",
      prNumber: 42,
    });
    expect(brief.result_pr_number).toBe(42);
  });

  it("AWAITING_MERGE predecessor still counts as unsatisfied for dependents", async () => {
    const { db, q, id: pred } = await claimed();
    await q.complete(pred, "cc-7f2", "opened", "https://github.com/x/y/pull/9", {
      prDescription: "delivers the work as specified in the plan",
      terminal: "AWAITING_MERGE",
      prVerification: "open",
    });
    const dep = await q.submit("demo", "dana", { title: "dep", body: "b", evidence: [] });
    await q.addDependency("demo", dep, pred);
    const { unsatisfiedDeps } = await import("../src/queue.js");
    expect(await unsatisfiedDeps(db, dep)).toContain(pred);
  });
});

describe("PrMergePoller", () => {
  it("promotes AWAITING_MERGE to DONE when GitHub reports merged-green", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name, repo) VALUES ('demo','Demo','x/y')").run();
    const q = new Queue(db);
    const id = await q.submit("demo", "dana", { title: "t", body: "b", evidence: [] });
    await q.claimNext("demo", "cc-7f2", DEFAULT_LEASE_TTL_MS);
    await q.complete(id, "cc-7f2", "opened", "https://github.com/x/y/pull/9", {
      prDescription: "delivers the work as specified in the plan",
      terminal: "AWAITING_MERGE",
      prVerification: "open",
      prVerificationEtag: "e0",
    });

    const enqueued: unknown[] = [];
    const worker = {
      findOrEnqueue: async (...args: unknown[]) => {
        enqueued.push(args);
        return 1;
      },
    };

    let call = 0;
    const verifier = new PrVerifier({
      tokens: new GhTokenSource(async () => "tok"),
      fetchImpl: async (url) => {
        call += 1;
        if (url.includes("/pulls/")) {
          return jsonResponse(200, { state: "closed", merged: true, head: { sha: "abc" } }, "e1");
        }
        throw new Error(url);
      },
    });

    const poller = new PrMergePoller(db, q, worker as never, verifier);
    await poller.tick();
    expect((await q.brief(id)).state).toBe("DONE");
    expect((await q.brief(id)).pr_verification).toBe("merged-green");
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toEqual([
      "demo",
      "reconcile",
      {
        taskId: id,
        agent: "cc-7f2",
        prUrl: "https://github.com/x/y/pull/9",
        prDescription: "delivers the work as specified in the plan",
      },
    ]);
    expect(call).toBe(1);

    // Parity with immediate-DONE: markEvent fires for the three completion domains.
    const domains = [
      "priorities-roadmap",
      "architecture-tech",
      "history-decisions-learnings",
    ] as const;
    const rows = await db
      .prepare(
        `SELECT domain, requested_generation, dirty_reason FROM project_context_domains
         WHERE project_id='demo' AND domain IN (?, ?, ?) ORDER BY domain`,
      )
      .all<{ domain: string; requested_generation: number; dirty_reason: string | null }>(
        ...domains,
      );
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.requested_generation).toBeGreaterThanOrEqual(1);
      expect(row.dirty_reason).toContain(`task #${id} completed`);
    }
    const candidates = await new ProjectKnowledgeState(db).candidates("demo");
    const byDomain = new Map(candidates.map((c) => [c.domain, c]));
    for (const domain of domains) {
      const candidate = byDomain.get(domain);
      expect(candidate, `refresh candidate for ${domain}`).toBeDefined();
      expect(candidate!.triggers).toContain("EVENTS");
      expect(candidate!.reasons.some((r) => r.includes(`task #${id} completed`))).toBe(true);
    }
  });

  it("logs per-row verifier errors at debug and continues the tick", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name, repo) VALUES ('demo','Demo','x/y')").run();
    const q = new Queue(db);
    const id = await q.submit("demo", "dana", { title: "t", body: "b", evidence: [] });
    await q.claimNext("demo", "cc-7f2", DEFAULT_LEASE_TTL_MS);
    await q.complete(id, "cc-7f2", "opened", "https://github.com/x/y/pull/9", {
      prDescription: "delivers the work as specified in the plan",
      terminal: "AWAITING_MERGE",
      prVerification: "open",
    });

    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const worker = { findOrEnqueue: vi.fn(async () => 1) };
    const verifier = new PrVerifier({
      tokens: new GhTokenSource(async () => "tok"),
      fetchImpl: async () => {
        throw new Error("github 502");
      },
    });

    await new PrMergePoller(db, q, worker as never, verifier).tick();
    expect((await q.brief(id)).state).toBe("AWAITING_MERGE");
    expect(worker.findOrEnqueue).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalled();
    const logged = debug.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toMatch(/github 502|x\/y|#9|merge-poller/i);
    debug.mockRestore();
  });

  it("updates verification metadata without promoting when still open", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name, repo) VALUES ('demo','Demo','x/y')").run();
    const q = new Queue(db);
    const id = await q.submit("demo", "dana", { title: "t", body: "b", evidence: [] });
    await q.claimNext("demo", "cc-7f2", DEFAULT_LEASE_TTL_MS);
    await q.complete(id, "cc-7f2", "opened", "https://github.com/x/y/pull/9", {
      prDescription: "delivers the work as specified in the plan",
      terminal: "AWAITING_MERGE",
      prVerification: "open",
    });

    const worker = { findOrEnqueue: vi.fn(async () => 1) };
    const verifier = new PrVerifier({
      tokens: new GhTokenSource(async () => "tok"),
      fetchImpl: fakeFetch({
        "/pulls/9": () =>
          jsonResponse(200, { state: "open", merged: false, head: { sha: "abc" } }, "e-new"),
        "/status": () =>
          jsonResponse(200, { state: "failure", total_count: 1, statuses: [{ state: "failure" }] }),
        "/check-runs": () =>
          jsonResponse(200, {
            total_count: 1,
            check_runs: [{ status: "completed", conclusion: "failure" }],
          }),
      }),
    });

    await new PrMergePoller(db, q, worker as never, verifier).tick();
    const brief = await q.brief(id);
    expect(brief.state).toBe("AWAITING_MERGE");
    expect(brief.pr_verification).toBe("checks-failing" satisfies PrVerification);
    expect(worker.findOrEnqueue).not.toHaveBeenCalled();
  });

  it("requeues AWAITING_MERGE when closed-unmerged and head branch tip is still at the PR head", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name, repo) VALUES ('demo','Demo','x/y')").run();
    const q = new Queue(db);
    const id = await q.submit("demo", "dana", { title: "t", body: "b", evidence: [] });
    await q.claimNext("demo", "cc-7f2", DEFAULT_LEASE_TTL_MS);
    await q.complete(id, "cc-7f2", "opened", "https://github.com/x/y/pull/9", {
      prDescription: "delivers the work as specified in the plan",
      terminal: "AWAITING_MERGE",
      prVerification: "open",
    });

    const worker = { findOrEnqueue: vi.fn(async () => 1) };
    const verifier = new PrVerifier({
      tokens: new GhTokenSource(async () => "tok"),
      fetchImpl: githubPathFetch({
        "/repos/x/y/pulls/9": () =>
          jsonResponse(200, {
            state: "closed",
            merged: false,
            head: { sha: "deadbeef", ref: "feat-abandoned" },
          }, "e-closed"),
        "/repos/x/y": () => jsonResponse(200, { default_branch: "main" }),
        "/repos/x/y/compare/main...deadbeef": () =>
          jsonResponse(200, { ahead_by: 2, status: "ahead" }),
        "/repos/x/y/commits/deadbeef/pulls": () =>
          jsonResponse(200, [{ number: 9, merged: false }]),
        "/repos/x/y/git/ref/heads/feat-abandoned": () =>
          jsonResponse(200, { object: { sha: "deadbeef" } }),
      }),
    });

    await new PrMergePoller(db, q, worker as never, verifier).tick();
    const brief = await q.brief(id);
    expect(brief.state).toBe("QUEUED");
    expect(brief.pr_verification).toBe("closed-unmerged" satisfies PrVerification);
    expect(brief.result_pr_url).toBeNull();
    expect(brief.result_pr_number).toBeNull();
    expect(brief.result_summary).toBeNull();
    expect(worker.findOrEnqueue).not.toHaveBeenCalled();
    expect(
      brief.attempts.some(
        (a) => a.outcome === "released" && /closed without merge/i.test(a.notes ?? ""),
      ),
    ).toBe(true);
  });

  it("promotes AWAITING_MERGE to DONE when closed-unmerged head is already on the default branch", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name, repo) VALUES ('demo','Demo','x/y')").run();
    const q = new Queue(db);
    const id = await q.submit("demo", "dana", { title: "t", body: "b", evidence: [] });
    await q.claimNext("demo", "cc-7f2", DEFAULT_LEASE_TTL_MS);
    await q.complete(id, "cc-7f2", "opened", "https://github.com/x/y/pull/11", {
      prDescription: "delivers the work as specified in the plan",
      terminal: "AWAITING_MERGE",
      prVerification: "open",
    });

    const worker = { findOrEnqueue: vi.fn(async () => 1) };
    const markSpy = vi.spyOn(ProjectKnowledgeState.prototype, "markEvent").mockResolvedValue(undefined);
    const verifier = new PrVerifier({
      tokens: new GhTokenSource(async () => "tok"),
      fetchImpl: githubPathFetch({
        "/repos/x/y/pulls/11": () =>
          jsonResponse(200, {
            state: "closed",
            merged: false,
            head: { sha: "alreadyonmain", ref: "feat-stacked" },
          }, "e-elsewhere"),
        "/repos/x/y": () => jsonResponse(200, { default_branch: "main" }),
        "/repos/x/y/compare/main...alreadyonmain": () =>
          jsonResponse(200, { ahead_by: 0, status: "behind" }),
      }),
    });

    await new PrMergePoller(db, q, worker as never, verifier).tick();
    const brief = await q.brief(id);
    expect(brief.state).toBe("DONE");
    expect(brief.pr_verification).toBe("merged-green" satisfies PrVerification);
    expect(worker.findOrEnqueue).toHaveBeenCalledWith(
      "demo",
      "reconcile",
      expect.objectContaining({ taskId: id }),
    );
    expect(markSpy).toHaveBeenCalledWith(
      "demo",
      expect.any(Array),
      expect.stringMatching(/merged elsewhere/),
    );
    markSpy.mockRestore();
  });

  it("blocks AWAITING_MERGE for human attention when closed-unmerged head is off default and branch tip moved", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name, repo) VALUES ('demo','Demo','x/y')").run();
    const q = new Queue(db);
    const id = await q.submit("demo", "dana", { title: "t", body: "b", evidence: [] });
    await q.claimNext("demo", "cc-7f2", DEFAULT_LEASE_TTL_MS);
    await q.complete(id, "cc-7f2", "opened", "https://github.com/x/y/pull/12", {
      prDescription: "delivers the work as specified in the plan",
      terminal: "AWAITING_MERGE",
      prVerification: "open",
    });

    const worker = { findOrEnqueue: vi.fn(async () => 1) };
    const verifier = new PrVerifier({
      tokens: new GhTokenSource(async () => "tok"),
      fetchImpl: githubPathFetch({
        "/repos/x/y/pulls/12": () =>
          jsonResponse(200, {
            state: "closed",
            merged: false,
            head: { sha: "oldtip", ref: "feat-squashed" },
          }, "e-squash"),
        "/repos/x/y": () => jsonResponse(200, { default_branch: "main" }),
        "/repos/x/y/compare/main...oldtip": () =>
          jsonResponse(200, { ahead_by: 3, status: "ahead" }),
        "/repos/x/y/commits/oldtip/pulls": () =>
          jsonResponse(200, [{ number: 12, merged: false }]),
        "/repos/x/y/git/ref/heads/feat-squashed": () =>
          jsonResponse(404, { message: "Not Found" }),
      }),
    });

    await new PrMergePoller(db, q, worker as never, verifier).tick();
    const brief = await q.brief(id);
    expect(brief.state).toBe("BLOCKED");
    expect(brief.pr_verification).toBe("closed-unmerged" satisfies PrVerification);
    expect(brief.result_pr_url).toBe("https://github.com/x/y/pull/12");
    expect(worker.findOrEnqueue).not.toHaveBeenCalled();
    expect(brief.questions.some((q) => q.status === "open" && /squash|moved\/missing/i.test(q.question))).toBe(true);
    expect(
      brief.attempts.some(
        (a) => a.outcome === "blocked" && /squash-merged|moved\/missing/i.test(a.notes ?? ""),
      ),
    ).toBe(true);
  });

  it("leaves AWAITING_MERGE on transient probe failure (rate-limit) instead of permanent BLOCK", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name, repo) VALUES ('demo','Demo','x/y')").run();
    const q = new Queue(db);
    const id = await q.submit("demo", "dana", { title: "t", body: "b", evidence: [] });
    await q.claimNext("demo", "cc-7f2", DEFAULT_LEASE_TTL_MS);
    await q.complete(id, "cc-7f2", "opened", "https://github.com/x/y/pull/13", {
      prDescription: "delivers the work as specified in the plan",
      terminal: "AWAITING_MERGE",
      prVerification: "open",
    });

    const worker = { findOrEnqueue: vi.fn(async () => 1) };
    const verifier = new PrVerifier({
      tokens: new GhTokenSource(async () => "tok"),
      fetchImpl: githubPathFetch({
        "/repos/x/y/pulls/13": () =>
          jsonResponse(200, {
            state: "closed",
            merged: false,
            head: { sha: "ratelimited", ref: "feat-rl" },
          }, "e-rl"),
        "/repos/x/y": () => jsonResponse(200, { default_branch: "main" }),
        "/repos/x/y/compare/main...ratelimited": () =>
          jsonResponse(429, { message: "API rate limit exceeded" }),
      }),
    });

    await new PrMergePoller(db, q, worker as never, verifier).tick();
    const brief = await q.brief(id);
    expect(brief.state).toBe("AWAITING_MERGE");
    expect(worker.findOrEnqueue).not.toHaveBeenCalled();
    expect(brief.questions.filter((qq) => qq.status === "open")).toHaveLength(0);
    expect(brief.attempts.some((a) => a.outcome === "blocked")).toBe(false);
  });

  it("blocks AWAITING_MERGE when closed-unmerged probe gets a definitive non-transient error", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name, repo) VALUES ('demo','Demo','x/y')").run();
    const q = new Queue(db);
    const id = await q.submit("demo", "dana", { title: "t", body: "b", evidence: [] });
    await q.claimNext("demo", "cc-7f2", DEFAULT_LEASE_TTL_MS);
    await q.complete(id, "cc-7f2", "opened", "https://github.com/x/y/pull/14", {
      prDescription: "delivers the work as specified in the plan",
      terminal: "AWAITING_MERGE",
      prVerification: "open",
    });

    const worker = { findOrEnqueue: vi.fn(async () => 1) };
    const verifier = new PrVerifier({
      tokens: new GhTokenSource(async () => "tok"),
      fetchImpl: githubPathFetch({
        "/repos/x/y/pulls/14": () =>
          jsonResponse(200, {
            state: "closed",
            merged: false,
            head: { sha: "forbidden", ref: "feat-403" },
          }, "e-403"),
        "/repos/x/y": () => jsonResponse(200, { default_branch: "main" }),
        "/repos/x/y/compare/main...forbidden": () =>
          jsonResponse(403, { message: "Resource not accessible by integration" }),
      }),
    });

    await new PrMergePoller(db, q, worker as never, verifier).tick();
    const brief = await q.brief(id);
    expect(brief.state).toBe("BLOCKED");
    expect(brief.pr_verification).toBe("closed-unmerged" satisfies PrVerification);
    expect(
      brief.questions.some(
        (qq) => qq.status === "open" && /could not verify whether commits landed/i.test(qq.question),
      ),
    ).toBe(true);
  });

  it("blocks AWAITING_MERGE when closed-unmerged settles without a verifier", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name, repo) VALUES ('demo','Demo','x/y')").run();
    const q = new Queue(db);
    const id = await q.submit("demo", "dana", { title: "t", body: "b", evidence: [] });
    await q.claimNext("demo", "cc-7f2", DEFAULT_LEASE_TTL_MS);
    await q.complete(id, "cc-7f2", "opened", "https://github.com/x/y/pull/15", {
      prDescription: "delivers the work as specified in the plan",
      terminal: "AWAITING_MERGE",
      prVerification: "open",
    });

    const worker = { findOrEnqueue: vi.fn(async () => 1) };
    const row = (await db
      .prepare(
        `SELECT t.id, t.project_id, COALESCE(t.repo, p.repo) AS repo,
                t.result_pr_url, t.result_pr_number, t.result_pr_description,
                t.pr_verification, t.pr_verification_etag
         FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ?`,
      )
      .get<{
        id: number;
        project_id: string;
        repo: string | null;
        result_pr_url: string;
        result_pr_number: number;
        result_pr_description: string | null;
        pr_verification: string | null;
        pr_verification_etag: string | null;
      }>(id))!;

    const outcome = await settleAwaitingMerge(
      db,
      q,
      worker as never,
      row,
      {
        state: "closed-unmerged",
        etag: "e-no-verifier",
        headSha: "abc123",
        headRef: "feat-x",
      },
      undefined,
    );
    expect(outcome).toBe("blocked");
    const brief = await q.brief(id);
    expect(brief.state).toBe("BLOCKED");
    expect(
      brief.questions.some(
        (qq) => qq.status === "open" && /could not verify whether commits landed/i.test(qq.question),
      ),
    ).toBe(true);
  });

  it("promotes AWAITING_MERGE to DONE when head is off default but an associated PR is already merged", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name, repo) VALUES ('demo','Demo','x/y')").run();
    const q = new Queue(db);
    const id = await q.submit("demo", "dana", { title: "t", body: "b", evidence: [] });
    await q.claimNext("demo", "cc-7f2", DEFAULT_LEASE_TTL_MS);
    await q.complete(id, "cc-7f2", "opened", "https://github.com/x/y/pull/16", {
      prDescription: "delivers the work as specified in the plan",
      terminal: "AWAITING_MERGE",
      prVerification: "open",
    });

    const worker = { findOrEnqueue: vi.fn(async () => 1) };
    const markSpy = vi.spyOn(ProjectKnowledgeState.prototype, "markEvent").mockResolvedValue(undefined);
    const verifier = new PrVerifier({
      tokens: new GhTokenSource(async () => "tok"),
      fetchImpl: githubPathFetch({
        "/repos/x/y/pulls/16": () =>
          jsonResponse(200, {
            state: "closed",
            merged: false,
            head: { sha: "sharedsha", ref: "feat-landed-elsewhere" },
          }, "e-assoc"),
        "/repos/x/y": () => jsonResponse(200, { default_branch: "main" }),
        "/repos/x/y/compare/main...sharedsha": () =>
          jsonResponse(200, { ahead_by: 2, status: "ahead" }),
        // Branch tip still at head (would have been false requeue without associated-PR check).
        "/repos/x/y/commits/sharedsha/pulls": () =>
          jsonResponse(200, [
            { number: 16, merged: false },
            { number: 99, merged: true },
          ]),
        "/repos/x/y/git/ref/heads/feat-landed-elsewhere": () =>
          jsonResponse(200, { object: { sha: "sharedsha" } }),
      }),
    });

    await new PrMergePoller(db, q, worker as never, verifier).tick();
    const brief = await q.brief(id);
    expect(brief.state).toBe("DONE");
    expect(brief.pr_verification).toBe("merged-green" satisfies PrVerification);
    expect(worker.findOrEnqueue).toHaveBeenCalledWith(
      "demo",
      "reconcile",
      expect.objectContaining({ taskId: id }),
    );
    expect(markSpy).toHaveBeenCalledWith(
      "demo",
      expect.any(Array),
      expect.stringMatching(/merged elsewhere/),
    );
    markSpy.mockRestore();
  });

  it("isShaOnDefaultBranch is true only when compare ahead_by is 0", async () => {
    const verifier = new PrVerifier({
      tokens: new GhTokenSource(async () => "tok"),
      fetchImpl: githubPathFetch({
        "/repos/x/y": () => jsonResponse(200, { default_branch: "main" }),
        "/repos/x/y/compare/main...abc": () => jsonResponse(200, { ahead_by: 0 }),
        "/repos/x/y/compare/main...def": () => jsonResponse(200, { ahead_by: 1 }),
        "/repos/x/y/compare/main...gone": () => jsonResponse(404, { message: "Not Found" }),
      }),
    });
    expect(await verifier.isShaOnDefaultBranch("x/y", "abc")).toBe(true);
    expect(await verifier.isShaOnDefaultBranch("x/y", "def")).toBe(false);
    expect(await verifier.isShaOnDefaultBranch("x/y", "gone")).toBe(false);
  });

  it("classifies GitHub rate-limit/5xx and network codes as transient", () => {
    expect(isTransientGithubError(new Error("GitHub 429 for compare main...x"))).toBe(true);
    expect(isTransientGithubError(new Error("GitHub 503 for repos/x/y"))).toBe(true);
    expect(isTransientGithubError(new Error("GitHub 502 for commits/abc/pulls"))).toBe(true);
    expect(isTransientGithubError(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }))).toBe(true);
    expect(isTransientGithubError(new Error("fetch failed"))).toBe(true);
    expect(isTransientGithubError(new Error("GitHub 403 for compare main...x"))).toBe(false);
    expect(isTransientGithubError(new Error("GitHub 400 for compare main...x"))).toBe(false);
    expect(isTransientGithubError(new Error("unexpected"))).toBe(false);
    // 403 rate-limit signals (primary / secondary / remaining=0) are transient.
    expect(
      isTransientGithubError(
        new GithubHttpError({
          status: 403,
          path: "compare main...x",
          bodyMessage: "API rate limit exceeded for user ID 1",
          rateLimitRemaining: "0",
        }),
      ),
    ).toBe(true);
    expect(
      isTransientGithubError(
        new GithubHttpError({
          status: 403,
          path: "repos/x/y",
          bodyMessage: "You have exceeded a secondary rate limit. Please wait a few minutes.",
          retryAfter: "60",
        }),
      ),
    ).toBe(true);
    // 403 permission-denied without rate-limit signal stays definitive.
    expect(
      isTransientGithubError(
        new GithubHttpError({
          status: 403,
          path: "compare main...x",
          bodyMessage: "Resource not accessible by integration",
        }),
      ),
    ).toBe(false);
    // 401 is definitive (bad credentials do not self-heal by waiting).
    expect(
      isTransientGithubError(new GithubHttpError({ status: 401, path: "pulls/1", bodyMessage: "Bad credentials" })),
    ).toBe(false);
  });

  it("leaves AWAITING_MERGE on 403 rate-limit probe (not permanent BLOCK)", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name, repo) VALUES ('demo','Demo','x/y')").run();
    const q = new Queue(db);
    const id = await q.submit("demo", "dana", { title: "t", body: "b", evidence: [] });
    await q.claimNext("demo", "cc-7f2", DEFAULT_LEASE_TTL_MS);
    await q.complete(id, "cc-7f2", "opened", "https://github.com/x/y/pull/17", {
      prDescription: "delivers the work as specified in the plan",
      terminal: "AWAITING_MERGE",
      prVerification: "open",
    });

    const worker = { findOrEnqueue: vi.fn(async () => 1) };
    const verifier = new PrVerifier({
      tokens: new GhTokenSource(async () => "tok"),
      fetchImpl: githubPathFetch({
        "/repos/x/y/pulls/17": () =>
          jsonResponse(200, {
            state: "closed",
            merged: false,
            head: { sha: "rl403", ref: "feat-rl403" },
          }, "e-rl403"),
        "/repos/x/y": () => jsonResponse(200, { default_branch: "main" }),
        "/repos/x/y/compare/main...rl403": () =>
          jsonResponse(
            403,
            { message: "API rate limit exceeded for user ID 42" },
            null,
            { "x-ratelimit-remaining": "0", "retry-after": "30" },
          ),
      }),
    });

    await new PrMergePoller(db, q, worker as never, verifier).tick();
    const brief = await q.brief(id);
    expect(brief.state).toBe("AWAITING_MERGE");
    expect(brief.questions.filter((qq) => qq.status === "open")).toHaveLength(0);
    expect(brief.attempts.some((a) => a.outcome === "blocked")).toBe(false);
    const since = await db
      .prepare("SELECT merge_probe_transient_since AS s FROM tasks WHERE id = ?")
      .get<{ s: number | null }>(id);
    expect(since?.s).toEqual(expect.any(Number));
  });

  it("escalates to BLOCKED Needs-You when transient probe budget is exhausted", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name, repo) VALUES ('demo','Demo','x/y')").run();
    const q = new Queue(db);
    const id = await q.submit("demo", "dana", { title: "t", body: "b", evidence: [] });
    await q.claimNext("demo", "cc-7f2", DEFAULT_LEASE_TTL_MS);
    await q.complete(id, "cc-7f2", "opened", "https://github.com/x/y/pull/18", {
      prDescription: "delivers the work as specified in the plan",
      terminal: "AWAITING_MERGE",
      prVerification: "open",
    });
    // First transient already recorded beyond the budget.
    const past = Date.now() - MERGE_PROBE_TRANSIENT_BUDGET_MS - 1;
    await db
      .prepare("UPDATE tasks SET merge_probe_transient_since = ? WHERE id = ?")
      .run(past, id);

    const worker = { findOrEnqueue: vi.fn(async () => 1) };
    const verifier = new PrVerifier({
      tokens: new GhTokenSource(async () => "tok"),
      fetchImpl: githubPathFetch({
        "/repos/x/y/pulls/18": () =>
          jsonResponse(200, {
            state: "closed",
            merged: false,
            head: { sha: "stuck", ref: "feat-stuck" },
          }, "e-stuck"),
        "/repos/x/y": () => jsonResponse(200, { default_branch: "main" }),
        "/repos/x/y/compare/main...stuck": () =>
          jsonResponse(429, { message: "API rate limit exceeded" }),
      }),
    });

    await new PrMergePoller(db, q, worker as never, verifier).tick();
    const brief = await q.brief(id);
    expect(brief.state).toBe("BLOCKED");
    expect(brief.block_kind).toBe("human");
    expect(
      brief.questions.some(
        (qq) => qq.status === "open" && qq.question.includes(MERGE_PROBE_STALLED_REASON),
      ),
    ).toBe(true);
    expect(
      brief.attempts.some(
        (a) => a.outcome === "blocked" && (a.notes ?? "").includes(MERGE_PROBE_STALLED_REASON),
      ),
    ).toBe(true);
  });

  it("keeps AWAITING_MERGE when transient stamp is still within budget", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name, repo) VALUES ('demo','Demo','x/y')").run();
    const q = new Queue(db);
    const id = await q.submit("demo", "dana", { title: "t", body: "b", evidence: [] });
    await q.claimNext("demo", "cc-7f2", DEFAULT_LEASE_TTL_MS);
    await q.complete(id, "cc-7f2", "opened", "https://github.com/x/y/pull/19", {
      prDescription: "delivers the work as specified in the plan",
      terminal: "AWAITING_MERGE",
      prVerification: "open",
    });
    const recent = Date.now() - 60_000;
    await db
      .prepare("UPDATE tasks SET merge_probe_transient_since = ? WHERE id = ?")
      .run(recent, id);

    const worker = { findOrEnqueue: vi.fn(async () => 1) };
    const verifier = new PrVerifier({
      tokens: new GhTokenSource(async () => "tok"),
      fetchImpl: githubPathFetch({
        "/repos/x/y/pulls/19": () =>
          jsonResponse(200, {
            state: "closed",
            merged: false,
            head: { sha: "within", ref: "feat-within" },
          }, "e-within"),
        "/repos/x/y": () => jsonResponse(200, { default_branch: "main" }),
        "/repos/x/y/compare/main...within": () =>
          jsonResponse(503, { message: "Service Unavailable" }),
      }),
    });

    await new PrMergePoller(db, q, worker as never, verifier).tick();
    const brief = await q.brief(id);
    expect(brief.state).toBe("AWAITING_MERGE");
    expect(brief.questions.filter((qq) => qq.status === "open")).toHaveLength(0);
  });

  it("escalates when poller check itself stays failing past the transient budget", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name, repo) VALUES ('demo','Demo','x/y')").run();
    const q = new Queue(db);
    const id = await q.submit("demo", "dana", { title: "t", body: "b", evidence: [] });
    await q.claimNext("demo", "cc-7f2", DEFAULT_LEASE_TTL_MS);
    await q.complete(id, "cc-7f2", "opened", "https://github.com/x/y/pull/20", {
      prDescription: "delivers the work as specified in the plan",
      terminal: "AWAITING_MERGE",
      prVerification: "open",
    });
    const past = Date.now() - MERGE_PROBE_TRANSIENT_BUDGET_MS - 1;
    await db
      .prepare("UPDATE tasks SET merge_probe_transient_since = ? WHERE id = ?")
      .run(past, id);

    const worker = { findOrEnqueue: vi.fn(async () => 1) };
    const verifier = new PrVerifier({
      tokens: new GhTokenSource(async () => "tok"),
      fetchImpl: githubPathFetch({
        "/repos/x/y/pulls/20": () =>
          jsonResponse(503, { message: "GitHub is down" }),
      }),
    });

    await new PrMergePoller(db, q, worker as never, verifier).tick();
    const brief = await q.brief(id);
    expect(brief.state).toBe("BLOCKED");
    expect(
      brief.questions.some(
        (qq) => qq.status === "open" && qq.question.includes(MERGE_PROBE_STALLED_REASON),
      ),
    ).toBe(true);
  });

  it("clears merge_probe_transient_since on a successful 304/unchanged tick", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name, repo) VALUES ('demo','Demo','x/y')").run();
    const q = new Queue(db);
    const id = await q.submit("demo", "dana", { title: "t", body: "b", evidence: [] });
    await q.claimNext("demo", "cc-7f2", DEFAULT_LEASE_TTL_MS);
    await q.complete(id, "cc-7f2", "opened", "https://github.com/x/y/pull/21", {
      prDescription: "delivers the work as specified in the plan",
      terminal: "AWAITING_MERGE",
      prVerification: "open",
    });
    // Stale stamp from an earlier unrelated blip; etag so the poller can 304.
    const stale = Date.now() - MERGE_PROBE_TRANSIENT_BUDGET_MS - 60_000;
    await db
      .prepare(
        `UPDATE tasks SET merge_probe_transient_since = ?, pr_verification_etag = ? WHERE id = ?`,
      )
      .run(stale, "e-healthy", id);

    const worker = { findOrEnqueue: vi.fn(async () => 1) };
    const verifier = new PrVerifier({
      tokens: new GhTokenSource(async () => "tok"),
      fetchImpl: githubPathFetch({
        "/repos/x/y/pulls/21": () => jsonResponse(304, null, "e-healthy"),
      }),
    });

    await new PrMergePoller(db, q, worker as never, verifier).tick();
    const brief = await q.brief(id);
    expect(brief.state).toBe("AWAITING_MERGE");
    const since = await db
      .prepare("SELECT merge_probe_transient_since AS s FROM tasks WHERE id = ?")
      .get<{ s: number | null }>(id);
    expect(since?.s).toBeNull();
  });

  it("starts a fresh transient budget after a successful tick so one new blip does not escalate", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name, repo) VALUES ('demo','Demo','x/y')").run();
    const q = new Queue(db);
    const id = await q.submit("demo", "dana", { title: "t", body: "b", evidence: [] });
    await q.claimNext("demo", "cc-7f2", DEFAULT_LEASE_TTL_MS);
    await q.complete(id, "cc-7f2", "opened", "https://github.com/x/y/pull/22", {
      prDescription: "delivers the work as specified in the plan",
      terminal: "AWAITING_MERGE",
      prVerification: "open",
    });
    // Uncleared T0 past budget: without clear-on-success this would escalate on the next blip.
    const stale = Date.now() - MERGE_PROBE_TRANSIENT_BUDGET_MS - 60_000;
    await db
      .prepare(
        `UPDATE tasks SET merge_probe_transient_since = ?, pr_verification_etag = ? WHERE id = ?`,
      )
      .run(stale, "e-healthy", id);

    let pullCalls = 0;
    const worker = { findOrEnqueue: vi.fn(async () => 1) };
    const verifier = new PrVerifier({
      tokens: new GhTokenSource(async () => "tok"),
      fetchImpl: githubPathFetch({
        "/repos/x/y/pulls/22": () => {
          pullCalls += 1;
          // First tick: healthy 304. Second tick: brand-new transient failure.
          if (pullCalls === 1) return jsonResponse(304, null, "e-healthy");
          return jsonResponse(503, { message: "GitHub is down" });
        },
      }),
    });

    const poller = new PrMergePoller(db, q, worker as never, verifier);
    await poller.tick();
    const mid = await db
      .prepare("SELECT merge_probe_transient_since AS s FROM tasks WHERE id = ?")
      .get<{ s: number | null }>(id);
    expect(mid?.s).toBeNull();

    const beforeBlip = Date.now();
    await poller.tick();
    const brief = await q.brief(id);
    expect(brief.state).toBe("AWAITING_MERGE");
    expect(brief.questions.filter((qq) => qq.status === "open")).toHaveLength(0);
    const since = await db
      .prepare("SELECT merge_probe_transient_since AS s FROM tasks WHERE id = ?")
      .get<{ s: number | null }>(id);
    expect(since?.s).toEqual(expect.any(Number));
    // Fresh stamp from the new blip, not the stale T0.
    expect(since!.s!).toBeGreaterThanOrEqual(beforeBlip);
  });
});
