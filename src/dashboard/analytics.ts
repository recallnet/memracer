import { apiKeyProjectId } from "../auth.js";
import type { Db } from "../db.js";
import { projectActorLabel, projectActorLabels } from "../present-task-brief.js";

export type AnalyticsPeriod = "24h" | "7d" | "30d" | "all";
export type AnalyticsRole = "human" | "coder" | "admin";
export type AnalyticsContributionKind = "steer" | "create" | "complete" | "answer";

export interface AnalyticsContributionCounts {
  steer: number;
  create: number;
  complete: number;
  answer: number;
  total: number;
}

export interface AnalyticsAgentContribution {
  id: string;
  label: string;
  contributions: AnalyticsContributionCounts;
}

export interface AnalyticsContributor {
  id: string | null;
  name: string;
  email: string | null;
  role: AnalyticsRole;
  task_count: number;
  completed_count: number;
  active_count: number;
  last_activity_at: number | null;
  idle: boolean;
  name_collision: boolean;
  contributions: AnalyticsContributionCounts;
  agent_contributions: AnalyticsAgentContribution[];
}

export interface AnalyticsAgent {
  id: string;
  label: string;
  owner_id: string | null;
  owner_name: string | null;
  revoked: boolean;
  unresolved: boolean;
  state_counts: Record<string, number>;
  attempt_count: number;
  completed_attempts: number;
  last_activity_at: number | null;
}

export interface AnalyticsRoutingRow {
  model: string;
  rollout_arm: string;
  invocations: number;
  successful: number;
  failed: number;
  retried: number;
  average_latency_ms: number | null;
  tokens_in: number;
  tokens_out: number;
  quality_signals: number;
  /** Spend from mediator_usage for this resolved model. */
  cost_usd: number;
}

export interface AnalyticsScorecardModelSegment {
  model: string;
  completions: number;
  cost_usd: number;
}

export interface AnalyticsScorecardRow {
  kind: string;
  jobs: number;
  completions: number;
  cost_usd: number;
  invocations: number;
  successful: number;
  failed: number;
  average_latency_ms: number | null;
  /** Stacked bar segments by resolved_model (null → "unknown"). */
  by_model: AnalyticsScorecardModelSegment[];
}

export interface AnalyticsSpendSegment {
  model: string;
  cost_usd: number;
}

export interface AnalyticsSpendBucket {
  /** Stable bucket key (ISO hour or day start). */
  bucket: string;
  bucket_start: number;
  /** Human label for the x-axis. */
  label: string;
  total_usd: number;
  /** Stacked segments ordered by compareScorecardModels. */
  segments: AnalyticsSpendSegment[];
}

export interface ProjectAnalytics {
  period: AnalyticsPeriod;
  window: { since: number | null; label: string };
  headline: {
    members: number;
    active_members: number;
    tasks: number;
    active_tasks: number;
    completed_tasks: number;
    task_completion_rate: number;
    total_cost_usd: number;
    contributions: number;
    tasks_shipped: number;
    frigg_jobs: number;
    trends: {
      contributions: number | null;
      tasks_shipped: number | null;
      active_members: number | null;
      frigg_jobs: number | null;
      frigg_spend: number | null;
    };
  };
  contributors: AnalyticsContributor[];
  agents: AnalyticsAgent[];
  routing: AnalyticsRoutingRow[];
  scorecard: AnalyticsScorecardRow[];
  spend_series: AnalyticsSpendBucket[];
}

type MemberRow = { id: string; name: string; email: string | null; role: AnalyticsRole };
type TaskRow = { id: number; state: string; submitted_by: string; lease_agent: string | null; created_at: number; updated_at: number };
type AttemptRow = { agent: string; outcome: string; created_at: number; task_id: number };
type ThreadMessageRow = { author: string; created_at: number };
type QuestionAnswerRow = { answered_by: string | null; answered_at: number | null };
type SeatRow = { id: string; name: string; owner_id: string | null; owner_name: string | null; project_id: string; role: "human" | "coder"; revoked: boolean };
type AnalyticsRows = {
  tasks: TaskRow[];
  attempts: AttemptRow[];
  threadMessages: ThreadMessageRow[];
  answers: QuestionAnswerRow[];
  policy: Array<{ kind: string; model: string; rollout_arm: string; outcome: string | null; latency_ms: number | null; tokens_in: number; tokens_out: number; quality_signal: string | null }>;
  usage: Array<{ kind: string; resolved_model: string | null; completion_count: number; cost_usd: number | null; created_at: number }>;
};

/** Floor a timestamp to the start of its hour (UTC). */
export function bucketStartHour(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours());
}

/** Floor a timestamp to the start of its UTC day. */
export function bucketStartDay(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Build spend-over-time buckets for the analytics chart.
 * 24h → hourly; 7d/30d/all → daily. Drops empty (zero-spend) buckets.
 * Unattributed/empty models become "unknown" and keep the unattributed color slot.
 */
export function buildSpendSeries(
  usage: Array<{ resolved_model: string | null; cost_usd: number | null; created_at: number }>,
  period: AnalyticsPeriod,
  _now = Date.now(),
): AnalyticsSpendBucket[] {
  const hourly = period === "24h";
  const byBucket = new Map<number, Map<string, number>>();
  for (const row of usage) {
    const cost = number(row.cost_usd);
    if (!(cost > 0)) continue;
    const start = hourly ? bucketStartHour(row.created_at) : bucketStartDay(row.created_at);
    const model = resolvedModelLabel(row.resolved_model);
    const models = byBucket.get(start) ?? new Map<string, number>();
    models.set(model, (models.get(model) ?? 0) + cost);
    byBucket.set(start, models);
  }
  return [...byBucket.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([bucket_start, models]) => {
      const segments = [...models.entries()]
        .map(([model, cost_usd]) => ({ model, cost_usd: Math.round(cost_usd * 10000) / 10000 }))
        .sort((left, right) => compareScorecardModels(left.model, right.model));
      const total_usd = Math.round(segments.reduce((sum, s) => sum + s.cost_usd, 0) * 10000) / 10000;
      const date = new Date(bucket_start);
      const label = hourly
        ? date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", timeZone: "UTC" })
        : date.toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" });
      return {
        bucket: date.toISOString(),
        bucket_start,
        label,
        total_usd,
        segments,
      };
    })
    .filter((bucket) => bucket.total_usd > 0);
}

/** Stable label for null/empty resolved_model — never drop those rows. */
export function resolvedModelLabel(resolved: string | null | undefined): string {
  const trimmed = resolved?.trim();
  return trimmed ? trimmed : "unknown";
}

import {
  compareScorecardModels,
  modelFamily,
  type ModelFamily,
} from "./model-family.js";

// Re-export shared classification so existing analytics imports keep working.
export { compareScorecardModels, modelFamily, type ModelFamily };

type AnalyticsBounds = { since: number | null; until: number | null };

type ContributionSummary = {
  byMember: Map<string, AnalyticsContributionCounts>;
  byAgent: Map<string, AnalyticsContributionCounts>;
  total: number;
  activeMembers: Set<string>;
};

const SYNTHETIC_ACTORS = /^(?:system|mediator|steward|frigg|human|coder)$/i;

export function analyticsWindow(period: AnalyticsPeriod, now = Date.now()): { since: number | null; label: string } {
  if (period === "all") return { since: null, label: "all time" };
  const durations: Record<Exclude<AnalyticsPeriod, "all">, number> = {
    "24h": 24 * 60 * 60_000,
    "7d": 7 * 24 * 60 * 60_000,
    "30d": 30 * 24 * 60 * 60_000,
  };
  return { since: now - durations[period], label: period === "24h" ? "last 24 hours" : period === "7d" ? "last 7 days" : "last 30 days" };
}

function analyticsPreviousBounds(period: AnalyticsPeriod, now: number): AnalyticsBounds | null {
  if (period === "all") return null;
  const durations: Record<Exclude<AnalyticsPeriod, "all">, number> = {
    "24h": 24 * 60 * 60_000,
    "7d": 7 * 24 * 60 * 60_000,
    "30d": 30 * 24 * 60 * 60_000,
  };
  const currentSince = now - durations[period];
  return { since: currentSince - durations[period], until: currentSince };
}

function number(value: unknown): number {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function average(total: number, count: number): number | null {
  return count > 0 ? Math.round((total / count) * 100) / 100 : null;
}

function parseSeatProject(metadata: string | null): string | null {
  try {
    return apiKeyProjectId(metadata);
  } catch {
    return null;
  }
}

function parseSeatRole(metadata: string | null): "human" | "coder" {
  try {
    return (JSON.parse(metadata ?? "null") as { type?: string } | null)?.type === "coder" ? "coder" : "human";
  } catch {
    return "human";
  }
}

async function safeRows<T>(run: () => Promise<T[]>): Promise<T[]> {
  try {
    return await run();
  } catch {
    return [];
  }
}

async function loadMembers(db: Db, projectId: string): Promise<MemberRow[]> {
  const rows = await safeRows(() => db.prepare(
    `SELECT u.id AS id, u.name AS name, u.email AS email, m.role AS role
       FROM "member" m JOIN "user" u ON u.id = m."userId"
      WHERE m."organizationId" = ? ORDER BY u.name, u.id`,
  ).all<MemberRow>(projectId));
  return rows.map((row) => ({
    ...row,
    role: row.role === "admin" || row.role === "coder" ? row.role : "human",
  }));
}

async function loadSeats(db: Db, projectId: string): Promise<SeatRow[]> {
  const staticRows = await safeRows(() => db.prepare(
    `SELECT k.id, k.name, k.metadata, k."referenceId" AS owner_id, u.name AS owner_name
       FROM apikey k LEFT JOIN "user" u ON u.id = k."referenceId"`,
  ).all<{ id: string; name: string | null; metadata: string | null; owner_id: string | null; owner_name: string | null }>());
  const staticSeats = staticRows.flatMap((row) => {
    const scope = parseSeatProject(row.metadata);
    return scope === projectId
      ? [{ id: row.id, name: row.name?.trim() || "unnamed seat", owner_id: row.owner_id, owner_name: row.owner_name, project_id: projectId, role: parseSeatRole(row.metadata), revoked: false }]
      : [];
  });
  const oauthSeats = await safeRows(() => db.prepare(
    `SELECT s.id, s.name, s.role, s.user_id AS owner_id, u.name AS owner_name, s.project_id, s.revoked_at
       FROM oauth_seats s LEFT JOIN "user" u ON u.id = s.user_id
      WHERE s.project_id = ?`,
  ).all<{ id: string; name: string; role: "human" | "coder"; owner_id: string | null; owner_name: string | null; project_id: string; revoked_at: number | null }>(projectId));
  return [...staticSeats, ...oauthSeats.map((row) => ({
    id: row.id,
    name: row.name.trim() || "unnamed seat",
    owner_id: row.owner_id,
    owner_name: row.owner_name,
    project_id: row.project_id,
    role: row.role,
    revoked: row.revoked_at !== null,
  }))];
}

function stateCounts(): Record<string, number> {
  return { INCUBATING: 0, QUEUED: 0, CLAIMED: 0, PLANNED: 0, EXECUTING: 0, AWAITING_MERGE: 0, DONE: 0, BLOCKED: 0, PARKED: 0, HELD: 0 };
}

function normalizedActor(value: string): string {
  return value.trim().toLowerCase();
}

function emptyContributions(): AnalyticsContributionCounts {
  return { steer: 0, create: 0, complete: 0, answer: 0, total: 0 };
}

function addContribution(target: Map<string, AnalyticsContributionCounts>, id: string, kind: AnalyticsContributionKind): void {
  const counts = target.get(id) ?? emptyContributions();
  counts[kind] += 1;
  counts.total += 1;
  target.set(id, counts);
}

function inBounds(timestamp: number, bounds: AnalyticsBounds): boolean {
  return (bounds.since === null || timestamp >= bounds.since) && (bounds.until === null || timestamp < bounds.until);
}

async function loadAnalyticsRows(db: Db, projectId: string, bounds: AnalyticsBounds): Promise<AnalyticsRows> {
  const taskWindow = bounds.since === null
    ? ""
    : bounds.until === null
      ? " AND (created_at >= ? OR updated_at >= ?)"
      : " AND ((created_at >= ? AND created_at < ?) OR (updated_at >= ? AND updated_at < ?))";
  const taskParams = bounds.since === null
    ? []
    : bounds.until === null
      ? [bounds.since, bounds.since]
      : [bounds.since, bounds.until, bounds.since, bounds.until];
  const eventWindow = bounds.since === null
    ? ""
    : bounds.until === null
      ? " AND created_at >= ?"
      : " AND created_at >= ? AND created_at < ?";
  const attemptWindow = eventWindow.replaceAll("created_at", "a.created_at");
  const messageWindow = eventWindow.replaceAll("created_at", "m.created_at");
  const eventParams = bounds.since === null ? [] : bounds.until === null ? [bounds.since] : [bounds.since, bounds.until];
  const answerWindow = bounds.since === null
    ? ""
    : bounds.until === null
      ? " AND answered_at >= ?"
      : " AND answered_at >= ? AND answered_at < ?";
  const answerParams = bounds.since === null ? [] : bounds.until === null ? [bounds.since] : [bounds.since, bounds.until];
  const [tasks, attempts, threadMessages, answers, policy, usage] = await Promise.all([
    db.prepare(
      `SELECT id, state, submitted_by, lease_agent, created_at, updated_at
         FROM tasks WHERE project_id = ?${taskWindow} ORDER BY id`,
    ).all<TaskRow>(projectId, ...taskParams),
    db.prepare(
      `SELECT a.agent, a.outcome, a.created_at, a.task_id
         FROM attempts a JOIN tasks t ON t.id = a.task_id
        WHERE t.project_id = ?${attemptWindow} ORDER BY a.created_at`,
    ).all<AttemptRow>(projectId, ...eventParams),
    db.prepare(
      `SELECT m.author, m.created_at
         FROM thread_messages m JOIN threads th ON th.id = m.thread_id
        WHERE th.project_id = ? AND m.role = 'human'${messageWindow}
        ORDER BY m.created_at`,
    ).all<ThreadMessageRow>(projectId, ...eventParams),
    db.prepare(
      `SELECT answered_by, answered_at
         FROM questions
        WHERE project_id = ? AND status = 'answered' AND answered_by IS NOT NULL AND answered_at IS NOT NULL${answerWindow}
        ORDER BY answered_at`,
    ).all<QuestionAnswerRow>(projectId, ...answerParams),
    db.prepare(
      `SELECT kind, COALESCE(model, '') AS model, rollout_arm, outcome, latency_ms, tokens_in, tokens_out, quality_signal
         FROM job_policy_log WHERE project_id = ?${eventWindow}`,
    ).all<AnalyticsRows["policy"][number]>(projectId, ...eventParams),
    db.prepare(
      `SELECT kind, resolved_model, completion_count, cost_usd, created_at
         FROM mediator_usage WHERE project_id = ?${eventWindow}`,
    ).all<AnalyticsRows["usage"][number]>(projectId, ...eventParams),
  ]);
  return { tasks, attempts, threadMessages, answers, policy, usage };
}

function summarizeContributions(
  rows: AnalyticsRows,
  bounds: AnalyticsBounds,
  resolveMemberId: (actor: string) => string | null,
  memberById: Map<string, MemberRow>,
  seatById: Map<string, SeatRow>,
): ContributionSummary {
  const byMember = new Map<string, AnalyticsContributionCounts>();
  const byAgent = new Map<string, AnalyticsContributionCounts>();
  const activeMembers = new Set<string>();
  const submittedByTask = new Map<number, string | null>();
  const attemptsByTask = new Map<number, AttemptRow[]>();
  const mark = (memberId: string | null, kind: AnalyticsContributionKind) => {
    if (!memberId || !memberById.has(memberId)) return;
    addContribution(byMember, memberId, kind);
    activeMembers.add(memberId);
  };
  for (const message of rows.threadMessages) mark(resolveMemberId(message.author), "steer");
  for (const answer of rows.answers) mark(answer.answered_by ? resolveMemberId(answer.answered_by) : null, "answer");
  for (const attempt of rows.attempts) attemptsByTask.set(attempt.task_id, [...(attemptsByTask.get(attempt.task_id) ?? []), attempt]);
  for (const task of rows.tasks) {
    const submitter = resolveMemberId(task.submitted_by);
    submittedByTask.set(task.id, submitter);
    if (inBounds(task.created_at, bounds)) mark(submitter, "create");
    if (inBounds(task.updated_at, bounds) && submitter) activeMembers.add(submitter);
  }
  for (const task of rows.tasks) {
    if (task.state !== "DONE") continue;
    const completedAttempt = (attemptsByTask.get(task.id) ?? [])
      .filter((attempt) => attempt.outcome === "completed")
      .sort((left, right) => right.created_at - left.created_at)[0];
    if (!inBounds(task.updated_at, bounds) && !completedAttempt) continue;
    const ownerId = completedAttempt ? seatById.get(completedAttempt.agent)?.owner_id : null;
    const memberId = ownerId && memberById.has(ownerId) ? ownerId : submittedByTask.get(task.id) ?? null;
    mark(memberId, "complete");
    if (completedAttempt && ownerId && memberById.has(ownerId)) {
      addContribution(byAgent, completedAttempt.agent, "complete");
    }
  }
  for (const attempt of rows.attempts) {
    const ownerId = seatById.get(attempt.agent)?.owner_id;
    if (ownerId && memberById.has(ownerId)) activeMembers.add(ownerId);
  }
  const total = [...byMember.values()].reduce((sum, counts) => sum + counts.total, 0);
  return { byMember, byAgent, total, activeMembers };
}

export async function loadProjectAnalytics(db: Db, projectId: string, period: AnalyticsPeriod = "7d", now = Date.now()): Promise<ProjectAnalytics> {
  const window = analyticsWindow(period, now);
  const currentBounds: AnalyticsBounds = { since: window.since, until: null };
  const previousBounds = analyticsPreviousBounds(period, now);
  const [members, currentRows, seats] = await Promise.all([
    loadMembers(db, projectId),
    loadAnalyticsRows(db, projectId, currentBounds),
    loadSeats(db, projectId),
  ]);
  const previousRows = previousBounds ? await loadAnalyticsRows(db, projectId, previousBounds) : null;
  const { tasks, attempts, threadMessages, answers, policy, usage } = currentRows;

  const actors = new Set<string>();
  for (const task of tasks) if (task.lease_agent && !SYNTHETIC_ACTORS.test(task.lease_agent)) actors.add(task.lease_agent);
  for (const attempt of attempts) if (!SYNTHETIC_ACTORS.test(attempt.agent)) actors.add(attempt.agent);
  for (const seat of seats) if (seat.role === "coder") actors.add(seat.id);
  let labels = new Map<string, string>();
  try {
    labels = await projectActorLabels(db, [...actors].map((actor) => ({ actor, projectId })));
  } catch {
    // A stale or malformed seat must not make the read-only analytics surface
    // fail. The agent row below deliberately falls back to a non-secret label.
  }
  const seatById = new Map(seats.map((seat) => [seat.id, seat]));
  const memberById = new Map(members.map((member) => [member.id, member]));
  const membersByName = new Map<string, MemberRow[]>();
  for (const member of members) {
    const key = normalizedActor(member.name);
    if (key.length === 0) continue;
    membersByName.set(key, [...(membersByName.get(key) ?? []), member]);
  }
  const resolveMemberId = (actor: string): string | null => {
    // Stable ids win over display-name aliases. This keeps historical rows
    // attributable even after a member changes their name.
    const trimmed = actor.trim();
    if (memberById.has(trimmed)) return trimmed;
    const seatOwner = seatById.get(trimmed)?.owner_id;
    if (seatOwner && memberById.has(seatOwner)) return seatOwner;
    const matches = membersByName.get(normalizedActor(actor)) ?? [];
    return matches.length === 1 ? matches[0].id : null;
  };
  const currentSummary = summarizeContributions(currentRows, currentBounds, resolveMemberId, memberById, seatById);
  const previousSummary = previousRows
    ? summarizeContributions(previousRows, previousBounds!, resolveMemberId, memberById, seatById)
    : null;
  const submittedByMember = new Map<number, string | null>();
  const taskCounts = new Map<string, number>();
  for (const task of tasks) {
    const memberId = resolveMemberId(task.submitted_by);
    submittedByMember.set(task.id, memberId);
    if (memberId) taskCounts.set(memberId, (taskCounts.get(memberId) ?? 0) + 1);
  }
  const attemptsByTask = new Map<number, AttemptRow[]>();
  for (const attempt of attempts) {
    attemptsByTask.set(attempt.task_id, [...(attemptsByTask.get(attempt.task_id) ?? []), attempt]);
  }
  const completedByMember = new Map<string, number>();
  for (const task of tasks) {
    if (task.state !== "DONE") continue;
    const completedAttempt = (attemptsByTask.get(task.id) ?? [])
      .filter((attempt) => attempt.outcome === "completed")
      .sort((left, right) => right.created_at - left.created_at)[0];
    const completedBySeat = completedAttempt ? seatById.get(completedAttempt.agent)?.owner_id : null;
    const memberId = completedBySeat && memberById.has(completedBySeat)
      ? completedBySeat
      : submittedByMember.get(task.id) ?? null;
    if (memberId) completedByMember.set(memberId, (completedByMember.get(memberId) ?? 0) + 1);
  }

  const agents = [...actors].sort().map((actor): AnalyticsAgent => {
    const seat = seatById.get(actor);
    const activeLabel = projectActorLabel(labels, actor, projectId);
    const revoked = seat?.revoked ?? false;
    const unresolved = !seat;
    const label = activeLabel ?? (seat ? `${seat.owner_name?.trim() || "Former agent"} · ${seat.name}${revoked ? " (revoked)" : ""}` : "Former agent (unresolved)");
    const ownedTasks = tasks.filter((task) => task.lease_agent === actor);
    const ownedAttempts = attempts.filter((attempt) => attempt.agent === actor);
    const counts = stateCounts();
    for (const task of ownedTasks) counts[task.state] = (counts[task.state] ?? 0) + 1;
    return {
      id: actor,
      label,
      owner_id: seat?.owner_id ?? null,
      owner_name: seat?.owner_name ?? null,
      revoked,
      unresolved,
      state_counts: counts,
      attempt_count: ownedAttempts.length,
      completed_attempts: ownedAttempts.filter((attempt) => attempt.outcome === "completed").length,
      last_activity_at: [...ownedTasks.map((task) => task.updated_at), ...ownedAttempts.map((attempt) => attempt.created_at)].sort((a, b) => b - a)[0] ?? null,
    };
  });

  const contributors = members.map((member): AnalyticsContributor => {
    const ownAgents = agents.filter((agent) => agent.owner_id === member.id);
    const submitted = tasks.filter((task) => submittedByMember.get(task.id) === member.id);
    const active = ownAgents.reduce((sum, agent) => sum + (agent.state_counts.CLAIMED ?? 0) + (agent.state_counts.PLANNED ?? 0) + (agent.state_counts.EXECUTING ?? 0), 0);
    const activity = [...submitted.map((task) => task.updated_at), ...ownAgents.flatMap((agent) => agent.last_activity_at ? [agent.last_activity_at] : [])].sort((a, b) => b - a)[0] ?? null;
    return {
      id: member.id,
      name: member.name,
      email: member.email,
      role: member.role,
      task_count: taskCounts.get(member.id) ?? 0,
      completed_count: completedByMember.get(member.id) ?? 0,
      active_count: active,
      last_activity_at: activity,
      idle: activity === null,
      name_collision: (membersByName.get(normalizedActor(member.name))?.length ?? 0) > 1,
      contributions: currentSummary.byMember.get(member.id) ?? emptyContributions(),
      agent_contributions: ownAgents
        .filter((agent) => (currentSummary.byAgent.get(agent.id)?.total ?? 0) > 0 || agent.attempt_count > 0)
        .map((agent) => ({
          id: agent.id,
          label: agent.label,
          contributions: currentSummary.byAgent.get(agent.id) ?? emptyContributions(),
        })),
    };
  }).sort((left, right) => right.contributions.total - left.contributions.total || right.task_count - left.task_count || left.name.localeCompare(right.name) || (left.id ?? "").localeCompare(right.id ?? ""));

  // Spend by resolved model (usage is the cost source of truth).
  const spendByModel = new Map<string, number>();
  for (const row of usage) {
    const model = resolvedModelLabel(row.resolved_model);
    spendByModel.set(model, (spendByModel.get(model) ?? 0) + number(row.cost_usd));
  }

  const routingMap = new Map<string, AnalyticsRoutingRow>();
  const routingLatency = new Map<string, { total: number; count: number }>();
  for (const row of policy) {
    const model = row.model || "unknown";
    const key = `${model}\0${row.rollout_arm || "flat"}`;
    const current = routingMap.get(key) ?? {
      model,
      rollout_arm: row.rollout_arm || "flat",
      invocations: 0,
      successful: 0,
      failed: 0,
      retried: 0,
      average_latency_ms: null,
      tokens_in: 0,
      tokens_out: 0,
      quality_signals: 0,
      cost_usd: 0,
    };
    current.invocations += 1;
    if (row.outcome === "ok") current.successful += 1;
    if (row.outcome === "fail") current.failed += 1;
    if (row.outcome === "retry") current.retried += 1;
    current.tokens_in += number(row.tokens_in);
    current.tokens_out += number(row.tokens_out);
    current.quality_signals += row.quality_signal ? 1 : 0;
    if (row.latency_ms !== null) {
      const latency = routingLatency.get(key) ?? { total: 0, count: 0 };
      latency.total += number(row.latency_ms);
      latency.count += 1;
      routingLatency.set(key, latency);
      current.average_latency_ms = average(latency.total, latency.count);
    }
    routingMap.set(key, current);
  }
  // Split per-model spend across arms by invocation share so multi-arm models
  // do not dump all dollars onto the alphabetically first arm (flat) while
  // routed shows $0. Sum of arm costs equals model total (no double-count).
  const armsByModel = new Map<string, AnalyticsRoutingRow[]>();
  for (const row of routingMap.values()) {
    const list = armsByModel.get(row.model) ?? [];
    list.push(row);
    armsByModel.set(row.model, list);
  }
  const spendAssigned = new Set<string>();
  for (const [model, arms] of armsByModel) {
    const totalCost = spendByModel.get(model) ?? 0;
    const totalInv = arms.reduce((sum, a) => sum + a.invocations, 0);
    if (!(totalCost > 0)) {
      for (const arm of arms) arm.cost_usd = 0;
      spendAssigned.add(model);
      continue;
    }
    if (totalInv <= 0) {
      // No policy invocations — leave cost on a single arm (first sorted).
      arms.sort((a, b) => a.rollout_arm.localeCompare(b.rollout_arm));
      arms[0]!.cost_usd = totalCost;
      for (let i = 1; i < arms.length; i++) arms[i]!.cost_usd = 0;
      spendAssigned.add(model);
      continue;
    }
    let assigned = 0;
    arms.sort((a, b) => a.rollout_arm.localeCompare(b.rollout_arm));
    for (let i = 0; i < arms.length; i++) {
      const arm = arms[i]!;
      if (i === arms.length - 1) {
        arm.cost_usd = Math.round((totalCost - assigned) * 10000) / 10000;
      } else {
        const share = (arm.invocations / totalInv) * totalCost;
        arm.cost_usd = Math.round(share * 10000) / 10000;
        assigned += arm.cost_usd;
      }
    }
    spendAssigned.add(model);
  }
  for (const [model, cost] of spendByModel) {
    if (spendAssigned.has(model)) continue;
    // Usage-only rows with no spend are pure noise (empty resolved_model + $0
    // failed/no-op completions). Keep real spend even without policy rows.
    if (!(cost > 0)) continue;
    routingMap.set(`${model}\0flat`, {
      model,
      rollout_arm: "flat",
      invocations: 0,
      successful: 0,
      failed: 0,
      retried: 0,
      average_latency_ms: null,
      tokens_in: 0,
      tokens_out: 0,
      quality_signals: 0,
      cost_usd: cost,
    });
    spendAssigned.add(model);
  }

  const scorecardMap = new Map<string, AnalyticsScorecardRow>();
  const scorecardLatency = new Map<string, { total: number; count: number }>();
  const scorecardModelMap = new Map<string, Map<string, AnalyticsScorecardModelSegment>>();
  for (const row of usage) {
    const current = scorecardMap.get(row.kind) ?? {
      kind: row.kind,
      jobs: 0,
      completions: 0,
      cost_usd: 0,
      invocations: 0,
      successful: 0,
      failed: 0,
      average_latency_ms: null,
      by_model: [],
    };
    current.jobs += 1;
    current.completions += number(row.completion_count);
    current.cost_usd += number(row.cost_usd);
    scorecardMap.set(row.kind, current);

    const model = resolvedModelLabel(row.resolved_model);
    const byKind = scorecardModelMap.get(row.kind) ?? new Map<string, AnalyticsScorecardModelSegment>();
    const segment = byKind.get(model) ?? { model, completions: 0, cost_usd: 0 };
    segment.completions += number(row.completion_count);
    segment.cost_usd += number(row.cost_usd);
    byKind.set(model, segment);
    scorecardModelMap.set(row.kind, byKind);
  }
  for (const row of policy) {
    const current = scorecardMap.get(row.kind) ?? {
      kind: row.kind,
      jobs: 0,
      completions: 0,
      cost_usd: 0,
      invocations: 0,
      successful: 0,
      failed: 0,
      average_latency_ms: null,
      by_model: [],
    };
    current.invocations += 1;
    if (row.outcome === "ok") current.successful += 1;
    if (row.outcome === "fail") current.failed += 1;
    if (row.latency_ms !== null) {
      const latency = scorecardLatency.get(row.kind) ?? { total: 0, count: 0 };
      latency.total += number(row.latency_ms);
      latency.count += 1;
      scorecardLatency.set(row.kind, latency);
      current.average_latency_ms = average(latency.total, latency.count);
    }
    scorecardMap.set(row.kind, current);
  }
  for (const [kind, segments] of scorecardModelMap) {
    const row = scorecardMap.get(kind);
    if (!row) continue;
    row.by_model = [...segments.values()].sort(
      (left, right) => compareScorecardModels(left.model, right.model),
    );
  }

  const activeTasks = tasks.filter((task) => ["CLAIMED", "PLANNED", "EXECUTING"].includes(task.state)).length;
  const completedTasks = tasks.filter((task) => task.state === "DONE").length;
  const totalCost = usage.reduce((sum, row) => sum + number(row.cost_usd), 0);
  const previousCompletedTasks = previousRows ? previousRows.tasks.filter((task) => task.state === "DONE" && inBounds(task.updated_at, previousBounds!)).length : null;
  const previousCost = previousRows?.usage.reduce((sum, row) => sum + number(row.cost_usd), 0) ?? null;
  return {
    period,
    window,
    headline: {
      members: members.length,
      active_members: contributors.filter((member) => !member.idle).length,
      tasks: tasks.length,
      active_tasks: activeTasks,
      completed_tasks: completedTasks,
      task_completion_rate: tasks.length === 0 ? 0 : Math.round((completedTasks / tasks.length) * 100),
      total_cost_usd: Math.round(totalCost * 10000) / 10000,
      contributions: currentSummary.total,
      tasks_shipped: completedTasks,
      frigg_jobs: usage.length,
      trends: {
        contributions: previousSummary ? currentSummary.total - previousSummary.total : null,
        tasks_shipped: previousCompletedTasks === null ? null : completedTasks - previousCompletedTasks,
        active_members: previousSummary ? currentSummary.activeMembers.size - previousSummary.activeMembers.size : null,
        frigg_jobs: previousRows ? usage.length - previousRows.usage.length : null,
        frigg_spend: previousCost === null ? null : Math.round((totalCost - previousCost) * 10000) / 10000,
      },
    },
    contributors,
    agents,
    // Drop degenerate rows with neither routing decisions nor spend (phantom
    // "unknown / flat / 0 / $0.00"). Keep usage-only spend and zero-cost policy.
    routing: [...routingMap.values()]
      .filter((row) => row.invocations > 0 || row.cost_usd > 0)
      .sort((left, right) => left.model.localeCompare(right.model) || left.rollout_arm.localeCompare(right.rollout_arm)),
    scorecard: [...scorecardMap.values()].sort((left, right) => left.kind.localeCompare(right.kind)),
    spend_series: buildSpendSeries(usage, period, now),
  };
}
