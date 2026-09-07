import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Db } from "./db.js";
import type { Queue } from "./queue.js";
import type { MediatorWorker } from "./mediator/worker.js";
import { ProjectKnowledgeState } from "./mediator/project-knowledge.js";
import { listTasksWithPr, maybeFileCiFix } from "./github-ci-fix.js";

/** Domains marked dirty when a task reaches DONE (parity: tools.ts immediate path). */
const COMPLETION_KNOWLEDGE_DOMAINS = [
  "priorities-roadmap",
  "architecture-tech",
  "history-decisions-learnings",
] as const;

const execFileAsync = promisify(execFile);

/**
 * Truthful completion status stored on tasks.pr_verification.
 * `merged-green` is the only status that authorizes DONE.
 */
export type PrVerification =
  | "open"
  | "checks-pending"
  | "checks-failing"
  | "merged-checks-pending"
  | "merged-checks-failing"
  | "merged-green"
  | "closed-unmerged"
  | "not-found";

/** Minimal fetch surface — injectable so tests never touch the network. */
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

/** Optional App installation token provider (preferred over PAT/gh). */
export type InstallationTokenReader = {
  tokenForRepo(repo: string): Promise<string | null>;
  invalidate(): void;
};

export const VERIFICATION_UNAVAILABLE_MESSAGE =
  "PR verification unavailable — configure GitHub App installation auth " +
  "(MEMRACER_GITHUB_APP_ID + MEMRACER_GITHUB_APP_PRIVATE_KEY with an enrolled project repo) " +
  "or set MEMRACER_GITHUB_TOKEN / authenticate `gh`. " +
  "Do not infra_failure-requeue: leave the lease or release with reason verification-unavailable — completion refused";

/**
 * Token order for a PR repo: App installation token → MEMRACER_GITHUB_TOKEN → `gh auth token`.
 * PAT/gh is cached once; installation tokens are cached by the provider.
 */
export class GhTokenSource {
  private patCached: string | null = null;
  private patResolved = false;

  constructor(
    private readonly readPat: () => Promise<string | null> = async () => {
      const env = process.env.MEMRACER_GITHUB_TOKEN?.trim();
      if (env) return env;
      try {
        const { stdout } = await execFileAsync("gh", ["auth", "token"]);
        const token = stdout.trim();
        return token || null;
      } catch {
        return null;
      }
    },
    private readonly installation: InstallationTokenReader | null = null,
  ) {}

  /** Returns a token or null when none is available (fail-closed callers). */
  async token(repo?: string): Promise<string | null> {
    if (repo && this.installation) {
      try {
        const installToken = await this.installation.tokenForRepo(repo);
        if (installToken) return installToken;
      } catch {
        // Fall through to PAT/gh; boot/complete still fail closed if both miss.
      }
    }
    if (!this.patResolved) {
      this.patCached = await this.readPat();
      this.patResolved = true;
    }
    return this.patCached;
  }

  /** Throws when no token can be resolved — used at boot and by complete. */
  async requireToken(repo?: string): Promise<string> {
    const token = await this.token(repo);
    if (!token) throw new Error(VERIFICATION_UNAVAILABLE_MESSAGE);
    return token;
  }

  /** True when PAT/gh is available without needing a repo installation. */
  async hasPatOrGh(): Promise<boolean> {
    return (await this.token()) !== null;
  }

  /** True when App installation tokens can be attempted for some repo. */
  hasInstallationProvider(): boolean {
    return this.installation !== null;
  }

  invalidate(): void {
    this.patCached = null;
    this.patResolved = false;
    this.installation?.invalidate();
  }
}

export interface PrCheck {
  /** "unchanged" only when an etag was sent and GitHub answered 304 (rate-free). */
  state: PrVerification | "unchanged";
  etag: string | null;
  headSha?: string;
  /** PR head branch name when known (used by closed-unmerged abandon vs squash probe). */
  headRef?: string;
}

interface PullJson {
  state: string;
  merged: boolean;
  head?: { sha?: string; ref?: string };
  merge_commit_sha?: string | null;
}

interface CombinedStatusJson {
  state: string;
  total_count: number;
  statuses?: Array<{ state: string; context?: string }>;
}

interface CheckRunsJson {
  total_count: number;
  check_runs?: Array<{ name?: string; status: string; conclusion: string | null }>;
}

interface RequiredStatusChecksJson {
  contexts?: string[];
  checks?: Array<{ context?: string }>;
}

/** Checks a PR's live merge + required-check state via the GitHub REST API. */
export class PrVerifier {
  private readonly fetchImpl: FetchLike;
  private readonly tokens: GhTokenSource;

  constructor(opts: { fetchImpl?: FetchLike; tokens?: GhTokenSource } = {}) {
    this.fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
    this.tokens = opts.tokens ?? new GhTokenSource();
  }

  async check(repo: string, prNumber: number, etag?: string | null): Promise<PrCheck> {
    const url = `https://api.github.com/repos/${repo}/pulls/${prNumber}`;
    let res = await this.request(url, repo, etag);
    if (res.status === 401) {
      this.tokens.invalidate();
      res = await this.request(url, repo, etag);
    }
    if (res.status === 304) return { state: "unchanged", etag: etag ?? null };
    if (res.status === 404) return { state: "not-found", etag: null };
    if (res.status !== 200) {
      throw await githubHttpErrorFromResponse(res, `pulls/${prNumber}`);
    }
    const pr = (await res.json()) as PullJson;
    const headSha = pr.head?.sha ?? pr.merge_commit_sha ?? undefined;
    const headRef = pr.head?.ref ?? undefined;
    const responseEtag = res.headers.get("etag");

    // A landed merge already passed the repo's required checks (branch
    // protection / merge queue). Re-reading every check-run would false-block
    // DONE on optional or post-merge noise, so merged ⇒ merged-green.
    if (pr.merged) {
      return { state: "merged-green", etag: responseEtag, headSha, headRef };
    }
    if (pr.state === "closed") {
      return { state: "closed-unmerged", etag: responseEtag, headSha, headRef };
    }
    if (headSha) {
      const branch = pr.head?.ref ?? null;
      const green = await this.checksGreen(repo, headSha, branch);
      if (green === "failing") return { state: "checks-failing", etag: responseEtag, headSha, headRef };
      if (green === "pending") return { state: "checks-pending", etag: responseEtag, headSha, headRef };
    }
    return { state: "open", etag: responseEtag, headSha, headRef };
  }

  /**
   * True when `sha` is already an ancestor of the repo default branch
   * (ahead_by === 0 on compare). Used to detect work that landed under a
   * different PR number while this PR shows closed-unmerged.
   */
  async isShaOnDefaultBranch(repo: string, sha: string): Promise<boolean> {
    const repoRes = await this.request(`https://api.github.com/repos/${repo}`, repo);
    if (repoRes.status !== 200) {
      throw await githubHttpErrorFromResponse(repoRes, `repos/${repo}`);
    }
    const { default_branch: defaultBranch } = (await repoRes.json()) as { default_branch?: string };
    if (!defaultBranch) return false;
    const compareUrl =
      `https://api.github.com/repos/${repo}/compare/${encodeURIComponent(defaultBranch)}...${encodeURIComponent(sha)}`;
    const compareRes = await this.request(compareUrl, repo);
    if (compareRes.status === 404) return false;
    if (compareRes.status !== 200) {
      throw await githubHttpErrorFromResponse(
        compareRes,
        `compare ${defaultBranch}...${sha}`,
      );
    }
    const body = (await compareRes.json()) as { ahead_by?: number };
    return (body.ahead_by ?? 1) === 0;
  }

  /**
   * Current tip SHA of `refs/heads/{ref}`, or null when the branch is gone.
   * Used to distinguish abandoned PRs (tip still at headSha) from squash/stack
   * rewrites (tip moved or deleted).
   */
  async headBranchTip(repo: string, ref: string): Promise<string | null> {
    const url =
      `https://api.github.com/repos/${repo}/git/ref/heads/${encodeURIComponent(ref)}`;
    const res = await this.request(url, repo);
    if (res.status === 404) return null;
    if (res.status !== 200) {
      throw await githubHttpErrorFromResponse(res, `git/ref/heads/${ref}`);
    }
    const body = (await res.json()) as { object?: { sha?: string } };
    return body.object?.sha ?? null;
  }

  /**
   * PRs GitHub associates with `sha` (List pull requests associated with a commit).
   * Used when closed-unmerged head is not on the default branch but the same
   * commits may already have landed under a different PR number.
   */
  async associatedPulls(
    repo: string,
    sha: string,
  ): Promise<Array<{ number: number; merged: boolean }>> {
    const url = `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(sha)}/pulls`;
    const res = await this.request(url, repo);
    if (res.status === 404) return [];
    if (res.status !== 200) {
      throw await githubHttpErrorFromResponse(res, `commits/${sha}/pulls`);
    }
    const body = (await res.json()) as Array<{ number?: number; merged?: boolean }>;
    if (!Array.isArray(body)) return [];
    return body
      .filter((p): p is { number: number; merged?: boolean } => typeof p.number === "number")
      .map((p) => ({ number: p.number, merged: p.merged === true }));
  }

  /**
   * Required status-check contexts for a branch. Returns null when protection
   * is missing or unreadable (404/403) so callers fall back to all checks.
   */
  private async requiredCheckContexts(repo: string, branch: string | null): Promise<Set<string> | null> {
    if (!branch) return null;
    const res = await this.request(
      `https://api.github.com/repos/${repo}/branches/${encodeURIComponent(branch)}/protection/required_status_checks`,
      repo,
    );
    if (res.status === 401) {
      this.tokens.invalidate();
      throw new Error(`GitHub 401 while reading required checks for ${repo}@${branch}`);
    }
    if (res.status === 404 || res.status === 403) return null;
    if (res.status !== 200) return null;
    const body = (await res.json()) as RequiredStatusChecksJson;
    const names = new Set<string>();
    for (const c of body.contexts ?? []) {
      if (c) names.add(c);
    }
    for (const c of body.checks ?? []) {
      if (c.context) names.add(c.context);
    }
    return names.size > 0 ? names : null;
  }

  /**
   * Open-PR check snapshot for AWAITING_MERGE metadata only. Does not gate
   * DONE — that requires merge. When branch protection lists required checks,
   * only those contexts/names count; optional failures are ignored. When
   * protection is unreadable, every observed check counts (legacy).
   */
  private async checksGreen(
    repo: string,
    sha: string,
    branch: string | null = null,
  ): Promise<"green" | "pending" | "failing"> {
    const [statusRes, runsRes, required] = await Promise.all([
      this.request(`https://api.github.com/repos/${repo}/commits/${sha}/status`, repo),
      this.request(`https://api.github.com/repos/${repo}/commits/${sha}/check-runs`, repo),
      this.requiredCheckContexts(repo, branch),
    ]);
    if (statusRes.status === 401 || runsRes.status === 401) {
      this.tokens.invalidate();
      throw new GithubHttpError({
        status: 401,
        path: `checks ${repo}@${sha}`,
        bodyMessage: "Bad credentials",
      });
    }
    if (statusRes.status !== 200 && statusRes.status !== 404) {
      throw await githubHttpErrorFromResponse(statusRes, `commit status ${repo}@${sha}`);
    }
    if (runsRes.status !== 200 && runsRes.status !== 404) {
      throw await githubHttpErrorFromResponse(runsRes, `check-runs ${repo}@${sha}`);
    }

    const consider = (name: string | undefined): boolean => {
      if (!required) return true;
      if (!name) return false;
      return required.has(name);
    };

    let pending = false;
    let failing = false;

    if (statusRes.status === 200) {
      const combined = (await statusRes.json()) as CombinedStatusJson;
      if (combined.total_count > 0) {
        // Prefer per-status context filtering when required set is known.
        if (required) {
          for (const s of combined.statuses ?? []) {
            if (!consider(s.context)) continue;
            if (s.state === "failure" || s.state === "error") failing = true;
            else if (s.state === "pending") pending = true;
          }
        } else {
          if (combined.state === "failure" || combined.state === "error") failing = true;
          else if (combined.state === "pending") pending = true;
          for (const s of combined.statuses ?? []) {
            if (s.state === "failure" || s.state === "error") failing = true;
            else if (s.state === "pending") pending = true;
          }
        }
      }
    }

    if (runsRes.status === 200) {
      const runs = (await runsRes.json()) as CheckRunsJson;
      for (const run of runs.check_runs ?? []) {
        if (!consider(run.name)) continue;
        if (run.status !== "completed") {
          pending = true;
          continue;
        }
        const c = run.conclusion;
        if (c === "failure" || c === "cancelled" || c === "timed_out" || c === "action_required") {
          failing = true;
        }
      }
    }

    if (failing) return "failing";
    if (pending) return "pending";
    return "green";
  }

  private async request(url: string, repo: string, etag?: string | null) {
    const token = await this.tokens.requireToken(repo);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "memracer",
    };
    if (etag) headers["If-None-Match"] = etag;
    return this.fetchImpl(url, { headers });
  }
}

export const PR_POLL_INTERVAL_MS = 5 * 60 * 1000;

/** Consecutive transient merge-probe failures may stay silent for this long. */
export const MERGE_PROBE_TRANSIENT_BUDGET_MS = 60 * 60 * 1000;

/** Human-visible Needs-You reason after the transient budget is exhausted. */
export const MERGE_PROBE_STALLED_REASON = "merge verification stalled — GitHub unreachable";

/**
 * GitHub REST failure that preserves status + body/header rate-limit signals
 * so classifiers can tell 403 rate-limit apart from 403 permission-denied.
 */
export class GithubHttpError extends Error {
  readonly status: number;
  readonly path: string;
  readonly bodyMessage: string | null;
  readonly retryAfter: string | null;
  readonly rateLimitRemaining: string | null;

  constructor(opts: {
    status: number;
    path: string;
    bodyMessage?: string | null;
    retryAfter?: string | null;
    rateLimitRemaining?: string | null;
  }) {
    const detail = opts.bodyMessage ? `: ${opts.bodyMessage}` : "";
    super(`GitHub ${opts.status} for ${opts.path}${detail}`);
    this.name = "GithubHttpError";
    this.status = opts.status;
    this.path = opts.path;
    this.bodyMessage = opts.bodyMessage ?? null;
    this.retryAfter = opts.retryAfter ?? null;
    this.rateLimitRemaining = opts.rateLimitRemaining ?? null;
  }
}

type HeaderSource = { get(name: string): string | null };

/** Build a GithubHttpError from a non-OK response, best-effort body message. */
export async function githubHttpErrorFromResponse(
  res: { status: number; headers: HeaderSource; json(): Promise<unknown> },
  path: string,
): Promise<GithubHttpError> {
  let bodyMessage: string | null = null;
  try {
    const body = (await res.json()) as { message?: unknown };
    if (typeof body?.message === "string" && body.message.trim()) {
      bodyMessage = body.message.trim().slice(0, 240);
    }
  } catch {
    // Body may not be JSON; status + headers still classify rate limits.
  }
  return new GithubHttpError({
    status: res.status,
    path,
    bodyMessage,
    retryAfter: res.headers.get("retry-after") ?? res.headers.get("Retry-After"),
    rateLimitRemaining:
      res.headers.get("x-ratelimit-remaining") ?? res.headers.get("X-RateLimit-Remaining"),
  });
}

function isGithubRateLimitSignal(err: GithubHttpError): boolean {
  const msg = `${err.bodyMessage ?? ""} ${err.message}`;
  if (/rate\s*limit|secondary\s*rate|abuse\s*detection/i.test(msg)) return true;
  if (err.rateLimitRemaining === "0") return true;
  if (err.retryAfter && /rate|abuse|secondary|limit/i.test(msg)) return true;
  return false;
}

/**
 * True when a merge-probe / verifier failure is likely temporary and the task
 * should stay AWAITING_MERGE for the next poller/webhook tick, not permanent
 * human-BLOCK. Matches GithubHttpError status+signals, plain
 * `GitHub ${status} for …` throws, and common network error codes.
 *
 * 401 stays definitive (token invalidate + one retry already ran; bad
 * credentials do not self-heal by waiting). Bare 403 without a rate-limit
 * signal stays definitive (permission-denied).
 */
export function isTransientGithubError(err: unknown): boolean {
  if (err == null) return false;
  if (err instanceof GithubHttpError) {
    if (err.status === 429 || (err.status >= 500 && err.status <= 599)) return true;
    if (err.status === 403 && isGithubRateLimitSignal(err)) return true;
    return false;
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/\bGitHub (429|5\d{2})\b/.test(message)) return true;
  // Legacy plain-string 403 rate-limit (body folded into the message).
  if (/\bGitHub 403\b/.test(message) && /rate\s*limit|secondary\s*rate|abuse\s*detection/i.test(message)) {
    return true;
  }
  if (/\b(ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN)\b/.test(message)) return true;
  if (/\bfetch failed\b/i.test(message)) return true;
  if (err instanceof Error && err.name === "AbortError") return true;
  const code =
    typeof err === "object" && err !== null && "code" in err
      ? String((err as { code: unknown }).code)
      : "";
  if (/^(ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN)$/.test(code)) return true;
  return false;
}

export interface TrackedPr {
  id: number;
  project_id: string;
  repo: string | null;
  result_pr_url: string;
  result_pr_number: number;
  result_pr_description: string | null;
  pr_verification: string | null;
  pr_verification_etag: string | null;
}

/**
 * Record a transient (or poller-swallowed) merge-probe failure. Stay in
 * AWAITING_MERGE until MERGE_PROBE_TRANSIENT_BUDGET_MS elapses, then escalate
 * to human-BLOCKED Needs-You so the stall is not silent limbo.
 */
export async function handleMergeProbeFailure(
  queue: Queue,
  row: Pick<TrackedPr, "id" | "pr_verification" | "pr_verification_etag">,
  err: unknown,
  logLabel: string,
): Promise<"noop" | "blocked"> {
  const message = err instanceof Error ? err.message : String(err);
  console.debug(`[${logLabel}] probe failure for task ${row.id}: ${message}`);
  const since = await queue.noteMergeProbeTransient(row.id);
  if (Date.now() - since < MERGE_PROBE_TRANSIENT_BUDGET_MS) {
    return "noop";
  }
  const blocked = await queue.flagMergedElsewhereAttention(row.id, {
    prVerification: row.pr_verification,
    prVerificationEtag: row.pr_verification_etag,
    reason: MERGE_PROBE_STALLED_REASON,
  });
  await queue.clearMergeProbeTransient(row.id);
  return blocked ? "blocked" : "noop";
}

const AWAITING_VERIFICATIONS = new Set([
  "open",
  "checks-pending",
  "checks-failing",
  "merged-checks-pending",
  "merged-checks-failing",
]);

/**
 * Apply one PR check result to an AWAITING_MERGE task. Shared by the 5-minute
 * poller backstop and the GitHub App webhook primary path.
 *
 * A healthy probe clears the transient stamp — including 304/unchanged, which
 * does not change task state. Do not clear at the very top of this function:
 * closed-unmerged still runs deeper probes after check(); wiping the stamp
 * before those would restart the 1h budget on every tick that reaches
 * settleClosedUnmerged, so multi-tick rate-limits would never escalate.
 */
export async function settleAwaitingMerge(
  db: Db,
  queue: Queue,
  worker: MediatorWorker,
  row: TrackedPr,
  check: PrCheck,
  verifier?: PrVerifier,
): Promise<"promoted" | "requeued" | "blocked" | "updated" | "noop"> {
  // 304/unchanged: GitHub reachable, no state change — still a successful probe.
  if (check.state === "unchanged") {
    await queue.clearMergeProbeTransient(row.id);
    return "noop";
  }
  if (check.state === "not-found") {
    await db
      .prepare(
        `UPDATE tasks SET pr_verification='not-found', pr_verification_etag=NULL, updated_at=?
         WHERE id=? AND state='AWAITING_MERGE'`,
      )
      .run(Date.now(), row.id);
    await queue.clearMergeProbeTransient(row.id);
    queue.notifyChanged(row.project_id);
    return "updated";
  }
  if (check.state === "merged-green") {
    const promoted = await queue.promoteAwaitingMerge(row.id, {
      prVerification: "merged-green",
      prVerificationEtag: check.etag,
    });
    if (!promoted) return "noop";
    await queue.clearMergeProbeTransient(row.id);
    // Completing agent comes from promoteAwaitingMerge (awaiting_merge attempt);
    // do not re-query or degrade to "unknown".
    await new ProjectKnowledgeState(db).markEvent(
      row.project_id,
      [...COMPLETION_KNOWLEDGE_DOMAINS],
      `task #${row.id} completed`,
    );
    await worker.findOrEnqueue(row.project_id, "reconcile", {
      taskId: row.id,
      agent: promoted.agent,
      prUrl: row.result_pr_url,
      prDescription: row.result_pr_description ?? "",
    });
    return "promoted";
  }
  // CLOSED without merge: decide DONE (merged elsewhere) / QUEUED (abandoned) /
  // BLOCKED human (squash/stack ambiguous). Never silent limbo in AWAITING_MERGE.
  if (check.state === "closed-unmerged") {
    return settleClosedUnmerged(db, queue, worker, row, check, verifier);
  }
  if (AWAITING_VERIFICATIONS.has(check.state)) {
    await db
      .prepare(
        `UPDATE tasks SET pr_verification=?, pr_verification_etag=?, updated_at=?
         WHERE id=? AND state='AWAITING_MERGE'`,
      )
      .run(check.state, check.etag, Date.now(), row.id);
    await queue.clearMergeProbeTransient(row.id);
    queue.notifyChanged(row.project_id);
    return "updated";
  }
  return "noop";
}

async function settleClosedUnmerged(
  db: Db,
  queue: Queue,
  worker: MediatorWorker,
  row: TrackedPr,
  check: PrCheck,
  verifier?: PrVerifier,
): Promise<"promoted" | "requeued" | "blocked" | "noop"> {
  const prLabel = `PR #${row.result_pr_number}`;
  const repo = row.repo;
  const headSha = check.headSha;
  const headRef = check.headRef;

  let reachable = false;
  let abandonedInPlace = false;
  let probeFailed = false;

  if (verifier && repo && headSha) {
    try {
      reachable = await verifier.isShaOnDefaultBranch(repo, headSha);
      if (!reachable) {
        // Same commits may already be on main under a different PR number
        // (merge commit) while this PR's branch tip still points at headSha.
        const associated = await verifier.associatedPulls(repo, headSha);
        if (
          associated.some(
            (p) => p.merged && p.number !== row.result_pr_number,
          )
        ) {
          reachable = true;
        } else if (headRef) {
          const tip = await verifier.headBranchTip(repo, headRef);
          abandonedInPlace = tip !== null && tip === headSha;
        } else {
          // No branch name → cannot prove abandon; treat as ambiguous.
          probeFailed = true;
        }
      }
    } catch (err) {
      // Rate-limit / 5xx / network: leave AWAITING_MERGE until budget expires.
      // Definitive errors (4xx other than handled 404s inside probes) block.
      if (isTransientGithubError(err)) {
        return handleMergeProbeFailure(queue, row, err, "merge-settle");
      }
      probeFailed = true;
    }
  } else {
    // Missing verifier/repo/sha: cannot prove abandon or merge-elsewhere.
    probeFailed = true;
  }

  if (reachable) {
    const promoted = await queue.promoteAwaitingMerge(row.id, {
      prVerification: "merged-green",
      prVerificationEtag: check.etag,
    });
    if (!promoted) return "noop";
    await queue.clearMergeProbeTransient(row.id);
    await new ProjectKnowledgeState(db).markEvent(
      row.project_id,
      [...COMPLETION_KNOWLEDGE_DOMAINS],
      `task #${row.id} completed (merged elsewhere)`,
    );
    await worker.findOrEnqueue(row.project_id, "reconcile", {
      taskId: row.id,
      agent: promoted.agent,
      prUrl: row.result_pr_url,
      prDescription: row.result_pr_description ?? "",
    });
    return "promoted";
  }

  if (abandonedInPlace && !probeFailed) {
    const requeued = await queue.requeueAwaitingMerge(row.id, {
      prVerification: "closed-unmerged",
      prVerificationEtag: check.etag,
      reason: `${prLabel} closed without merge; requeued for a new or reopened PR`,
    });
    if (requeued) await queue.clearMergeProbeTransient(row.id);
    return requeued ? "requeued" : "noop";
  }

  // Squash/stack ambiguous or definitive probe failure — human, not rework.
  const reason = probeFailed
    ? `${prLabel} closed without merge; could not verify whether commits landed under another PR`
    : `${prLabel} closed without merge; head not on default and branch tip moved/missing — may be squash-merged under another PR. Confirm DONE or release for rework.`;
  const blocked = await queue.flagMergedElsewhereAttention(row.id, {
    prVerification: "closed-unmerged",
    prVerificationEtag: check.etag,
    reason,
  });
  if (blocked) await queue.clearMergeProbeTransient(row.id);
  return blocked ? "blocked" : "noop";
}

/** Load AWAITING_MERGE rows, optionally filtered by repo and/or PR number. */
export async function listAwaitingMerge(
  db: Db,
  filter: { repo?: string; prNumber?: number } = {},
): Promise<TrackedPr[]> {
  const clauses = ["t.state = 'AWAITING_MERGE'", "t.result_pr_number IS NOT NULL"];
  const params: Array<string | number> = [];
  if (filter.repo) {
    clauses.push("COALESCE(t.repo, p.repo) = ?");
    params.push(filter.repo);
  }
  if (filter.prNumber != null) {
    clauses.push("t.result_pr_number = ?");
    params.push(filter.prNumber);
  }
  return db
    .prepare(
      `SELECT t.id, t.project_id, COALESCE(t.repo, p.repo) AS repo,
              t.result_pr_url, t.result_pr_number, t.result_pr_description,
              t.pr_verification, t.pr_verification_etag
       FROM tasks t JOIN projects p ON p.id = t.project_id
       WHERE ${clauses.join(" AND ")}`,
    )
    .all<TrackedPr>(...params);
}

/**
 * Backstop: re-checks AWAITING_MERGE tasks every 5 minutes. Primary delivery
 * is the GitHub App webhook; this heals missed/duplicated deliveries. Conditional
 * If-None-Match re-checks are rate-free on 304. Promotion to DONE fires reconcile once.
 */
export class PrMergePoller {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly db: Db,
    private readonly queue: Queue,
    private readonly worker: MediatorWorker,
    private readonly verifier: PrVerifier,
    private readonly intervalMs: number = PR_POLL_INTERVAL_MS,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    const rows = await listAwaitingMerge(this.db);
    for (const row of rows) {
      if (!row.repo) continue;
      let check: PrCheck;
      try {
        check = await this.verifier.check(row.repo, row.result_pr_number, row.pr_verification_etag);
      } catch (err) {
        // Bound silent retry: stay AWAITING_MERGE within budget, else Needs-You.
        await handleMergeProbeFailure(this.queue, row, err, "merge-poller");
        continue;
      }
      await settleAwaitingMerge(this.db, this.queue, this.worker, row, check, this.verifier);
      // Backstop CI-fix: open PR with failed checks → one child task (idempotent).
      if (check.state === "checks-failing") {
        const parents = await listTasksWithPr(this.db, {
          repo: row.repo,
          prNumber: row.result_pr_number,
        });
        for (const parent of parents) {
          await maybeFileCiFix(this.db, this.queue, parent, {
            conclusion: "failure",
            headSha: check.headSha ?? null,
          });
        }
      }
    }
  }
}

/** Parse owner/repo and PR number from a GitHub pull URL. */
export function parsePrUrl(prUrl: string): { ownerRepo: string; number: number } | null {
  const match = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/i.exec(prUrl);
  if (!match) return null;
  return { ownerRepo: match[1], number: Number(match[2]) };
}
