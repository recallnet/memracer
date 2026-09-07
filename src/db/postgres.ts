import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";
import type { Db, RunResult, SqlValue, Statement } from "./driver.js";
import { renderSchema } from "./schema.js";

/**
 * Minimal client surface the Postgres driver needs. Implemented by
 * node-postgres (production, via openPostgresDb) and by the PGlite test
 * adapter — same driver code exercises both.
 */
export interface PgClientLike {
  /** Single parameterized statement. */
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  /** Multi-statement batch, no parameters (DDL). */
  exec(sql: string): Promise<void>;
}

export interface PgConnectionLike extends PgClientLike {
  release(): void;
}

export interface PgPoolLike extends PgClientLike {
  /** Checkout a dedicated connection (transactions). */
  connect(): Promise<PgConnectionLike>;
  end(): Promise<void>;
}

/**
 * Rewrite `?` placeholders to Postgres `$n`, skipping string literals
 * (including '' escapes), quoted identifiers, and -- line comments. All
 * application SQL is written once with `?`; this runs once per prepare.
 */
export function toPgPlaceholders(sql: string): string {
  let out = "";
  let n = 0;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      out += ch;
      i++;
      for (; i < sql.length; i++) {
        out += sql[i];
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            out += sql[++i]; // doubled quote: escaped, stay in the literal
          } else {
            break;
          }
        }
      }
    } else if (ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      out += end === -1 ? sql.slice(i) : sql.slice(i, end);
      i = end === -1 ? sql.length : end - 1;
    } else if (ch === "?") {
      out += `$${++n}`;
    } else {
      out += ch;
    }
  }
  return out;
}

/** int8 aggregates/ids must reach JS as numbers, never BigInt/string. */
function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  for (const key of Object.keys(row)) {
    const v = row[key];
    if (typeof v === "bigint") row[key] = Number(v);
  }
  return row;
}

/**
 * The Postgres backend. Plain statements run on the pool; transaction()
 * checks out a dedicated connection and routes every statement issued inside
 * the callback to it via AsyncLocalStorage — same seam semantics as SQLite.
 */
export class PostgresDb implements Db {
  readonly dialect = "postgres" as const;
  private readonly txClient = new AsyncLocalStorage<PgClientLike>();

  /**
   * `authPool` is the native node-postgres Pool better-auth's Kysely adapter
   * drives. Present only for production Postgres (openPostgresDb); the PGlite
   * test adapter passes none, so better-auth is disabled under PGlite (its
   * adapter cannot drive PGlite's PgPoolLike). Application SQL always flows
   * through `pool`.
   */
  constructor(private readonly pool: PgPoolLike, private readonly authPool?: unknown) {}

  /** Create the schema (idempotent) and return the ready driver. */
  static async open(pool: PgPoolLike, authPool?: unknown): Promise<PostgresDb> {
    const db = new PostgresDb(pool, authPool);
    await db.exec(renderSchema("postgres"));
    return db;
  }

  /** The native pg Pool for better-auth, or null under PGlite. */
  authDatabase(): unknown {
    return this.authPool ?? null;
  }

  private client(): PgClientLike {
    return this.txClient.getStore() ?? this.pool;
  }

  prepare(sql: string): Statement {
    const pgSql = toPgPlaceholders(sql);
    const all = async <T>(...params: SqlValue[]): Promise<T[]> => {
      const res = await this.client().query(pgSql, params);
      return res.rows.map(normalizeRow) as T[];
    };
    return {
      all,
      get: async <T>(...params: SqlValue[]) => (await all<T>(...params))[0],
      run: async (...params: SqlValue[]): Promise<RunResult> => {
        const res = await this.client().query(pgSql, params);
        return { changes: res.rowCount ?? 0 };
      },
    };
  }

  exec(sql: string): Promise<void> {
    return this.client().exec(sql);
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.txClient.getStore()) return fn(); // nested: flatten into the enclosing transaction
    const conn = await this.pool.connect();
    try {
      await conn.query("BEGIN");
      const result = await this.txClient.run(conn, fn);
      await conn.query("COMMIT");
      return result;
    } catch (err) {
      await conn.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      conn.release();
    }
  }

  isInTransaction(): boolean {
    return this.txClient.getStore() != null;
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}

const INT8_OID = 20;

/**
 * Production entry point: node-postgres pool over DATABASE_URL. int8 (ids,
 * COUNT(*), ms timestamps stored as BIGINT) parses to Number — every value
 * this schema stores is far below 2^53.
 */
export async function openPostgresDb(connectionString: string): Promise<PostgresDb> {
  const pool = new pg.Pool({
    connectionString,
    keepAlive: true,
    keepAliveInitialDelayMillis: 5000,
    connectionTimeoutMillis: 30000,
    statement_timeout: 120000,
    idle_in_transaction_session_timeout: 120000,
    types: {
      getTypeParser: ((oid: number, format?: unknown) =>
        oid === INT8_OID
          ? (value: string) => Number(value)
          : (pg.types.getTypeParser as (oid: number, format?: unknown) => unknown)(
              oid,
              format,
            )) as typeof pg.types.getTypeParser,
    },
  });
  const poolLike: PgPoolLike = {
    query: async (sql, params) => {
      const res = await pool.query(sql, params);
      return { rows: res.rows as Record<string, unknown>[], rowCount: res.rowCount };
    },
    exec: async (sql) => {
      await pool.query(sql);
    },
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async (sql, params) => {
          const res = await client.query(sql, params);
          return { rows: res.rows as Record<string, unknown>[], rowCount: res.rowCount };
        },
        exec: async (sql) => {
          await client.query(sql);
        },
        release: () => client.release(),
      };
    },
    end: () => pool.end(),
  };
  // The native pg Pool is handed to better-auth's Kysely adapter as-is; the
  // seam keeps using the PgPoolLike wrapper for application SQL.
  return PostgresDb.open(poolLike, pool);
}
