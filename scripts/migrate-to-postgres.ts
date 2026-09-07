// Copy a memracer SQLite database into a hosted Postgres instance.
//
// Usage:
//   DATABASE_URL=postgres://... pnpm exec tsx scripts/migrate-to-postgres.ts [sqlite-path]
//
// The target database must be empty (fresh schema is created if missing).
// Run with the server stopped — see docs/postgres-migration.md for the full
// runbook. Ids are preserved verbatim; identity sequences are advanced past
// the copied maximum afterwards. Both the memracer tables and the better-auth
// tables (users, org memberships, coder API keys) are copied.
import { openDb, openPostgresDb, TABLES_IN_INSERT_ORDER } from "../src/db.js";
import { initAuth } from "../src/auth/instance.js";

const sqlitePath = process.argv[2] ?? process.env.MEMRACER_DB_PATH ?? "memracer.db";
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required (the target Postgres instance)");
  process.exit(1);
}

/** Tables whose id is an identity column needing a sequence reset. */
const IDENTITY_TABLES = [
  "tasks",
  "evidence",
  "attempts",
  "jobs",
  "threads",
  "thread_messages",
  "decision_log",
  "questions",
  "memory_log",
  "task_notes",
  "steers",
] as const;

/**
 * better-auth tables, in FK-safe insert order (parents before children):
 * account/session/apikey reference user; member/invitation reference user and
 * organization. All use text ids, so no identity-sequence reset is needed.
 * Copied alongside the memracer tables so members, org memberships, and coder
 * API keys survive the cutover.
 */
const AUTH_TABLES_IN_INSERT_ORDER = [
  "user",
  "organization",
  "verification",
  "account",
  "session",
  "apikey",
  "member",
  "invitation",
] as const;

const sqlite = openDb(sqlitePath);
const pg = await openPostgresDb(url);

// Ensure the better-auth tables exist on the target. Idempotent: a no-op when
// the server has already booted against this database (the auth tables are
// already present), and creates them when migrating into a fresh Postgres.
const authHandle = initAuth(pg);
if (authHandle) await authHandle.ready;

const existing = await pg
  .prepare('SELECT COUNT(*) AS n FROM tasks')
  .get<{ n: number }>();
if ((existing?.n ?? 0) > 0) {
  console.error(`target already has ${existing!.n} tasks — refusing to migrate into a non-empty database`);
  process.exit(1);
}

/**
 * Postgres text/jsonb columns cannot contain a NUL byte (0x00); SQLite stores
 * it happily (model output occasionally embeds one). Strip NUL from string
 * values so the copy doesn't abort with
 * `invalid byte sequence for encoding "UTF8": 0x00`. Non-strings pass through.
 */
function sanitize(v: unknown): string | number | null {
  return typeof v === "string" && v.includes("\u0000")
    ? v.replace(/\u0000/g, "")
    : (v as string | number | null);
}

// Quote identifiers: `user` is a Postgres reserved word and the better-auth
// columns are camelCase (userId, organizationId, createdAt) — both must be
// quoted or Postgres folds/rejects them. Memracer's lowercase names are
// unaffected by quoting.
async function copyTable(table: string): Promise<void> {
  const rows = await sqlite.prepare(`SELECT * FROM "${table}"`).all<Record<string, unknown>>();
  if (rows.length === 0) {
    console.log(`${table}: 0 rows`);
    return;
  }
  const cols = Object.keys(rows[0]);
  const colList = cols.map((c) => `"${c}"`).join(", ");
  // Batched multi-row inserts: ~18k single-row round trips over the public
  // proxy stalls/hangs the long transaction. 200 rows/statement keeps the whole
  // copy to a few hundred round trips (finishing in seconds) and stays well
  // under Postgres's 65535-parameter-per-statement limit (200 * ~30 cols).
  const BATCH = 200;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const tuples = chunk.map(() => `(${cols.map(() => "?").join(", ")})`).join(", ");
    const params: (string | number | null)[] = [];
    for (const row of chunk) for (const c of cols) params.push(sanitize(row[c]));
    await pg.prepare(`INSERT INTO "${table}" (${colList}) VALUES ${tuples}`).run(...params);
  }
  console.log(`${table}: ${rows.length} rows`);
}

const ALL_TABLES = [...AUTH_TABLES_IN_INSERT_ORDER, ...TABLES_IN_INSERT_ORDER];

await pg.transaction(async () => {
  // tasks are inserted before their root threads; the FK checks at COMMIT.
  await pg.exec("SET CONSTRAINTS tasks_root_thread_id_fkey DEFERRED");
  for (const table of ALL_TABLES) {
    await copyTable(table);
  }
});

for (const table of IDENTITY_TABLES) {
  await pg
    .prepare(
      `SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM ${table}`,
    )
    .get();
}

// Verification: row counts must match on every table.
let mismatches = 0;
for (const table of ALL_TABLES) {
  const a = (await sqlite.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get<{ n: number }>())!.n;
  const b = (await pg.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get<{ n: number }>())!.n;
  if (a !== b) {
    console.error(`MISMATCH ${table}: sqlite=${a} postgres=${b}`);
    mismatches++;
  }
}
await sqlite.close();
await pg.close();
if (mismatches > 0) process.exit(1);
console.log("migration complete — row counts verified");
