import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import {
  ARCHIVE_RETENTION_MS,
  purgeExpiredArchives,
  restoreOrg,
  restoreProject,
  softArchiveOrg,
  softArchiveProject,
} from "../src/project-archive.js";

async function seed() {
  const db = openDb(":memory:");
  const now = Date.now();
  await db.prepare("INSERT INTO orgs (id, name, created_by, created_at) VALUES (?, ?, ?, ?)").run(
    "org1",
    "Org",
    "user-admin",
    now,
  );
  await db
    .prepare("INSERT INTO projects (id, name, org_id, created_by, mediator_model) VALUES (?, ?, ?, ?, ?)")
    .run("p1", "Proj One", "org1", "user-admin", "z-ai/glm-5.2");
  await db
    .prepare("INSERT INTO projects (id, name, org_id, created_by, mediator_model) VALUES (?, ?, ?, ?, ?)")
    .run("p2", "Proj Two", "org1", "user-admin", "z-ai/glm-5.2");
  return db;
}

describe("project soft-delete archive", () => {
  it("archives a project without wiping rows; restore clears archive flags", async () => {
    const db = await seed();
    const t0 = 1_700_000_000_000;
    await softArchiveProject(db, "p1", "user-admin", t0);
    const archived = await db
      .prepare("SELECT archived_at, archived_by, name FROM projects WHERE id = ?")
      .get<{ archived_at: number; archived_by: string; name: string }>("p1");
    expect(archived?.archived_at).toBe(t0);
    expect(archived?.archived_by).toBe("user-admin");
    expect(archived?.name).toBe("Proj One");

    expect(await restoreProject(db, "p1", t0 + 1000)).toBe("ok");
    const live = await db
      .prepare("SELECT archived_at FROM projects WHERE id = ?")
      .get<{ archived_at: number | null }>("p1");
    expect(live?.archived_at).toBeNull();
    await db.close();
  });

  it("refuses restore after 30d window", async () => {
    const db = await seed();
    const t0 = 1_700_000_000_000;
    await softArchiveProject(db, "p1", "user-admin", t0);
    expect(await restoreProject(db, "p1", t0 + ARCHIVE_RETENTION_MS)).toBe("expired");
    await db.close();
  });

  it("org archive cascades to projects; restore org restores in-window projects", async () => {
    const db = await seed();
    const t0 = 1_700_000_000_000;
    const { projectIds } = await softArchiveOrg(db, "org1", "user-admin", t0);
    expect(projectIds.sort()).toEqual(["p1", "p2"]);
    const org = await db
      .prepare("SELECT archived_at FROM orgs WHERE id = ?")
      .get<{ archived_at: number }>("org1");
    expect(org?.archived_at).toBe(t0);

    expect(await restoreOrg(db, "org1", t0 + 1000)).toBe("ok");
    const p1 = await db
      .prepare("SELECT archived_at FROM projects WHERE id = ?")
      .get<{ archived_at: number | null }>("p1");
    expect(p1?.archived_at).toBeNull();
    await db.close();
  });

  it("purge hard-deletes projects past retention", async () => {
    const db = await seed();
    const t0 = 1_700_000_000_000;
    await softArchiveProject(db, "p1", "user-admin", t0);
    // Within window: no purge
    let result = await purgeExpiredArchives(db, t0 + 1000);
    expect(result.purgedProjects).toEqual([]);
    expect(
      await db.prepare("SELECT id FROM projects WHERE id = ?").get("p1"),
    ).toBeTruthy();

    result = await purgeExpiredArchives(db, t0 + ARCHIVE_RETENTION_MS + 1);
    expect(result.purgedProjects).toContain("p1");
    expect(
      await db.prepare("SELECT id FROM projects WHERE id = ?").get("p1"),
    ).toBeUndefined();
    // Sibling project remains
    expect(
      await db.prepare("SELECT id FROM projects WHERE id = ?").get("p2"),
    ).toBeTruthy();
    await db.close();
  });
});
