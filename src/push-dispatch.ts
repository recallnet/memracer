/**
 * Post-commit fan-out of current pushable attention for a project.
 *
 * Never run un-awaited DB work, and never run push queries inside an ambient
 * transaction: a failed best-effort statement would abort the caller's
 * Postgres transaction (PGlite / pool). When called mid-transaction, work is
 * deferred into an AsyncLocalStorage scope until `runWithDeferredPushes`
 * (or `flushProjectAttentionPushes`) drains that scope after commit.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { AttentionAlertService } from "./attention-alerts.js";
import type { Db } from "./db.js";
import { listHumanAttention } from "./human-attention.js";
import { notifyProjectHumans, prunePushDeliveryLog } from "./web-push.js";

type PendingPush = { projectId: string; publicUrl?: string };

/** Request/transaction-scoped deferred jobs — never shared across concurrent requests. */
const deferredScope = new AsyncLocalStorage<PendingPush[]>();

async function runProjectAttentionPush(
  db: Db,
  projectId: string,
  publicUrl?: string,
): Promise<void> {
  try {
    // Periodic retention: age-out delivery dedup rows while sweeping attention.
    await prunePushDeliveryLog(db);
    const attention = new AttentionAlertService(db, publicUrl ?? process.env.MEMRACER_PUBLIC_URL);
    const nameRow = await db.prepare("SELECT name FROM projects WHERE id = ?").get<{ name: string }>(projectId);
    const items = await listHumanAttention(db, attention, {
      projectIds: [projectId],
      projectNames: new Map([[projectId, nameRow?.name ?? projectId]]),
      publicUrl: publicUrl ?? process.env.MEMRACER_PUBLIC_URL,
      includeLeases: false,
      includeBlocked: true,
    });
    await notifyProjectHumans(db, projectId, items);
  } catch (err) {
    // best-effort only — log so genuine defects are visible without aborting callers
    console.error(
      `[push-dispatch-failure] ${JSON.stringify({
        project_id: projectId,
        error: err instanceof Error ? err.message : String(err),
      })}`,
    );
  }
}

async function drainPending(db: Db, pending: PendingPush[]): Promise<void> {
  if (pending.length === 0) return;
  const jobs = pending.splice(0, pending.length);
  const seen = new Set<string>();
  for (const job of jobs) {
    if (seen.has(job.projectId)) continue;
    seen.add(job.projectId);
    await runProjectAttentionPush(db, job.projectId, job.publicUrl);
  }
}

/**
 * Run `fn` with a private deferred-push bag, then drain only that bag.
 * Wrap mid-transaction work that calls `scheduleProjectAttentionPush` so a
 * concurrent request cannot flush another request's pre-commit jobs.
 */
export async function runWithDeferredPushes<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  const pending: PendingPush[] = [];
  try {
    const result = await deferredScope.run(pending, fn);
    // Only fan out after a successful commit path; drop jobs if fn throws/rolls back.
    await drainPending(db, pending);
    return result;
  } catch (err) {
    pending.length = 0;
    throw err;
  }
}

/**
 * Schedule attention push for a project. When the caller is inside a
 * transaction, queues into the current ALS deferred scope (must be established
 * via `runWithDeferredPushes`). Outside a transaction, runs immediately.
 */
export async function scheduleProjectAttentionPush(
  db: Db,
  projectId: string,
  publicUrl?: string,
): Promise<void> {
  if (db.isInTransaction()) {
    const pending = deferredScope.getStore();
    if (!pending) {
      throw new Error(
        "scheduleProjectAttentionPush mid-transaction without deferred scope; wrap with runWithDeferredPushes",
      );
    }
    pending.push({ projectId, publicUrl });
    return;
  }
  await runProjectAttentionPush(db, projectId, publicUrl);
}

/**
 * Drain deferred pushes for the current ALS scope only. Prefer
 * `runWithDeferredPushes` at call sites; this remains for tests and callers
 * that already established a scope.
 */
export async function flushProjectAttentionPushes(db: Db): Promise<void> {
  const pending = deferredScope.getStore();
  if (!pending) return;
  await drainPending(db, pending);
}

/** Test helper: inspect whether a deferred scope is active. */
export function deferredPushScopeActive(): boolean {
  return deferredScope.getStore() != null;
}
