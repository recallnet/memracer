import type { Db } from "./db.js";

export const DEFAULT_ATTENTION_GRACE_MS = 15 * 60 * 1000;
export const DEFAULT_ATTENTION_COOLDOWN_MS = 30 * 60 * 1000;

const ACTIVE_LEASE_STATES = ["CLAIMED", "PLANNED", "EXECUTING"] as const;

interface ProjectAttentionSettings {
  id: string;
  name: string;
  attention_grace_ms: number;
  attention_cooldown_ms: number;
  last_active_lease_at: number | null;
  claim_generation: number;
}

interface AlertRow {
  task_id: number;
  project_id: string;
  episode: number;
  episode_started_at: number;
  title: string;
  task_updated_at: number;
  queued_at: number;
  queue_generation: number;
}

export interface AttentionAlert {
  episode_id: string;
  project: string;
  project_name: string;
  task_id: number;
  task_title: string;
  queued_age_ms: number;
  queued_age: string;
  reason: string;
  recovery: string;
  task_uri: string;
  dashboard_url: string | null;
  episode_started_at: number;
}

function humanDuration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
}

function dashboardTaskUrl(publicUrl: string | undefined, projectId: string, taskId: number): string | null {
  if (!publicUrl) return null;
  try {
    const url = new URL(publicUrl);
    url.searchParams.set("project", projectId);
    url.searchParams.set("task", String(taskId));
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Durable pull-based attention evaluator. human_status is the only trigger:
 * it creates/reopens episodes transactionally and returns every currently
 * active episode. Delivery and local notification dedup remain host-owned.
 */
export class AttentionAlertService {
  constructor(
    private readonly db: Db,
    private readonly publicUrl?: string,
  ) {}

  async evaluate(projectIds: string[], now: number = Date.now()): Promise<AttentionAlert[]> {
    const alerts: AttentionAlert[] = [];
    for (const projectId of projectIds) {
      alerts.push(...(await this.evaluateProject(projectId, now)));
    }
    return alerts;
  }

  private async evaluateProject(projectId: string, now: number): Promise<AttentionAlert[]> {
    return this.db.transaction(async () => {
      // Serializing on the project row makes the read/resolve/create sequence
      // atomic under Postgres. SQLite's BEGIN IMMEDIATE already serializes it.
      const lock = this.db.dialect === "postgres" ? " FOR UPDATE" : "";
      const settings = await this.db
        .prepare(
          `SELECT id, name, attention_grace_ms, attention_cooldown_ms,
                  last_active_lease_at, claim_generation
           FROM projects WHERE id = ?${lock}`,
        )
        .get<ProjectAttentionSettings>(projectId);
      if (!settings) return [];

      const activeLease = await this.db
        .prepare(
          `SELECT id FROM tasks
           WHERE project_id = ?
             AND state IN ('${ACTIVE_LEASE_STATES.join("','")}')
             AND lease_agent IS NOT NULL
             AND lease_expires_at IS NOT NULL
             AND lease_expires_at > ?
           LIMIT 1`,
        )
        .get<{ id: number }>(projectId, now);

      if (activeLease) {
        await this.db
          .prepare(
            `UPDATE attention_alerts
             SET resolved_at = ?, cooldown_until = ?, updated_at = ?
             WHERE project_id = ? AND resolved_at IS NULL`,
          )
          .run(now, now + settings.attention_cooldown_ms, now, projectId);
        return [];
      }

      // A claim+requeue may begin and end between human_status pulls. The
      // monotonic queue generation reveals that transition even when both
      // writes share one millisecond. Resolve at queued_at so grace and
      // cooldown both apply to the new queue episode.
      await this.db
        .prepare(
          `UPDATE attention_alerts
           SET resolved_at = (
                 SELECT t.queued_at FROM tasks t WHERE t.id = attention_alerts.task_id
               ),
               cooldown_until = (
                 SELECT t.queued_at + ? FROM tasks t WHERE t.id = attention_alerts.task_id
               ),
               updated_at = ?
           WHERE project_id = ? AND resolved_at IS NULL
             AND EXISTS (
               SELECT 1 FROM tasks t
               WHERE t.id = attention_alerts.task_id AND t.state = 'QUEUED'
                 AND t.queue_generation <> attention_alerts.queue_generation
             )`,
        )
        .run(settings.attention_cooldown_ms, now, projectId);

      // A different task may also have claimed and released between pulls.
      // claim_generation records every successful project claim, so alerts
      // cannot survive an unobserved task-B lease episode.
      if (settings.last_active_lease_at !== null) {
        await this.db
          .prepare(
            `UPDATE attention_alerts
             SET resolved_at = ?, cooldown_until = ?, updated_at = ?
             WHERE project_id = ? AND resolved_at IS NULL AND claim_generation < ?`,
          )
          .run(
            settings.last_active_lease_at,
            settings.last_active_lease_at + settings.attention_cooldown_ms,
            now,
            projectId,
            settings.claim_generation,
          );
      }

      // A task that was claimed, closed, blocked, parked, warmed, or otherwise
      // left QUEUED is no longer actionable by a coder wait loop.
      await this.db
        .prepare(
          `UPDATE attention_alerts
           SET resolved_at = ?, cooldown_until = ?, updated_at = ?
           WHERE project_id = ? AND resolved_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM tasks t
               WHERE t.id = attention_alerts.task_id AND t.state = 'QUEUED'
             )`,
        )
        .run(now, now + settings.attention_cooldown_ms, now, projectId);

      const eligible = await this.db
        .prepare(
          `SELECT id, title, updated_at, COALESCE(queued_at, updated_at) AS queued_at,
                  queue_generation FROM tasks
           WHERE project_id = ? AND state = 'QUEUED' AND COALESCE(queued_at, updated_at) <= ?
           ORDER BY priority ASC, id ASC`,
        )
        .all<{ id: number; title: string; updated_at: number; queued_at: number; queue_generation: number }>(
          projectId,
          now - settings.attention_grace_ms,
        );

      for (const task of eligible) {
        const existing = await this.db
          .prepare("SELECT episode, resolved_at, cooldown_until FROM attention_alerts WHERE task_id = ?")
          .get<{ episode: number; resolved_at: number | null; cooldown_until: number | null }>(task.id);
        if (!existing) {
          await this.db
            .prepare(
              `INSERT INTO attention_alerts
                 (task_id, project_id, episode, episode_started_at, queue_generation,
                  claim_generation, resolved_at, cooldown_until, created_at, updated_at)
               SELECT ?, ?, 1, ?, ?, ?, NULL, NULL, ?, ?
               WHERE EXISTS (
                 SELECT 1 FROM tasks t
                 WHERE t.id = ? AND t.project_id = ? AND t.state = 'QUEUED'
                   AND COALESCE(t.queued_at, t.updated_at) <= ?
                   AND t.queue_generation = ?
               ) AND NOT EXISTS (
                 SELECT 1 FROM tasks live
                 WHERE live.project_id = ?
                   AND live.state IN ('${ACTIVE_LEASE_STATES.join("','")}')
                   AND live.lease_agent IS NOT NULL
                   AND live.lease_expires_at IS NOT NULL
                   AND live.lease_expires_at > ?
               )
               ON CONFLICT (task_id) DO NOTHING`,
            )
            .run(
              task.id, projectId, task.queued_at, task.queue_generation, settings.claim_generation, now, now,
              task.id, projectId, now - settings.attention_grace_ms, task.queue_generation,
              projectId, now,
            );
        } else if (
          existing.resolved_at !== null &&
          (existing.cooldown_until === null || existing.cooldown_until <= now)
        ) {
          await this.db
            .prepare(
              `UPDATE attention_alerts
               SET episode = episode + 1, episode_started_at = ?, queue_generation = ?,
                   claim_generation = ?, resolved_at = NULL, cooldown_until = NULL, updated_at = ?
               WHERE task_id = ? AND resolved_at IS NOT NULL
                 AND (cooldown_until IS NULL OR cooldown_until <= ?)
                 AND EXISTS (
                   SELECT 1 FROM tasks t
                   WHERE t.id = attention_alerts.task_id AND t.project_id = ?
                     AND t.state = 'QUEUED' AND COALESCE(t.queued_at, t.updated_at) <= ?
                     AND t.queue_generation = ?
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM tasks live
                   WHERE live.project_id = ?
                     AND live.state IN ('${ACTIVE_LEASE_STATES.join("','")}')
                     AND live.lease_agent IS NOT NULL
                     AND live.lease_expires_at IS NOT NULL
                     AND live.lease_expires_at > ?
                 )`,
            )
            .run(
              task.queued_at, task.queue_generation, settings.claim_generation, now, task.id, now,
              projectId, now - settings.attention_grace_ms, task.queue_generation,
              projectId, now,
            );
        }
      }

      const rows = await this.db
        .prepare(
          `SELECT a.task_id, a.project_id, a.episode, a.episode_started_at,
                  t.title, t.updated_at AS task_updated_at,
                  COALESCE(t.queued_at, t.updated_at) AS queued_at,
                  t.queue_generation
           FROM attention_alerts a JOIN tasks t ON t.id = a.task_id
           WHERE a.project_id = ? AND a.resolved_at IS NULL AND t.state = 'QUEUED'
             AND NOT EXISTS (
               SELECT 1 FROM tasks live
               WHERE live.project_id = ?
                 AND live.state IN ('${ACTIVE_LEASE_STATES.join("','")}')
                 AND live.lease_agent IS NOT NULL
                 AND live.lease_expires_at IS NOT NULL
                 AND live.lease_expires_at > ?
             )
           ORDER BY t.priority ASC, t.id ASC`,
        )
        .all<AlertRow>(projectId, projectId, now);

      return rows.map((row) => ({
        episode_id: `${row.task_id}:${row.episode}`,
        project: row.project_id,
        project_name: settings.name,
        task_id: row.task_id,
        task_title: row.title,
        queued_age_ms: Math.max(0, now - row.queued_at),
        queued_age: humanDuration(now - row.queued_at),
        reason: `This task has remained queued past the project's ${humanDuration(settings.attention_grace_ms)} attention grace, and no coder currently holds a live lease in the project.`,
        recovery: "Start or wake a coder for this project; coder_check_work will report availability, then coder_claim_task claims queued work explicitly.",
        task_uri: `task://${row.task_id}`,
        dashboard_url: dashboardTaskUrl(this.publicUrl, row.project_id, row.task_id),
        episode_started_at: row.episode_started_at,
      }));
    });
  }
}
