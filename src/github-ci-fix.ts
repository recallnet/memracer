/**
 * Deterministic CI-fix child tasks for open PRs whose required checks failed.
 * Primary trigger: check_suite.completed (failure-class conclusion) webhook.
 * Backstop: PrMergePoller when it observes checks-failing.
 * Zero mediator tokens — born QUEUED, no groom. Never gates coder_complete.
 */
import type { Db } from "./db.js";
import type { Queue } from "./queue.js";
import type { PrCheck, PrVerifier } from "./github-pr.js";

/** Body marker used for idempotency lookups. */
export function ciFixMarker(prNumber: number): string {
  return `[ci-fix:pr-${prNumber}]`;
}

/** Conclusions that represent a real required-check failure (not informational). */
const FAILING_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
]);

export function isFailingConclusion(conclusion: string | null | undefined): boolean {
  return conclusion != null && FAILING_CONCLUSIONS.has(conclusion);
}

export interface ParentForCiFix {
  id: number;
  project_id: string;
  title: string;
  state: string;
  result_pr_url: string;
  result_pr_number: number;
  repo: string | null;
}

/** Tasks that completed with a PR number matching repo+PR (AWAITING_MERGE or DONE). */
export async function listTasksWithPr(
  db: Db,
  filter: { repo: string; prNumber: number },
): Promise<ParentForCiFix[]> {
  return db
    .prepare(
      `SELECT t.id, t.project_id, t.title, t.state,
              t.result_pr_url, t.result_pr_number,
              COALESCE(t.repo, p.repo) AS repo
       FROM tasks t JOIN projects p ON p.id = t.project_id
       WHERE t.result_pr_number = ?
         AND COALESCE(t.repo, p.repo) = ?
         AND t.result_pr_url IS NOT NULL
         AND t.state IN ('AWAITING_MERGE', 'DONE')`,
    )
    .all<ParentForCiFix>(filter.prNumber, filter.repo);
}

/** True when a non-terminal CI-fix child already exists for this PR. */
export async function hasOpenCiFixChild(
  db: Db,
  parentId: number,
  prNumber: number,
): Promise<boolean> {
  const marker = ciFixMarker(prNumber);
  const row = await db
    .prepare(
      `SELECT id FROM tasks
       WHERE parent_id = ?
         AND state <> 'DONE'
         AND (ci_fix_key = ? OR (ci_fix_key IS NULL AND body LIKE ?))
       LIMIT 1`,
    )
    .get<{ id: number }>(parentId, marker, `%${marker}%`);
  return row != null;
}

export type CiFixResult =
  | { filed: true; taskId: number }
  | { filed: false; reason: string };

/** Postgres 23505 / SQLite SQLITE_CONSTRAINT_UNIQUE — benign open-child race. */
export function isUniqueConstraintError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string | number; message?: string };
  if (e.code === "23505") return true; // Postgres unique_violation
  if (e.code === "SQLITE_CONSTRAINT_UNIQUE") return true;
  // better-sqlite3 sometimes surfaces the generic constraint code with a UNIQUE message.
  if (e.code === "SQLITE_CONSTRAINT" && typeof e.message === "string" && /unique/i.test(e.message)) {
    return true;
  }
  return false;
}

/**
 * File one CI-fix child if none is already open. Caller must already know the
 * PR is open and checks are failing — this function only does DB work.
 *
 * Atomic vs concurrent webhooks: the partial unique index
 * `idx_tasks_open_ci_fix` on (parent_id, ci_fix_key) WHERE state <> 'DONE'
 * rejects the losing INSERT under Postgres READ COMMITTED. The pre-check is a
 * cheap fast path; unique-violation is caught and returned as filed:false.
 */
export async function maybeFileCiFix(
  db: Db,
  queue: Queue,
  parent: ParentForCiFix,
  opts: { conclusion?: string | null; headSha?: string | null } = {},
): Promise<CiFixResult> {
  const prNumber = parent.result_pr_number;
  const marker = ciFixMarker(prNumber);
  if (await hasOpenCiFixChild(db, parent.id, prNumber)) {
    return { filed: false, reason: "ci-fix already open" };
  }

  const conclusion = opts.conclusion ?? "failure";
  const headLine = opts.headSha ? `\nHead SHA: \`${opts.headSha}\`.` : "";
  const title = `CI fix: PR #${prNumber} failed checks — ${parent.title}`.slice(0, 200);
  const body = [
    `${marker}`,
    ``,
    `Required checks failed on the open PR for parent task #${parent.id}.`,
    ``,
    `- Parent: #${parent.id} (${parent.title})`,
    `- PR: ${parent.result_pr_url}`,
    `- Conclusion: ${conclusion}${headLine}`,
    ``,
    `Fix the failing CI on that PR (push to the same branch), keep the PR open,`,
    `and complete this task with the same PR URL once checks are green.`,
    `Do not open a second PR unless the original is unrecoverable.`,
  ].join("\n");

  try {
    const taskId = await queue.submit(parent.project_id, "system", {
      title,
      body,
      priority: 1,
      parentId: parent.id,
      repo: parent.repo ?? undefined,
      ciFixKey: marker,
      evidence: [
        {
          kind: "code",
          path: parent.result_pr_url,
          note: `Failing PR #${prNumber} for parent task #${parent.id}`,
        },
        {
          kind: "research",
          note: `Auto-filed from check_suite conclusion=${conclusion}; zero-mediator path.`,
        },
      ],
    });
    return { filed: true, taskId };
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return { filed: false, reason: "ci-fix already open" };
    }
    throw err;
  }
}

/**
 * For a failed check suite: re-verify each matching PR and file CI-fix when
 * the PR is still open and checks are failing. Merged PRs are skipped (DONE
 * promotion is independent).
 */
export async function fileCiFixesForFailedSuite(
  db: Db,
  queue: Queue,
  verifier: PrVerifier,
  opts: {
    repo: string;
    prNumbers: number[];
    conclusion: string | null | undefined;
    headSha?: string | null;
  },
): Promise<CiFixResult[]> {
  if (!isFailingConclusion(opts.conclusion)) return [];

  const numbers =
    opts.prNumbers.length > 0
      ? opts.prNumbers
      : (
          await db
            .prepare(
              `SELECT DISTINCT t.result_pr_number AS n
               FROM tasks t JOIN projects p ON p.id = t.project_id
               WHERE COALESCE(t.repo, p.repo) = ?
                 AND t.result_pr_number IS NOT NULL
                 AND t.state IN ('AWAITING_MERGE', 'DONE')`,
            )
            .all<{ n: number }>(opts.repo)
        ).map((r) => r.n);

  const results: CiFixResult[] = [];
  for (const prNumber of numbers) {
    const parents = await listTasksWithPr(db, { repo: opts.repo, prNumber });
    if (parents.length === 0) continue;

    let check: PrCheck;
    try {
      check = await verifier.check(opts.repo, prNumber);
    } catch {
      results.push({ filed: false, reason: "verifier error" });
      continue;
    }
    // Only open PRs with failing checks — never file for merged/closed.
    if (check.state !== "checks-failing") {
      results.push({
        filed: false,
        reason: `pr not open-failing (${check.state})`,
      });
      continue;
    }
    for (const parent of parents) {
      results.push(
        await maybeFileCiFix(db, queue, parent, {
          conclusion: opts.conclusion,
          headSha: opts.headSha ?? check.headSha ?? null,
        }),
      );
    }
  }
  return results;
}
