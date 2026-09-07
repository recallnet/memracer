/**
 * Snapshot-first project-memory consolidation. Dry-run is the default.
 *
 * Usage:
 *   pnpm okf:consolidate <project-id> <spec-or-plan.json>
 *   pnpm okf:consolidate <project-id> <reviewed-plan.json> --apply --writers-stopped --snapshot-out /durable/path.json
 *   pnpm okf:consolidate <project-id> <snapshot.json> --restore --writers-stopped --snapshot-out /durable/pre-restore.json
 *     [--plan-out /safe/path.json]
 *
 * `--writers-stopped` is an explicit operator assertion: applying while the
 * live server can write memory is not supported. Recovery artifacts default
 * to the OS temp directory so they cannot be committed with the repository.
 */
import { closeSync, fsyncSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openDb, openPostgresDb } from "../src/db.js";
import {
  executeProjectMemoryConsolidation,
  parseRecoverySnapshot,
  planProjectMemoryConsolidation,
  serializeRecoverySnapshot,
  type ConsolidationSpec,
  type ProjectMemoryConsolidationPlan,
} from "../src/mediator/okf-consolidation.js";
import { parseConsolidationCliArgs } from "../src/mediator/okf-consolidation-cli.js";
import {
  restoreProjectMemory,
  snapshotProjectMemory,
  snapshotsEquivalent,
} from "../src/mediator/okf-migration.js";

function usage(): never {
  console.error(
    "usage: pnpm okf:consolidate <project-id> <spec-or-plan.json> " +
    "[--apply --writers-stopped --snapshot-out PATH] [--plan-out PATH]; " +
    "or <project-id> <snapshot.json> --restore --writers-stopped --snapshot-out PRE_RESTORE_PATH",
  );
  process.exit(1);
}

function durableWriteExclusive(path: string, contents: string): void {
  writeFileSync(path, contents, { mode: 0o600, flag: "wx" });
  const file = openSync(path, "r");
  try { fsyncSync(file); } finally { closeSync(file); }
  const parent = openSync(dirname(path), "r");
  try { fsyncSync(parent); } finally { closeSync(parent); }
}

function redactedDatabaseTarget(): string {
  if (process.env.DATABASE_URL) {
    const parsed = new URL(process.env.DATABASE_URL);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  }
  return process.env.MEMRACER_DB_PATH ?? "memracer.db (default; dry-run only)";
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) usage();
  return value;
}

let parsedArgs: ReturnType<typeof parseConsolidationCliArgs>;
try {
  parsedArgs = parseConsolidationCliArgs(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  usage();
}
const { projectId, inputPath, apply, restore } = parsedArgs;
const args = process.argv.slice(3);
const flags = args;
if ((apply || restore) && !parsedArgs.writersStopped) {
  throw new Error("refusing mutation without --writers-stopped; stop/drain server memory writers first");
}
const explicitSnapshotPath = option(flags, "--snapshot-out");
if ((apply || restore) && !explicitSnapshotPath) {
  throw new Error(`${restore ? "--restore" : "--apply"} requires an explicit durable --snapshot-out path`);
}
if ((apply || restore) && !process.env.DATABASE_URL && !process.env.MEMRACER_DB_PATH) {
  throw new Error("mutation requires an explicit DATABASE_URL or MEMRACER_DB_PATH; refusing to default to ./memracer.db");
}

const inputText = inputPath ? readFileSync(inputPath, "utf8") : undefined;
const db = process.env.DATABASE_URL
  ? await openPostgresDb(process.env.DATABASE_URL)
  : openDb(process.env.MEMRACER_DB_PATH ?? "memracer.db");

try {
  console.error(`[okf:consolidate] dialect=${db.dialect} database=${redactedDatabaseTarget()}`);
  if (restore) {
    const snapshot = parseRecoverySnapshot(inputText!);
    if (snapshot.project_id !== projectId) throw new Error(`snapshot belongs to ${snapshot.project_id}, not ${projectId}`);
    const beforeRestore = await snapshotProjectMemory(db, projectId);
    durableWriteExclusive(explicitSnapshotPath!, serializeRecoverySnapshot(beforeRestore));
    const diskBeforeRestore = parseRecoverySnapshot(readFileSync(explicitSnapshotPath!, "utf8"));
    if (!snapshotsEquivalent(beforeRestore, diskBeforeRestore)) {
      throw new Error(`pre-restore snapshot at ${explicitSnapshotPath} did not round-trip; refusing restore`);
    }
    const restored = await db.transaction(async () => {
      if (db.dialect === "postgres") await db.exec("LOCK TABLE memory_docs, memory_log IN EXCLUSIVE MODE");
      const lockedBeforeRestore = await snapshotProjectMemory(db, projectId);
      if (!snapshotsEquivalent(diskBeforeRestore, lockedBeforeRestore)) {
        throw new Error("memory changed after the pre-restore snapshot was persisted; refusing restore");
      }
      await restoreProjectMemory(db, snapshot);
      const verified = await snapshotProjectMemory(db, projectId);
      if (!snapshotsEquivalent(snapshot, verified)) throw new Error("restored memory does not match the recovery snapshot");
      return verified;
    });
    console.log(JSON.stringify({
      status: "restored",
      projectId,
      concepts: restored.docs.length,
      preRestoreSnapshotPath: explicitSnapshotPath,
      next: "restart the server, validate the whole bundle, and verify dashboard memory reads",
    }, null, 2));
    process.exitCode = 0;
  } else {
  const parsed = inputText ? JSON.parse(inputText) as ConsolidationSpec | ProjectMemoryConsolidationPlan : undefined;
  const isSavedPlan = Boolean(parsed && "version" in parsed && parsed.version === 1 && "candidateDocs" in parsed);
  if (apply && !isSavedPlan) {
    throw new Error("--apply requires an explicit reviewed v1 plan file; generate and review a dry-run plan first");
  }
  const plan = isSavedPlan
    ? parsed as ProjectMemoryConsolidationPlan
    : await planProjectMemoryConsolidation(db, { ...parsed as ConsolidationSpec, projectId });
  if (plan.projectId !== projectId) {
    throw new Error(`plan belongs to ${plan.projectId}, not requested project ${projectId}`);
  }

  const suffix = `${projectId}-${plan.sourceWatermark.slice(0, 12)}-${Date.now()}`;
  const snapshotPath = explicitSnapshotPath
    ?? join(tmpdir(), `memracer-okf-consolidation-snapshot-${suffix}.json`);
  const planPath = option(flags, "--plan-out")
    ?? join(tmpdir(), `memracer-okf-consolidation-plan-${suffix}.json`);

  // Apply snapshots are captured after writers stop and immediately before
  // mutation, so log rows written since planning remain recoverable.
  const recoverySnapshot = apply ? await snapshotProjectMemory(db, projectId) : plan.snapshot;
  durableWriteExclusive(snapshotPath, serializeRecoverySnapshot(recoverySnapshot));
  const diskSnapshot = parseRecoverySnapshot(readFileSync(snapshotPath, "utf8"));
  if (!snapshotsEquivalent(recoverySnapshot, diskSnapshot)) {
    throw new Error(`snapshot at ${snapshotPath} did not round-trip; refusing consolidation`);
  }
  durableWriteExclusive(planPath, `${JSON.stringify(plan, null, 2)}\n`);

  const result = await executeProjectMemoryConsolidation(db, plan, {
    apply,
    recoverySnapshot: apply ? diskSnapshot : undefined,
  });
  console.log(JSON.stringify({
    ...result,
    snapshot: undefined,
    snapshotPath,
    planPath,
    writersStopped: apply,
    next: apply ? "restart the server, validate the bundle, and verify dashboard memory reads" : "review the saved plan; stop/drain writers before --apply",
    restoreCommand: apply
      ? `pnpm okf:consolidate ${JSON.stringify(projectId)} ${JSON.stringify(snapshotPath)} --restore --writers-stopped --snapshot-out /durable/path/pre-restore.json`
      : undefined,
    retention: "Keep the 0600 snapshot outside the repository until post-restart validation and dashboard verification pass; never commit it.",
  }, null, 2));
  }
} finally {
  await db.close();
}
