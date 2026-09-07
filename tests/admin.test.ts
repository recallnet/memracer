// tests/admin.test.ts
import { describe, expect, it } from "vitest";
import { Admin } from "../src/admin.js";
import { openTestDb } from "./helpers/db.js";

describe("Admin", () => {
  it("creates orgs and projects nested under them, and lists an org's projects", async () => {
    const db = await openTestDb();
    const admin = new Admin(db);
    const org = await admin.createOrg("Recall Labs", "recall");
    expect(org).toEqual({ id: "recall", name: "Recall Labs", duplicateName: false, warning: null });
    await admin.createProject("ingest", "Ingest", { orgId: "recall", repo: "recallnet/ingest" });
    await admin.createProject("beta", "Beta", { orgId: "recall" });
    await admin.createProject("orphan", "Orphan"); // no org
    expect(await admin.listOrgProjects("recall")).toEqual([
      { id: "beta", name: "Beta", repo: null },
      { id: "ingest", name: "Ingest", repo: "recallnet/ingest" },
    ]);
    expect(await db.prepare(
      `SELECT domain, requested_generation FROM project_context_domains
        WHERE project_id='ingest' ORDER BY domain`,
    ).all()).toEqual([
      { domain: "architecture-tech", requested_generation: 1 },
      { domain: "constraints-invariants", requested_generation: 0 },
      { domain: "domain-vocabulary", requested_generation: 0 },
      { domain: "history-decisions-learnings", requested_generation: 0 },
      { domain: "operational-external", requested_generation: 1 },
      { domain: "preferences-felt-experience", requested_generation: 0 },
      { domain: "priorities-roadmap", requested_generation: 0 },
      { domain: "product-bounds", requested_generation: 0 },
      { domain: "roles-collaboration", requested_generation: 0 },
      { domain: "team-people", requested_generation: 0 },
    ]);
  });

  it("derives an org id from the name when none is given", async () => {
    const db = await openTestDb();
    const admin = new Admin(db);
    expect((await admin.createOrg("Recall Labs!")).id).toBe("recall-labs");
  });

  it("refuses to create a project under a nonexistent org", async () => {
    const db = await openTestDb();
    const admin = new Admin(db);
    await expect(admin.createProject("x", "X", { orgId: "ghost" })).rejects.toThrow(/ghost/);
  });
});
