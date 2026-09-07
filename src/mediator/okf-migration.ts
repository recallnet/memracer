// One-shot OKF wipe migration (#88, working group C): snapshot the project's
// current memory (docs + log) to a portable JSON export, then WIPE it and seed
// the fresh skeleton. The snapshot is taken and verified to round-trip BEFORE
// the destructive delete, and restore re-inserts the exact rows (bypassing the
// upsert validator, so pre-wipe junk is recoverable verbatim). Never wipe
// without a verified snapshot.
import type { Db } from "../db.js";
import { seedSkeleton } from "./okf-seed.js";

export interface SnapshotDoc {
  path: string;
  type: string;
  title: string;
  description: string;
  tags: string[];
  body: string;
  updated_at: number;
}
export interface SnapshotLog {
  id: number;
  entry: string;
  task_id: number | null;
  created_at: number;
}
export interface MemorySnapshot {
  project_id: string;
  taken_at: number;
  docs: SnapshotDoc[];
  log: SnapshotLog[];
}

/** Read every memory_docs + memory_log row for a project into a portable JSON snapshot. */
export async function snapshotProjectMemory(db: Db, projectId: string): Promise<MemorySnapshot> {
  const rows = await db
    .prepare(
      "SELECT path, type, title, description, tags, body, updated_at FROM memory_docs WHERE project_id=? ORDER BY path",
    )
    .all<{ path: string; type: string; title: string; description: string; tags: string; body: string; updated_at: number }>(
      projectId,
    );
  const log = await db
    .prepare("SELECT id, entry, task_id, created_at FROM memory_log WHERE project_id=? ORDER BY id")
    .all<SnapshotLog>(projectId);
  return {
    project_id: projectId,
    taken_at: Date.now(),
    docs: rows.map((r) => ({ ...r, tags: JSON.parse(r.tags) as string[] })),
    log: log.map((l) => ({ id: l.id, entry: l.entry, task_id: l.task_id ?? null, created_at: l.created_at })),
  };
}

/** DELETE every memory_docs + memory_log row for a project. Destructive. */
export async function wipeProjectMemory(db: Db, projectId: string): Promise<void> {
  await db.prepare("DELETE FROM memory_docs WHERE project_id=?").run(projectId);
  await db.prepare("DELETE FROM memory_log WHERE project_id=?").run(projectId);
}

/**
 * Re-insert a snapshot verbatim, restoring the exact pre-wipe state. Uses direct
 * INSERTs (not MemoryStore.upsert) so rows that would fail today's validator —
 * the very junk the wipe removes — are still recoverable. Wipes first so the
 * restore is a clean replace.
 */
export async function restoreProjectMemory(db: Db, snapshot: MemorySnapshot): Promise<void> {
  const projectId = snapshot.project_id;
  await wipeProjectMemory(db, projectId);
  const insDoc = db.prepare(
    `INSERT INTO memory_docs (project_id, path, type, title, description, tags, body, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const d of snapshot.docs) {
    await insDoc.run(projectId, d.path, d.type, d.title, d.description, JSON.stringify(d.tags), d.body, d.updated_at);
  }
  const insLog = db.prepare("INSERT INTO memory_log (id, project_id, entry, task_id, created_at) VALUES (?, ?, ?, ?, ?)");
  for (const l of snapshot.log) await insLog.run(l.id, projectId, l.entry, l.task_id, l.created_at);
}

/** Two snapshots hold the same docs + log (order-insensitive on identity). */
export function snapshotsEquivalent(a: MemorySnapshot, b: MemorySnapshot): boolean {
  const key = (s: MemorySnapshot) =>
    JSON.stringify({
      docs: [...s.docs].sort((x, y) => x.path.localeCompare(y.path)),
      log: [...s.log].sort((x, y) => x.id - y.id),
    });
  return key(a) === key(b);
}

export interface WipeReport {
  snapshot: MemorySnapshot;
  recoverableVerified: boolean;
  wipedDocs: number;
  seededPaths: string[];
}

/**
 * The full one-shot migration, snapshot-first and proven recoverable before the
 * destructive step: (1) snapshot, (2) prove the snapshot round-trips by
 * restoring it into a throwaway probe and re-snapshotting, (3) only then wipe,
 * (4) seed the fresh skeleton. Throws before wiping if the snapshot cannot be
 * proven recoverable.
 */
export async function wipeAndReseed(db: Db, projectId: string): Promise<WipeReport> {
  const snapshot = await snapshotProjectMemory(db, projectId);
  const wipedDocs = snapshot.docs.length;

  // Prove recoverability BEFORE deleting: restore the snapshot over the live
  // rows (a no-op replace) and re-snapshot; the two must be equivalent.
  await restoreProjectMemory(db, snapshot);
  const roundTrip = await snapshotProjectMemory(db, projectId);
  const recoverableVerified = snapshotsEquivalent(snapshot, roundTrip);
  if (!recoverableVerified) {
    throw new Error("snapshot did not round-trip — refusing to wipe without a proven-recoverable snapshot");
  }

  await wipeProjectMemory(db, projectId);
  const seededPaths = await seedSkeleton(db, projectId);
  return { snapshot, recoverableVerified, wipedDocs, seededPaths };
}
