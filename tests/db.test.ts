// tests/db.test.ts
import { describe, expect, it } from "vitest";
import { openTestDb } from "./helpers/db.js";

describe("db", () => {
  it("nests projects under an org", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)").run(
      "recall",
      "Recall",
      Date.now(),
    );
    await db
      .prepare("INSERT INTO projects (id, name, org_id) VALUES (?, ?, ?)")
      .run("ingest", "Ingest", "recall");
    const proj = await db
      .prepare("SELECT org_id FROM projects WHERE id = ?")
      .get<{ org_id: string | null }>("ingest");
    expect(proj?.org_id).toBe("recall");
  });

  it("rejects a project pointing at a nonexistent org", async () => {
    const db = await openTestDb();
    await expect(
      db
        .prepare("INSERT INTO projects (id, name, org_id) VALUES (?, ?, ?)")
        .run("x", "X", "ghost"),
    ).rejects.toThrow();
  });
});
