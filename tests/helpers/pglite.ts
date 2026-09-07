// PGlite (real Postgres compiled to WASM, in-process) behind the PgPoolLike
// adapter, so tests and CI exercise the PostgresDb dialect path without a
// server. One PGlite instance per worker; each openPgliteDb() resets the
// public schema for isolation — booting a fresh WASM Postgres per test would
// dominate suite time.
import { PGlite } from "@electric-sql/pglite";
import { PostgresDb, type PgConnectionLike, type PgPoolLike } from "../../src/db/postgres.js";

let shared: PGlite | undefined;

// ONE mutex for the whole worker, module-global on purpose: every PostgresDb
// a test opens sits over the same single PGlite session, so adapters must
// serialize against each other too. Per-adapter locks let a lingering
// worker's open BEGIN interleave with the next test's statements on the
// shared session — one failed statement then aborts a foreign transaction
// ("current transaction is aborted"), observed as cross-test flake.
let lock: Promise<void> = Promise.resolve();
const acquire = async (): Promise<() => void> => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const prev = lock;
  lock = prev.then(() => gate);
  await prev;
  return release;
};

/**
 * PGlite is a single session; emulate a pool with the shared mutex.
 * connect() holds it for the whole checkout, so a transaction's
 * BEGIN..COMMIT can never interleave with outside statements — matching
 * real-pool semantics closely enough for this schema's short transactions.
 */
function poolOver(lite: PGlite): PgPoolLike {
  const rawQuery = async (sql: string, params?: unknown[]) => {
    const res = await lite.query(sql, params);
    return {
      rows: res.rows as Record<string, unknown>[],
      rowCount: res.affectedRows ?? res.rows.length,
    };
  };
  return {
    query: async (sql, params) => {
      const release = await acquire();
      try {
        return await rawQuery(sql, params);
      } finally {
        release();
      }
    },
    exec: async (sql) => {
      const release = await acquire();
      try {
        await lite.exec(sql);
      } finally {
        release();
      }
    },
    connect: async (): Promise<PgConnectionLike> => {
      const release = await acquire();
      return {
        query: rawQuery,
        exec: async (sql) => {
          await lite.exec(sql);
        },
        release,
      };
    },
    // The instance is shared across tests in this worker — never shut it down.
    end: async () => undefined,
  };
}

export async function openPgliteDb(): Promise<PostgresDb> {
  shared ??= new PGlite();
  await shared.waitReady;
  const release = await acquire();
  try {
    await shared.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  } finally {
    release();
  }
  return PostgresDb.open(poolOver(shared));
}
