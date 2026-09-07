import { apiKeyProjectId } from "./auth.js";
import type { Db } from "./db.js";

interface PresentableTaskBrief {
  project_id: string;
  lease_agent: string | null;
  attempts: Array<{ agent: string } & Record<string, unknown>>;
  questions: Array<{ asked_by: string } & Record<string, unknown>>;
}

export interface ProjectActor {
  actor: string;
  projectId: string;
}

function projectActorKey(actor: string, projectId: string): string {
  return `${projectId}\0${actor}`;
}

export function projectActorLabel(
  labels: ReadonlyMap<string, string>,
  actor: string,
  projectId: string,
): string | undefined {
  return labels.get(projectActorKey(actor, projectId));
}

/** Resolve verified key ids to project-scoped human-readable seat labels. */
export async function projectActorLabels(
  db: Db,
  actors: Iterable<ProjectActor>,
): Promise<Map<string, string>> {
  const projectsByActor = new Map<string, Set<string>>();
  for (const { actor, projectId } of actors) {
    const projects = projectsByActor.get(actor) ?? new Set<string>();
    projects.add(projectId);
    projectsByActor.set(actor, projects);
  }
  if (projectsByActor.size === 0) return new Map();

  const ids = [...projectsByActor.keys()];
  const rows = await db
    .prepare(
      `SELECT k.id, k.name, k.metadata, u.name AS owner_name
       FROM apikey k LEFT JOIN "user" u ON u.id = k."referenceId"
       WHERE k.id IN (${ids.map(() => "?").join(", ")})`,
    )
    .all<{ id: string; name: string | null; metadata: string | null; owner_name: string | null }>(...ids);
  const labels = new Map(
    rows.flatMap((row) => {
      const projectId = apiKeyProjectId(row.metadata);
      const ownerName = row.owner_name?.trim();
      const tokenName = row.name?.trim();
      return projectId && projectsByActor.get(row.id)?.has(projectId) && ownerName && tokenName
        ? [[projectActorKey(row.id, projectId), `${ownerName}-${tokenName}`] as const]
        : [];
    }),
  );
  const oauthRows = await db.prepare(
    `SELECT s.id, s.name, s.project_id, u.name AS owner_name
       FROM oauth_seats s LEFT JOIN "user" u ON u.id = s.user_id
      WHERE s.revoked_at IS NULL AND s.id IN (${ids.map(() => "?").join(", ")})`,
  ).all<{ id: string; name: string; project_id: string; owner_name: string | null }>(...ids);
  for (const row of oauthRows) {
    const ownerName = row.owner_name?.trim();
    const seatName = row.name.trim();
    if (projectsByActor.get(row.id)?.has(row.project_id) && ownerName && seatName) {
      labels.set(projectActorKey(row.id, row.project_id), `${ownerName}-${seatName}`);
    }
  }
  return labels;
}

/**
 * Replace verified API-key ids with their readable seat names at presentation
 * boundaries. Queue ownership remains keyed by the stored id. Only keys whose
 * canonical metadata belongs to this task's project are eligible, so a corrupt
 * or cross-project actor value cannot disclose another project's key label.
 */
export async function presentTaskBriefActors<T extends PresentableTaskBrief>(
  db: Db,
  brief: T,
): Promise<T> {
  const actorIds = new Set<string>();
  if (brief.lease_agent) actorIds.add(brief.lease_agent);
  for (const attempt of brief.attempts) actorIds.add(attempt.agent);
  for (const question of brief.questions) actorIds.add(question.asked_by);
  if (actorIds.size === 0) return brief;

  const names = await projectActorLabels(
    db,
    [...actorIds].map((actor) => ({ actor, projectId: brief.project_id })),
  );
  const present = (actor: string): string => projectActorLabel(names, actor, brief.project_id) ?? actor;

  return {
    ...brief,
    lease_agent: brief.lease_agent === null ? null : present(brief.lease_agent),
    attempts: brief.attempts.map((attempt) => ({ ...attempt, agent: present(attempt.agent) })),
    questions: brief.questions.map((question) => ({
      ...question,
      asked_by: present(question.asked_by),
    })),
  };
}
