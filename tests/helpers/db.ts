// Backend selector for the test suite. Default: in-memory SQLite. With
// MEMRACER_TEST_DB=postgres the same tests run against PGlite (real Postgres
// in WASM) through the PostgresDb driver — CI runs the suite once per
// backend. SQLite-specific tests (WAL, sqlite_master migrations, file
// databases) import openDb directly instead.
import { openDb, type Db } from "../../src/db.js";
import { openPgliteDb } from "./pglite.js";

export function testDialect(): "sqlite" | "postgres" {
  return process.env.MEMRACER_TEST_DB === "postgres" ? "postgres" : "sqlite";
}

export async function openTestDb(): Promise<Db> {
  if (testDialect() === "postgres") return openPgliteDb();
  return openDb(":memory:");
}
