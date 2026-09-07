import type { AgentDto, QueueTaskDto, TaskTransitionDto, ThreadDto } from "../data/dto.js";
import type { QueueSort, SortDirection, TaskState } from "./url-state.js";

export const ACTIVE_STATES = new Set<TaskState>(["CLAIMED", "PLANNED", "EXECUTING"]);
export const ACTIONABLE_QUEUE_STATES = new Set<TaskState>([
  "QUEUED",
  "CLAIMED",
  "PLANNED",
  "EXECUTING",
  "BLOCKED",
  "AWAITING_MERGE",
]);
/** Parked off the coder claim path — always surface in the On hold panel. */
export const ON_HOLD_STATES = new Set<TaskState>(["HELD", "INCUBATING"]);
export const ACTIVITY_GROUP_LIMIT = 24;

export interface ActivityThreadGroup {
  thread: ThreadDto;
  threadIds: number[];
  taskId: number | null;
  taskTitle: string | null;
}

export interface QueueFilters {
  state: TaskState | null;
  agent: string | null;
  sort: QueueSort;
  direction: SortDirection;
  includeHidden?: boolean;
}

export interface HomeSnapshot {
  total: number;
  open: number;
  active: number;
  ready: number;
  done: number;
  blocked: number;
  held: number;
  incubating: number;
  on_hold: number;
  leaseUnderFiveMinutes: QueueTaskDto[];
}

export function homeSnapshot(tasks: QueueTaskDto[], now: number): HomeSnapshot {
  const active = tasks.filter((task) => Boolean(task.lease_agent) && ACTIVE_STATES.has(task.state) && (task.lease_expires_at ?? 0) > now);
  const held = tasks.filter((task) => task.state === "HELD").length;
  const incubating = tasks.filter((task) => task.state === "INCUBATING").length;
  return {
    total: tasks.length,
    open: tasks.filter((task) => task.state !== "DONE").length,
    active: active.length,
    ready: tasks.filter((task) => task.state === "QUEUED").length,
    done: tasks.filter((task) => task.state === "DONE").length,
    blocked: tasks.filter((task) => task.state === "BLOCKED").length,
    held,
    incubating,
    on_hold: held + incubating,
    leaseUnderFiveMinutes: active.filter((task) => {
      const remaining = (task.lease_expires_at ?? 0) - now;
      return remaining > 0 && remaining < 5 * 60_000;
    }),
  };
}

/** HELD + INCUBATING rows for the always-visible On hold panel. */
export function onHoldRows(tasks: QueueTaskDto[]): QueueTaskDto[] {
  return tasks
    .filter((task) => ON_HOLD_STATES.has(task.state))
    .sort((a, b) => {
      // Soonest warming first, then HELD by priority, then id for stability.
      if (a.state === "INCUBATING" && b.state === "INCUBATING") {
        const until = (a.incubate_until ?? Number.MAX_SAFE_INTEGER) - (b.incubate_until ?? Number.MAX_SAFE_INTEGER);
        if (until !== 0) return until;
      } else if (a.state === "INCUBATING" && b.state !== "INCUBATING") {
        return -1;
      } else if (a.state !== "INCUBATING" && b.state === "INCUBATING") {
        return 1;
      }
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.id - b.id;
    });
}

export function holdCauseLabel(cause: QueueTaskDto["hold_cause"]): string {
  switch (cause) {
    case "explicit": return "Held by operator";
    case "conflict": return "Held for conflict";
    case "question": return "Held for question";
    case "dependency": return "Held for dependency";
    default: return "On hold";
  }
}

export interface AttentionItem {
  label: string;
  count: number;
  tone: "amber" | "red" | "muted";
}

export function attentionItems(snapshot: HomeSnapshot): AttentionItem[] {
  return [
    { label: "leases expiring soon", count: snapshot.leaseUnderFiveMinutes.length, tone: "amber" as const },
    { label: "stuck", count: snapshot.blocked, tone: "red" as const },
  ].filter((item) => item.count > 0);
}

export function trendPresentation(delta: number): { text: string; direction: "up" | "down" | "steady" } {
  if (delta > 0) return { text: `${delta} more`, direction: "up" };
  if (delta < 0) return { text: `${Math.abs(delta)} fewer`, direction: "down" };
  return { text: "no change", direction: "steady" };
}

export function latestTaskTransitions(transitions: TaskTransitionDto[]): TaskTransitionDto[] {
  const seen = new Set<number>();
  return transitions.filter((transition) => {
    if (seen.has(transition.task_id)) return false;
    seen.add(transition.task_id);
    return true;
  });
}

const STATE_ORDER = new Map<TaskState, number>([
  "EXECUTING", "PLANNED", "CLAIMED", "AWAITING_MERGE", "QUEUED", "BLOCKED", "HELD", "PARKED",
  "INCUBATING", "DONE",
].map((state, index) => [state as TaskState, index]));

export function queueRows(tasks: QueueTaskDto[], filters: QueueFilters): QueueTaskDto[] {
  const filtered = tasks.filter((task) =>
    task.state !== "DONE"
    && (filters.state ? task.state === filters.state : filters.includeHidden || ACTIONABLE_QUEUE_STATES.has(task.state))
    && (!filters.agent || task.lease_agent === filters.agent));
  const multiplier = filters.direction === "asc" ? 1 : -1;
  return filtered.sort((a, b) => {
    if (filters.sort === "priority" && (a.state === "DONE") !== (b.state === "DONE")) {
      return a.state === "DONE" ? 1 : -1;
    }
    let compared = 0;
    switch (filters.sort) {
      case "priority": compared = a.priority - b.priority; break;
      case "updated": compared = a.updated_at - b.updated_at; break;
      case "created": compared = a.created_at - b.created_at; break;
      case "title": compared = a.title.localeCompare(b.title); break;
      case "state": compared = (STATE_ORDER.get(a.state) ?? 99) - (STATE_ORDER.get(b.state) ?? 99); break;
    }
    return compared === 0 ? a.id - b.id : compared * multiplier;
  });
}

export function liveAgentRows(agents: AgentDto[], now: number): AgentDto[] {
  return agents.filter((row) => row.lease_expires_at > now);
}

export function queueAgentOptions(tasks: QueueTaskDto[], agents: AgentDto[], current: string | null): string[] {
  return [...new Set([
    ...tasks.map((task) => task.lease_agent).filter((name): name is string => Boolean(name)),
    ...agents.map((row) => row.agent),
    ...(current ? [current] : []),
  ])].sort((a, b) => a.localeCompare(b));
}

export function hasMultipleActiveAgents(agents: AgentDto[]): boolean {
  return new Set(agents.map((agent) => agent.agent)).size > 1;
}

const ACTION_LABELS: Record<string, string> = {
  accept: "Accepted",
  approved: "Approved",
  clarify: "Clarification requested",
  merge: "Merged",
  revise: "Revision requested",
};

function oneLine(value: string, limit = 96): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > limit ? `${line.slice(0, limit - 1).trimEnd()}…` : line;
}

function plainText(value: string | null): string | null {
  if (!value) return null;
  const line = oneLine(value);
  if (!line || /^[\[{]/.test(line) || /(?:→|:)\s*[\[{]/.test(line)) return null;
  return line;
}

function actionPayload(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function threadSummary(thread: ThreadDto, threads: ThreadDto[]): string {
  const root = thread.root_id == null ? null : threads.find((candidate) => candidate.id === thread.root_id);
  const humanFallback = plainText(thread.first_human_message) ?? plainText(root?.first_human_message ?? null);
  const payload = actionPayload(thread.last_message);
  const action = typeof payload?.action === "string" ? payload.action : typeof payload?.verdict === "string" ? payload.verdict : null;
  if (action) {
    const verb = ACTION_LABELS[action.toLowerCase()] ?? oneLine(action.replaceAll("_", " "), 40);
    const payloadTitle = typeof payload?.title === "string" ? payload.title : typeof payload?.question === "string" ? payload.question : null;
    const title = oneLine(payloadTitle ?? thread.task_title ?? humanFallback ?? `${thread.kind} activity`, 72);
    return [verb, thread.task_id == null ? null : `#${thread.task_id}`, title].filter(Boolean).join(" · ");
  }
  return humanFallback ?? plainText(thread.summary) ?? `${thread.kind.replaceAll("_", " ")} activity`;
}

/** Collapse noisy mediator cycles into recent task or project-session rows. */
export function activityThreadGroups(threads: ThreadDto[], limit = ACTIVITY_GROUP_LIMIT): ActivityThreadGroup[] {
  const taskByRoot = new Map<number, number>();
  for (const thread of threads) {
    if (thread.task_id !== null) taskByRoot.set(thread.root_id ?? thread.id, thread.task_id);
  }
  const groups = new Map<string, ThreadDto[]>();
  for (const thread of threads) {
    const rootId = thread.root_id ?? thread.id;
    const taskId = thread.task_id ?? taskByRoot.get(rootId) ?? null;
    const key = taskId === null ? `session:${rootId}` : `task:${taskId}`;
    const group = groups.get(key) ?? [];
    group.push(thread);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .filter(([key, group]) => key.startsWith("task:") || group.some((thread) => Boolean(thread.first_human_message)))
    .map(([key, group]) => {
      const sorted = [...group].sort((left, right) => right.last_activity - left.last_activity || right.id - left.id);
      const taskId = key.startsWith("task:") ? Number(key.slice("task:".length)) : null;
      const taskTitle = taskId === null
        ? null
        : sorted.find((thread) => thread.task_id === taskId && Boolean(thread.task_title))?.task_title ?? null;
      return { thread: sorted[0], threadIds: sorted.map((thread) => thread.id), taskId, taskTitle };
    })
    .sort((left, right) => right.thread.last_activity - left.thread.last_activity || right.thread.id - left.thread.id)
    .slice(0, Math.max(0, limit));
}

export function taskOutcome(body: string, fallback: string): string {
  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const preferred = lines.find((line) => /^(outcome|goal):/i.test(line)) ?? lines[0];
  const summary = preferred?.replace(/^(outcome|goal):\s*/i, "") ?? fallback;
  return oneLine(summary, 180);
}

/**
 * Split a completion `result_summary` into the free-text summary and the
 * mandatory verification claim written by coder_complete as
 * `${summary}\n\nverification: ${claim}`.
 *
 * Anchors on the *last* `\n\nverification:` so a coder summary that embeds
 * that substring cannot steal the server-appended claim.
 */
export function parseResultSummary(resultSummary: string | null | undefined): {
  summary: string | null;
  verification: string | null;
} {
  if (resultSummary == null || resultSummary === "") {
    return { summary: null, verification: null };
  }
  // Greedy prefix forces the delimiter to the last occurrence.
  const match = /^([\s\S]*)\n\nverification:\s*([\s\S]*)$/i.exec(resultSummary);
  if (match) {
    return {
      summary: match[1].replace(/\s+$/, "") || null,
      verification: match[2].trim() || null,
    };
  }
  if (/^verification:\s*/i.test(resultSummary)) {
    const verification = resultSummary.replace(/^verification:\s*/i, "").trim() || null;
    return { summary: null, verification };
  }
  return { summary: resultSummary, verification: null };
}

export function displayTaskState(state: TaskState): string {
  if (state === "AWAITING_MERGE") return "Awaiting merge";
  return state.replaceAll("_", " ");
}

/** Human labels for machine operational dispositions (queue chips). */
const DISPOSITION_LABELS: Record<string, string> = {
  claimable: "Claimable",
  grooming: "Grooming",
  retrying: "Retrying",
  "awaiting-human": "Awaiting human",
  incubating: "Incubating",
  "explicitly-held": "Held",
  "dependency-ordered": "Waiting on dependency",
  leased: "Leased",
  blocked: "Blocked",
  verifying: "Verifying",
  terminal: "Done",
};

export function displayDisposition(disposition: string): string {
  return DISPOSITION_LABELS[disposition] ?? disposition.replaceAll("-", " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Shared live/SSE connection label for desktop heartbeat and mobile shell. */
export function liveConnectionLabel(status: string): string {
  if (status === "live" || status === "connecting") return "Connected";
  if (status === "reconnecting") return "Retrying";
  if (status === "offline") return "Offline";
  if (status === "unavailable") return "Unavailable";
  return status;
}

/** Merge labels shown next to a PR on the dashboard. */
export type PrMergeLabel = "Open" | "Merged" | "Closed-unmerged" | "Gone";
/** CI labels derived from pr_verification open/merged check snapshots. */
export type PrCiLabel = "Green" | "Pending" | "Failing";

export interface PrPresentation {
  merge: PrMergeLabel | null;
  ci: PrCiLabel | null;
  mergeTone: "neutral" | "success" | "danger" | "warning" | "live";
  ciTone: "neutral" | "success" | "danger" | "warning" | "live";
}

/**
 * Map stored `tasks.pr_verification` into orthogonal merge + CI labels.
 * Null/unknown verification yields nulls — callers gate chrome on result_pr_url.
 * `not-found` (deleted/unreachable PR) gets an explicit neutral "Gone" chip so
 * the row is never a silent bare link.
 */
export function prPresentation(prVerification: string | null | undefined): PrPresentation {
  switch (prVerification) {
    case "open":
      return { merge: "Open", ci: "Green", mergeTone: "live", ciTone: "success" };
    case "checks-pending":
      return { merge: "Open", ci: "Pending", mergeTone: "live", ciTone: "warning" };
    case "checks-failing":
      return { merge: "Open", ci: "Failing", mergeTone: "live", ciTone: "danger" };
    case "merged-green":
      return { merge: "Merged", ci: "Green", mergeTone: "success", ciTone: "success" };
    case "merged-checks-pending":
      return { merge: "Merged", ci: "Pending", mergeTone: "success", ciTone: "warning" };
    case "merged-checks-failing":
      return { merge: "Merged", ci: "Failing", mergeTone: "success", ciTone: "danger" };
    case "closed-unmerged":
      return { merge: "Closed-unmerged", ci: null, mergeTone: "danger", ciTone: "neutral" };
    case "not-found":
      return { merge: "Gone", ci: null, mergeTone: "neutral", ciTone: "neutral" };
    default:
      return { merge: null, ci: null, mergeTone: "neutral", ciTone: "neutral" };
  }
}

export function formatCountdown(expiresAt: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
