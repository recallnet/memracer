/**
 * Canonical human-attention definition shared by human_status, the dashboard
 * NeedsYou panel, and Web Push delivery. One builder owns the taxonomy so the
 * three surfaces cannot silently disagree about what needs a human.
 */
import type { AttentionAlert, AttentionAlertService } from "./attention-alerts.js";
import type { ConversationView } from "./conversations.js";
import type { Db } from "./db.js";

export type HumanAttentionKind =
  | "queue_alert"
  | "question"
  | "conversation"
  | "blocked"
  | "lease";

export interface HumanAttentionItem {
  episode_id: string;
  kind: HumanAttentionKind;
  project: string;
  project_name?: string;
  task_id: number | null;
  title: string;
  reason: string;
  recovery: string;
  question_id?: number;
  conversation_id?: number;
  badge?: string;
  state?: string;
  actor_name?: string;
  actor_role?: "human" | "coder" | "mediator" | "system";
  expires_at?: number;
  /** When false, surface in dashboard / human_status but do not push. */
  pushable: boolean;
  task_uri: string | null;
  dashboard_url: string | null;
}

export interface HumanAttentionInput {
  projectIds: string[];
  projectNames?: Map<string, string>;
  /** Member name used to decide which open conversations still need a reply. */
  memberName?: string;
  publicUrl?: string;
  now?: number;
  /** Include expiring leases (dashboard parity). Default true for dashboard; human_status may omit. */
  includeLeases?: boolean;
  /** Include BLOCKED tasks without an open question. Default true for dashboard. */
  includeBlocked?: boolean;
}

function oneLine(value: string, maxLength = 240): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

/** Human-actionable blocks only — system-domain kinds are not Needs-You work. */
export function isHumanActionableBlock(blockKind: string | null | undefined): boolean {
  return blockKind == null || blockKind === "human";
}

/**
 * Human-facing reason for a BLOCKED attention item. Never pass through raw
 * attempt notes or error strings (info-disclosure: host paths, env names, stacks).
 */
export function humanBlockedReason(blockKind: string | null | undefined): string {
  switch (blockKind) {
    case "dependency":
      return "Waiting on another task.";
    case "infra_failure":
      return "Blocked on infrastructure — an operator will retry.";
    case "human":
    default:
      return "This task needs a decision from you.";
  }
}

/**
 * Public-facing attempt note for dashboard/API surfaces. System-domain blocks
 * never expose raw coder diagnostics; human blocks keep the note.
 */
export function publicAttemptNote(
  notes: string | null | undefined,
  opts: { blockKind?: string | null; blocked?: boolean } = {},
): string | null {
  if (opts.blocked && !isHumanActionableBlock(opts.blockKind)) {
    return humanBlockedReason(opts.blockKind);
  }
  return notes ?? null;
}

export function attentionDashboardUrl(
  publicUrl: string | undefined,
  projectId: string,
  opts: { taskId?: number | null; questionId?: number; conversationId?: number } = {},
): string | null {
  if (!publicUrl) return null;
  try {
    const url = new URL(publicUrl);
    url.searchParams.set("project", projectId);
    if (opts.taskId != null) url.searchParams.set("task", String(opts.taskId));
    if (opts.questionId != null) url.searchParams.set("question", String(opts.questionId));
    if (opts.conversationId != null) url.searchParams.set("conversation", String(opts.conversationId));
    return url.toString();
  } catch {
    return null;
  }
}

function compactQueueAttention(alert: AttentionAlert): HumanAttentionItem {
  return {
    episode_id: alert.episode_id,
    kind: "queue_alert",
    project: alert.project,
    project_name: alert.project_name,
    task_id: alert.task_id,
    title: oneLine(alert.task_title, 160),
    reason: oneLine(alert.reason),
    recovery: oneLine(alert.recovery),
    badge: "QUEUED",
    state: "QUEUED",
    pushable: true,
    task_uri: alert.task_uri,
    dashboard_url: alert.dashboard_url,
  };
}

/** Lower rank = higher severity. Needs-You shows blocked/questions/conflicts before leases. */
const KIND_SEVERITY: Record<HumanAttentionKind, number> = {
  blocked: 0,
  question: 1,
  conversation: 2,
  queue_alert: 3,
  lease: 4,
};

function sortAttention(items: HumanAttentionItem[]): HumanAttentionItem[] {
  return items.slice().sort((left, right) => {
    const severity = KIND_SEVERITY[left.kind] - KIND_SEVERITY[right.kind];
    if (severity !== 0) return severity;
    const leftTask = left.task_id ?? Number.MAX_SAFE_INTEGER;
    const rightTask = right.task_id ?? Number.MAX_SAFE_INTEGER;
    return (
      leftTask - rightTask ||
      left.project.localeCompare(right.project) ||
      (left.question_id ?? -1) - (right.question_id ?? -1) ||
      (left.conversation_id ?? -1) - (right.conversation_id ?? -1) ||
      left.episode_id.localeCompare(right.episode_id)
    );
  });
}

/**
 * Build the canonical attention list for the given projects.
 * Queue episodes come from AttentionAlertService (durable episodes).
 * Open questions, conversations awaiting the member, blocked tasks, and
 * expiring leases are derived from live rows under the same shape.
 */
export async function listHumanAttention(
  db: Db,
  attentionAlerts: AttentionAlertService,
  opts: HumanAttentionInput,
): Promise<HumanAttentionItem[]> {
  const projectIds = opts.projectIds;
  if (projectIds.length === 0) return [];
  const now = opts.now ?? Date.now();
  const publicUrl = opts.publicUrl;
  const projectNames = opts.projectNames ?? new Map<string, string>();
  const includeLeases = opts.includeLeases ?? true;
  const includeBlocked = opts.includeBlocked ?? true;
  const placeholders = projectIds.map(() => "?").join(",");

  // queue_alert episodes stay in AttentionAlertService for internal queue
  // mechanics only — they must not appear on Needs-You / human_status push
  // (product 2026-07-23: Needs-You is human-decision items only).
  void attentionAlerts;
  const items: HumanAttentionItem[] = [];
  const claimedTasks = new Set<number>();

  const openQuestions = await db
    .prepare(
      `SELECT q.id, q.task_id, q.asked_by, q.question, q.project_id,
              t.title AS task_title, t.state AS task_state, t.block_kind AS block_kind
       FROM questions q
       LEFT JOIN tasks t ON t.id = q.task_id
       WHERE q.status = 'open' AND q.project_id IN (${placeholders})`,
    )
    .all<{
      id: number;
      task_id: number | null;
      asked_by: string;
      question: string;
      project_id: string;
      task_title: string | null;
      task_state: string | null;
      block_kind: string | null;
    }>(...projectIds);

  // Match NeedsYou's previous open-question filter: drop resolved-looking text
  // and pure mediator statements without a question mark (except non-mediator).
  const visibleQuestions = openQuestions.filter(
    (question) =>
      !/^(?:answered|decided|resolved|resolution)\s*:/i.test(question.question) &&
      (question.question.includes("?") || question.asked_by !== "mediator"),
  );

  for (const question of visibleQuestions) {
    // Same system-domain exclusion as the no-question blocked path (#469/#477).
    const isBlocked =
      question.task_id != null &&
      question.task_state === "BLOCKED" &&
      isHumanActionableBlock(question.block_kind);
    items.push({
      episode_id: `question:${question.id}`,
      kind: isBlocked ? "blocked" : "question",
      project: question.project_id,
      project_name: projectNames.get(question.project_id),
      task_id: question.task_id,
      // Title stays the task/project label (human_status contract); reason is the ask.
      title: oneLine(
        question.task_title ??
          `Project question · ${projectNames.get(question.project_id) ?? question.project_id}`,
        160,
      ),
      // Prefer the open question text; never fall back to raw attempt notes.
      reason: oneLine(
        question.question ||
          (isBlocked ? humanBlockedReason(question.block_kind) : "Open question"),
      ),
      recovery: `Answer question #${question.id} with human_answer.`,
      question_id: question.id,
      badge: isBlocked ? "BLOCKED" : "QUESTION",
      state: isBlocked ? "BLOCKED" : "REVIEW",
      actor_name: question.asked_by,
      actor_role: question.asked_by === "mediator" ? "mediator" : "human",
      pushable: true,
      task_uri: question.task_id == null ? null : `task://${question.task_id}`,
      dashboard_url: attentionDashboardUrl(publicUrl, question.project_id, {
        taskId: question.task_id,
        questionId: question.id,
      }),
    });
    if (question.task_id != null) claimedTasks.add(question.task_id);
  }

  // BLOCKED tasks with no open question still need human attention in the panel —
  // but only human-actionable kinds. System-domain blocks (infra_failure,
  // dependency) are not actionable by humans and must not leak internal notes.
  if (includeBlocked) {
    const blocked = await db
      .prepare(
        `SELECT id, project_id, title, submitted_by, block_kind
         FROM tasks
         WHERE state = 'BLOCKED'
           AND project_id IN (${placeholders})
           AND (block_kind IS NULL OR block_kind = 'human')`,
      )
      .all<{
        id: number;
        project_id: string;
        title: string;
        submitted_by: string;
        block_kind: string | null;
      }>(...projectIds);
    for (const task of blocked) {
      if (claimedTasks.has(task.id)) continue;
      items.push({
        episode_id: `blocked:${task.id}`,
        kind: "blocked",
        project: task.project_id,
        project_name: projectNames.get(task.project_id),
        task_id: task.id,
        title: oneLine(task.title, 160),
        // Never surface raw attempt notes / error strings on the human Needs-You path.
        reason: humanBlockedReason(task.block_kind),
        recovery: "Answer the open question or unblock the task.",
        badge: "BLOCKED",
        state: "BLOCKED",
        actor_name: task.submitted_by,
        actor_role: "human",
        pushable: true,
        task_uri: `task://${task.id}`,
        dashboard_url: attentionDashboardUrl(publicUrl, task.project_id, { taskId: task.id }),
      });
      claimedTasks.add(task.id);
    }
  }

  // Open conflict conversations that still need a reply from this member (or any
  // participant when member is unknown — human_status has no single member id).
  const openConversations = await db
    .prepare(
      `SELECT c.id, c.project_id, c.topic, c.deadline
       FROM conversations c
       WHERE c.state = 'OPEN' AND c.project_id IN (${placeholders})
       ORDER BY c.id DESC`,
    )
    .all<{ id: number; project_id: string; topic: string; deadline: number }>(...projectIds);

  for (const conversation of openConversations) {
    const participants = await db
      .prepare(
        "SELECT member, replied_at FROM conversation_participants WHERE conversation_id = ?",
      )
      .all<{ member: string; replied_at: number | null }>(conversation.id);
    if (opts.memberName) {
      const me = participants.find((p) => p.member === opts.memberName);
      if (!me || me.replied_at != null) continue;
    } else {
      // Without a member filter (MCP status across keys), surface if anyone is awaiting.
      if (!participants.some((p) => p.replied_at == null)) continue;
    }
    const taskIds = await db
      .prepare("SELECT task_id FROM conversation_tasks WHERE conversation_id = ?")
      .all<{ task_id: number }>(conversation.id);
    const firstTask = taskIds[0]?.task_id ?? null;
    items.push({
      episode_id: `conversation:${conversation.id}`,
      kind: "conversation",
      project: conversation.project_id,
      project_name: projectNames.get(conversation.project_id),
      task_id: firstTask,
      title: oneLine(conversation.topic, 160),
      reason: oneLine(`Conflict conversation needs your reply (deadline ${new Date(conversation.deadline).toISOString()}).`),
      recovery: "Reply with human_conversation_reply.",
      conversation_id: conversation.id,
      badge: "CONFLICT",
      state: "REVIEW",
      pushable: true,
      task_uri: firstTask == null ? null : `task://${firstTask}`,
      dashboard_url: attentionDashboardUrl(publicUrl, conversation.project_id, {
        taskId: firstTask,
        conversationId: conversation.id,
      }),
    });
  }

  if (includeLeases) {
    const leaseHorizon = now + 5 * 60_000;
    const leases = await db
      .prepare(
        `SELECT id, project_id, title, lease_agent, lease_expires_at
         FROM tasks
         WHERE project_id IN (${placeholders})
           AND lease_agent IS NOT NULL
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at > ?
           AND lease_expires_at < ?`,
      )
      .all<{
        id: number;
        project_id: string;
        title: string;
        lease_agent: string;
        lease_expires_at: number;
      }>(...projectIds, now, leaseHorizon);
    for (const task of leases) {
      if (claimedTasks.has(task.id)) continue;
      items.push({
        episode_id: `lease:${task.id}:${task.lease_expires_at}`,
        kind: "lease",
        project: task.project_id,
        project_name: projectNames.get(task.project_id),
        task_id: task.id,
        title: oneLine(task.title, 160),
        reason: "Lease expires soon.",
        recovery: "Coder should heartbeat or complete; humans may release if stranded.",
        badge: "LEASE",
        state: "CLAIMED",
        actor_name: task.lease_agent,
        actor_role: "coder",
        expires_at: task.lease_expires_at,
        pushable: false,
        task_uri: `task://${task.id}`,
        dashboard_url: attentionDashboardUrl(publicUrl, task.project_id, { taskId: task.id }),
      });
    }
  }

  return sortAttention(items);
}

/** Presentation shape for human_status (keeps prior field set + optional kind). */
export function presentHumanStatusAttention(item: HumanAttentionItem): Record<string, unknown> {
  return {
    episode_id: item.episode_id,
    kind: item.kind,
    project: item.project,
    task_id: item.task_id,
    title: item.title,
    reason: item.reason,
    recovery: item.recovery,
    ...(item.question_id != null ? { question_id: item.question_id } : {}),
    ...(item.conversation_id != null ? { conversation_id: item.conversation_id } : {}),
    pushable: item.pushable,
    task_uri: item.task_uri,
    dashboard_url: item.dashboard_url,
  };
}

// Re-export type used by callers that only need the conversation list shape
// without pulling Conversations service.
export type { ConversationView };
