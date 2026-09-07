/**
 * Soft-delete archive: D0 archive → D30 hard purge via deleteProject cascade.
 * Live memberships / MCP / queue must never see archived projects.
 */

import type { Db } from "./db/driver.js";
import { deleteProject } from "./project-delete.js";

/** 30 days in ms. */
export const ARCHIVE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function isWithinArchiveWindow(archivedAt: number, nowMs = Date.now()): boolean {
  return nowMs - archivedAt < ARCHIVE_RETENTION_MS;
}

export async function softArchiveProject(
  db: Db,
  projectId: string,
  userId: string,
  nowMs = Date.now(),
): Promise<void> {
  const result = await db
    .prepare(
      `UPDATE projects SET archived_at = ?, archived_by = ?
        WHERE id = ? AND archived_at IS NULL`,
    )
    .run(nowMs, userId, projectId);
  if (result.changes !== 1) {
    throw new Error(`project ${projectId} not found or already archived`);
  }
}

export async function restoreProject(
  db: Db,
  projectId: string,
  nowMs = Date.now(),
): Promise<"ok" | "not_found" | "expired"> {
  const row = await db
    .prepare("SELECT archived_at FROM projects WHERE id = ?")
    .get<{ archived_at: number | null }>(projectId);
  if (!row || row.archived_at == null) return "not_found";
  if (!isWithinArchiveWindow(row.archived_at, nowMs)) return "expired";
  await db
    .prepare("UPDATE projects SET archived_at = NULL, archived_by = NULL WHERE id = ?")
    .run(projectId);
  return "ok";
}

export async function softArchiveOrg(
  db: Db,
  orgId: string,
  userId: string,
  nowMs = Date.now(),
): Promise<{ projectIds: string[] }> {
  const projectIds: string[] = [];
  await db.transaction(async () => {
    const org = await db
      .prepare("UPDATE orgs SET archived_at = ?, archived_by = ? WHERE id = ? AND archived_at IS NULL")
      .run(nowMs, userId, orgId);
    if (org.changes !== 1) throw new Error(`org ${orgId} not found or already archived`);
    const projects = await db
      .prepare("SELECT id FROM projects WHERE org_id = ? AND archived_at IS NULL")
      .all<{ id: string }>(orgId);
    for (const p of projects) {
      await softArchiveProject(db, p.id, userId, nowMs);
      projectIds.push(p.id);
    }
  });
  return { projectIds };
}

export async function restoreOrg(
  db: Db,
  orgId: string,
  nowMs = Date.now(),
): Promise<"ok" | "not_found" | "expired"> {
  const row = await db
    .prepare("SELECT archived_at FROM orgs WHERE id = ?")
    .get<{ archived_at: number | null }>(orgId);
  if (!row || row.archived_at == null) return "not_found";
  if (!isWithinArchiveWindow(row.archived_at, nowMs)) return "expired";
  await db.transaction(async () => {
    await db
      .prepare("UPDATE orgs SET archived_at = NULL, archived_by = NULL WHERE id = ?")
      .run(orgId);
    // Restore projects that were archived with the org (same or later archived_at window).
    const projects = await db
      .prepare("SELECT id, archived_at FROM projects WHERE org_id = ? AND archived_at IS NOT NULL")
      .all<{ id: string; archived_at: number }>(orgId);
    for (const p of projects) {
      if (isWithinArchiveWindow(p.archived_at, nowMs)) {
        await db
          .prepare("UPDATE projects SET archived_at = NULL, archived_by = NULL WHERE id = ?")
          .run(p.id);
      }
    }
  });
  return "ok";
}

/**
 * Hard-purge projects whose archive window has elapsed, then orgs with no live
 * projects left (or org itself past retention).
 */
export async function purgeExpiredArchives(
  db: Db,
  nowMs = Date.now(),
): Promise<{ purgedProjects: string[]; purgedOrgs: string[] }> {
  const cutoff = nowMs - ARCHIVE_RETENTION_MS;
  const projects = await db
    .prepare(
      `SELECT id FROM projects WHERE archived_at IS NOT NULL AND archived_at <= ?`,
    )
    .all<{ id: string }>(cutoff);
  const purgedProjects: string[] = [];
  for (const p of projects) {
    await deleteProject(db, p.id);
    purgedProjects.push(p.id);
  }
  const orgs = await db
    .prepare(
      `SELECT id FROM orgs WHERE archived_at IS NOT NULL AND archived_at <= ?`,
    )
    .all<{ id: string }>(cutoff);
  const purgedOrgs: string[] = [];
  for (const o of orgs) {
    const remaining = await db
      .prepare("SELECT COUNT(*) AS n FROM projects WHERE org_id = ?")
      .get<{ n: number }>(o.id);
    if ((remaining?.n ?? 0) > 0) continue;
    // Cascade-ish org cleanup: github install binding, then org row.
    await db.prepare("DELETE FROM github_installations WHERE org_id = ?").run(o.id);
    await db.prepare("DELETE FROM orgs WHERE id = ?").run(o.id);
    purgedOrgs.push(o.id);
  }
  return { purgedProjects, purgedOrgs };
}

export function startArchivePurgePoller(
  db: Db,
  opts?: { intervalMs?: number; now?: () => number },
): { stop: () => void } {
  const intervalMs = opts?.intervalMs ?? 15 * 60 * 1000;
  const now = opts?.now ?? (() => Date.now());
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const result = await purgeExpiredArchives(db, now());
      if (result.purgedProjects.length || result.purgedOrgs.length) {
        console.log(
          `[archive-purge] projects=${result.purgedProjects.join(",") || "none"} orgs=${result.purgedOrgs.join(",") || "none"}`,
        );
      }
    } catch (err) {
      console.error("[archive-purge] failed", err instanceof Error ? err.message : err);
    }
  };
  const handle = setInterval(() => void tick(), intervalMs);
  // Don't keep process alive solely for purge in tests.
  handle.unref?.();
  void tick();
  return {
    stop: () => {
      stopped = true;
      clearInterval(handle);
    },
  };
}
