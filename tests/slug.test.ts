import { describe, expect, it } from "vitest";
import { Admin } from "../src/admin.js";
import { allocateSlug, SlugExhaustedError, slugBase } from "../src/slug.js";
import { openTestDb } from "./helpers/db.js";

describe("atomic bounded slug allocation", () => {
  it("normalizes once and allocates base/base-2 under concurrent org and project creation", async () => {
    const db = await openTestDb();
    const admin = new Admin(db);

    const orgs = await Promise.all([admin.createOrg("Recall Labs"), admin.createOrg("Recall Labs")]);
    expect(orgs.map((org) => org.id).sort()).toEqual(["recall-labs", "recall-labs-2"]);
    expect(orgs.some((org) => org.duplicateName)).toBe(true);
    expect(orgs.every((org) => org.warning === (org.duplicateName
      ? "Another organization already uses this name. The new organization was still created."
      : null))).toBe(true);

    const projects = await Promise.all([
      admin.createProject("memory-racer", "Memory Racer"),
      admin.createProject("memory-racer", "Memory Racer"),
    ]);
    expect(projects.map((project) => project.id).sort()).toEqual(["memory-racer", "memory-racer-2"]);
    expect(projects.some((project) => project.duplicateName)).toBe(true);
    expect(projects.every((project) => project.warning === (project.duplicateName
      ? "Another project already uses this name. The new project was still created."
      : null))).toBe(true);
    await db.close();
  });

  it("preserves an explicit Admin id as the normalized preferred base and suffixes it", async () => {
    const db = await openTestDb();
    const admin = new Admin(db);
    expect((await admin.createOrg("First", "  Custom ID! ")).id).toBe("custom-id");
    expect((await admin.createOrg("Second", "  Custom ID! ")).id).toBe("custom-id-2");
    expect((await admin.createProject("Project ID!", "First project")).id).toBe("project-id");
    expect((await admin.createProject("Project ID!", "Second project")).id).toBe("project-id-2");
    await db.close();
  });

  it("fails after the configured bound and propagates unrelated claim errors", async () => {
    await expect(
      allocateSlug({ preferred: "Taken", entity: "project", maxAttempts: 3, claim: async () => false }),
    ).rejects.toEqual(expect.objectContaining<Partial<SlugExhaustedError>>({ base: "taken", attempts: 3 }));

    const unrelated = new Error("foreign key failed");
    await expect(
      allocateSlug({ preferred: "Name", entity: "project", claim: async () => { throw unrelated; } }),
    ).rejects.toBe(unrelated);
  });

  it("uses a stable fallback for names without slug characters", () => {
    expect(slugBase("!!!", "organization")).toBe("org");
    expect(slugBase("!!!", "project")).toBe("project");
  });
});
