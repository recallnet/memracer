/**
 * The database seam. Every backend (better-sqlite3 today, node-postgres /
 * PGlite for hosted deployments) implements this async surface; all
 * application SQL is written once with `?` placeholders and dialect-neutral
 * constructs (RETURNING, ON CONFLICT ... DO UPDATE, COALESCE, CHECK).
 */

export type SqlValue = string | number | bigint | null;

export interface RunResult {
  /** Rows changed by an INSERT/UPDATE/DELETE. */
  changes: number;
}

export interface Statement {
  get<T = unknown>(...params: SqlValue[]): Promise<T | undefined>;
  all<T = unknown>(...params: SqlValue[]): Promise<T[]>;
  run(...params: SqlValue[]): Promise<RunResult>;
}

export type Dialect = "sqlite" | "postgres";

export interface Db {
  readonly dialect: Dialect;
  prepare(sql: string): Statement;
  /**
   * The native handle better-auth's own adapter drives — a raw better-sqlite3
   * `Database` (SQLite) or a node-postgres `Pool` (production Postgres). Returns
   * null when no better-auth-consumable handle exists (e.g. the PGlite test
   * pool, which better-auth's Kysely adapter cannot drive). Application SQL still
   * flows through this seam unchanged; this is purely the auth layer's handle.
   */
  authDatabase(): unknown | null;
  /** Multi-statement DDL/batch execution. No parameters. */
  exec(sql: string): Promise<void>;
  /**
   * Run fn atomically. Statements issued through this Db inside fn join the
   * transaction (routed via AsyncLocalStorage); statements from other async
   * contexts wait (SQLite) or run on their own connection (Postgres). Nested
   * calls flatten into the enclosing transaction.
   */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * True while the current async context is inside `transaction()`. Used to
   * defer best-effort side effects (e.g. Web Push fan-out) until after commit
   * so a failed statement cannot abort the caller's transaction on Postgres.
   */
  isInTransaction(): boolean;
  close(): Promise<void>;
}
