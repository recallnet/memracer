// Part F1 — the per-project roles table. seedDefaultRoles lays down the two
// built-in roles (human + coder) idempotently; listRoles reads them back;
// roleKind maps a role slug to the tool-surface KIND, defaulting unknown slugs
// to the worker surface (never the human tools).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db.js";
import { openTestDb } from "./helpers/db.js";
import { seedDefaultRoles, listRoles, roleKind } from "../src/roles.js";

let db: Db;

beforeEach(async () => {
  db = await openTestDb();
  await db.prepare("INSERT INTO projects (id, name, repo) VALUES (?, ?, ?)").run("p1", "P1", "recallnet/p1");
});

afterEach(async () => {
  await db.close();
});

describe("roles table", () => {
  it("seeds human + coder, idempotently", async () => {
    await seedDefaultRoles(db, "p1");
    await seedDefaultRoles(db, "p1"); // second call must not throw or duplicate

    const roles = await listRoles(db, "p1");
    const bySlug = new Map(roles.map((r) => [r.slug, r]));
    expect(bySlug.has("human")).toBe(true);
    expect(bySlug.has("coder")).toBe(true);
    expect(bySlug.get("human")!.kind).toBe("human");
    expect(bySlug.get("human")!.alwaysAvailable).toBe(true);
    expect(bySlug.get("coder")!.kind).toBe("worker");
    expect(roles.filter((r) => r.slug === "human")).toHaveLength(1);
  });

  it("maps role slugs to kinds; unknown slugs fall back to worker", async () => {
    await seedDefaultRoles(db, "p1");
    expect(await roleKind(db, "p1", "human")).toBe("human");
    expect(await roleKind(db, "p1", "coder")).toBe("worker");
    expect(await roleKind(db, "p1", "reviewer")).toBe("worker");
  });
});
