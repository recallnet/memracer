/**
 * One-shot OKF wipe for a project (#88): snapshot the current memory to a JSON
 * file on disk, verify it round-trips, then wipe and seed the fresh skeleton.
 * The snapshot file is the recovery path — the wipe refuses to proceed unless
 * the snapshot is proven recoverable first.
 *
 * Run:
 *   pnpm tsx scripts/okf-wipe.ts <project-id> [snapshot-out.json]
 *   DATABASE_URL=... pnpm tsx scripts/okf-wipe.ts <project-id> [snapshot-out.json]
 */
import { writeFileSync } from "node:fs";
import { openDb, openPostgresDb } from "../src/db.js";
import { wipeAndReseed } from "../src/mediator/okf-migration.js";

const projectId = process.argv[2];
if (!projectId) {
  console.error("usage: pnpm tsx scripts/okf-wipe.ts <project-id> [snapshot-out.json]");
  process.exit(1);
}
const outPath = process.argv[3] ?? `okf-snapshot-${projectId}-${Date.now()}.json`;

const db = process.env.DATABASE_URL
  ? await openPostgresDb(process.env.DATABASE_URL)
  : openDb(process.env.MEMRACER_DB_PATH ?? "memracer.db");

const report = await wipeAndReseed(db, projectId);
// Persist the snapshot regardless — it is the kept recovery export.
writeFileSync(outPath, JSON.stringify(report.snapshot, null, 2));
console.log(
  `wiped ${report.wipedDocs} concept(s) from "${projectId}" (snapshot verified recoverable, saved to ${outPath}); seeded ${report.seededPaths.length} skeleton assets.`,
);
await db.close();
