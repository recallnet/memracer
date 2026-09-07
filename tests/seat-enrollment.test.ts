// A1: the seat_enrollments table — a short-lived, single-use grant that mints a
// role-scoped seat when redeemed. This test asserts the table exists and stores
// an un-redeemed row (redeemed_at NULL) after boot DDL / migration.
import { describe, expect, it } from "vitest";
import { openTestDb } from "./helpers/db.js";

describe("seat_enrollments table", () => {
  it("stores an enrollment grant with a null redeemed_at", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name, repo) VALUES (?, ?, ?)").run("memracer", "memracer", "recallnet/memracer");
    const now = Date.now();
    await db
      .prepare(
        `INSERT INTO seat_enrollments
           (id, project_id, role, token_hash, created_by, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("enr1", "memracer", "coder", "hash-abc", "user1", now + 900_000, now);
    const row = await db
      .prepare("SELECT id, project_id, role, token_hash, redeemed_at, redeemed_key_id FROM seat_enrollments WHERE id = ?")
      .get<{ id: string; project_id: string; role: string; token_hash: string; redeemed_at: number | null; redeemed_key_id: string | null }>("enr1");
    expect(row).toMatchObject({
      id: "enr1",
      project_id: "memracer",
      role: "coder",
      token_hash: "hash-abc",
      redeemed_at: null,
      redeemed_key_id: null,
    });
  });
});
