import type { Db } from "./db.js";
import { allocateSlug } from "./slug.js";
import { ProjectKnowledgeState } from "./mediator/project-knowledge.js";

export interface Org {
  id: string;
  name: string;
}

export interface Project {
  id: string;
  name: string;
  repo: string | null;
}

export interface CreationNotice {
  duplicateName: boolean;
  warning: string | null;
}

function duplicateWarning(kind: "organization" | "project", duplicateName: boolean): string | null {
  return duplicateName ? `Another ${kind} already uses this name. The new ${kind} was still created.` : null;
}

/**
 * Membership administration: the Org->Project->Members lifecycle, previously
 * reachable only through scripts/seed.ts. Every method is dialect-neutral and
 * multi-statement work runs inside one transaction.
 */
export class Admin {
  constructor(private readonly db: Db) {}

  async createOrg(name: string, id?: string): Promise<Org & CreationNotice> {
    const orgId = await allocateSlug({
      preferred: id ?? name,
      entity: "organization",
      claim: async (candidate) =>
        (await this.db
          .prepare("INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING")
          .run(candidate, name, Date.now())).changes === 1,
    });
    const duplicateName =
      (await this.db.prepare("SELECT COUNT(*) AS n FROM orgs WHERE name = ?").get<{ n: number }>(name))!.n > 1;
    return { id: orgId, name, duplicateName, warning: duplicateWarning("organization", duplicateName) };
  }

  async createProject(
    id: string,
    name: string,
    opts: { orgId?: string; repo?: string } = {},
  ): Promise<Project & CreationNotice> {
    const { orgId, repo } = opts;
    if (orgId) {
      const org = await this.db
        .prepare("SELECT id FROM orgs WHERE id = ?")
        .get<{ id: string }>(orgId);
      if (!org) throw new Error(`org '${orgId}' does not exist`);
    }
    const projectId = await allocateSlug({
      preferred: id,
      entity: "project",
      claim: async (candidate) =>
        (await this.db
          .prepare("INSERT INTO projects (id, name, repo, org_id) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO NOTHING")
          .run(candidate, name, repo ?? null, orgId ?? null)).changes === 1,
    });
    const duplicateName =
      (await this.db.prepare("SELECT COUNT(*) AS n FROM projects WHERE name = ?").get<{ n: number }>(name))!.n > 1;
    if (repo) {
      await new ProjectKnowledgeState(this.db).markEvent(
        projectId,
        ["architecture-tech", "operational-external"],
        `repository associated at project creation: ${repo}`,
      );
    }
    return { id: projectId, name, repo: repo ?? null, duplicateName, warning: duplicateWarning("project", duplicateName) };
  }

  async listOrgProjects(orgId: string): Promise<Project[]> {
    return this.db
      .prepare(
        "SELECT id, name, repo FROM projects WHERE org_id = ? ORDER BY id",
      )
      .all<Project>(orgId);
  }
}
