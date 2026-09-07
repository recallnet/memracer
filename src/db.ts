// The database seam. Application code imports from here and stays
// dialect-agnostic; SQLite is the default backend and Postgres is selected
// by DATABASE_URL (see docs/postgres-migration.md).
export type { Db, Dialect, RunResult, SqlValue, Statement } from "./db/driver.js";
export { openDb, SqliteDb } from "./db/sqlite.js";
export { openPostgresDb, PostgresDb } from "./db/postgres.js";
export { renderSchema, TABLES_IN_INSERT_ORDER } from "./db/schema.js";
