import type { Db } from "./db.js";
import type { Queue } from "./queue.js";

/** One day in ms — the unit conversation timeouts are expressed in (never seconds). */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Default conversation lifetime, in DAYS (human-latency work — a coder-second
 * timeout would be absurd). The one place the default lives; per-conversation
 * overrides pass timeoutDays to open(). Env-tunable, never hardcoded at a call
 * site.
 */
export const DEFAULT_CONVERSATION_TIMEOUT_DAYS = Number(
  process.env.MEMRACER_CONVERSATION_TIMEOUT_DAYS ?? 3,
);

export interface OpenConversationInput {
  /** One-line description of the conflict being resolved. */
  topic: string;
  /** The 2+ conflicting tasks the conversation is about. */
  taskIds: number[];
  /** The members invited to weigh in (the submitters of the conflicting tasks). */
  participants: string[];
  /** Per-conversation timeout in days; defaults to DEFAULT_CONVERSATION_TIMEOUT_DAYS. */
  timeoutDays?: number;
  /** Opening message seeded onto the thread (mediator framing of the conflict). */
  opening?: string;
}

export interface ConversationParticipant {
  member: string;
  replied_at: number | null;
}

export interface ConversationMessage {
  role: string;
  author: string;
  content: string;
  created_at: number;
}

export interface ConversationRow {
  id: number;
  project_id: string;
  thread_id: number;
  topic: string;
  state: "OPEN" | "CLOSED" | "EXPIRED";
  deadline: number;
  summary: string | null;
  created_at: number;
  closed_at: number | null;
}

export interface ConversationView extends ConversationRow {
  participants: ConversationParticipant[];
  task_ids: number[];
  messages: ConversationMessage[];
  decision_ids: number[];
}

export interface ConversationSummary extends ConversationRow {
  participants: ConversationParticipant[];
  task_ids: number[];
  message_count: number;
  decision_count: number;
}

/**
 * The conflict-conversation entity. Its lifecycle (participants, deadline,
 * OPEN->CLOSED/EXPIRED state) lives in the conversations tables; every message
 * is a thread_messages row on the anchor thread, so the conversation reuses the
 * threads/thread_messages topology (task 27) rather than inventing a message
 * store. Mutations fire the queue change signal so the dashboard SSE updates.
 */
export class ConversationStore {
  constructor(
    private readonly db: Db,
    private readonly queue: Queue,
  ) {}

  async open(projectId: string, input: OpenConversationInput): Promise<number> {
    const now = Date.now();
    const days = input.timeoutDays ?? DEFAULT_CONVERSATION_TIMEOUT_DAYS;
    const deadline = now + days * DAY_MS;
    const id = await this.db.transaction(async () => {
      // Anchor thread: a task-less 'discuss' root holding the conversation's
      // messages (reuse of the existing thread topology — no new thread kind).
      const thread = await this.db
        .prepare(
          "INSERT INTO threads (project_id, kind, task_id, root_id, created_at, summary) VALUES (?, 'discuss', NULL, NULL, ?, ?) RETURNING id",
        )
        .get<{ id: number }>(projectId, now, input.topic);
      const threadId = thread!.id;
      const conv = await this.db
        .prepare(
          `INSERT INTO conversations (project_id, thread_id, topic, state, deadline, created_at)
           VALUES (?, ?, ?, 'OPEN', ?, ?) RETURNING id`,
        )
        .get<{ id: number }>(projectId, threadId, input.topic, deadline, now);
      const convId = conv!.id;
      const partStmt = this.db.prepare(
        "INSERT INTO conversation_participants (conversation_id, member, replied_at) VALUES (?, ?, NULL)",
      );
      for (const member of [...new Set(input.participants)]) {
        await partStmt.run(convId, member);
      }
      const taskStmt = this.db.prepare(
        "INSERT INTO conversation_tasks (conversation_id, task_id) VALUES (?, ?)",
      );
      for (const taskId of [...new Set(input.taskIds)]) {
        await taskStmt.run(convId, taskId);
      }
      if (input.opening) {
        await this.db
          .prepare(
            "INSERT INTO thread_messages (thread_id, role, author, content, created_at) VALUES (?, 'mediator', 'mediator', ?, ?)",
          )
          .run(threadId, input.opening, now);
      }
      return convId;
    });
    this.queue.notifyChanged(projectId);
    // Best-effort Web Push for conflict conversations (task #418). Await so
    // push DB work cannot interleave with a later Postgres transaction.
    const { scheduleProjectAttentionPush } = await import("./push-dispatch.js");
    await scheduleProjectAttentionPush(this.db, projectId);
    return id;
  }

  private async row(conversationId: number): Promise<ConversationRow | undefined> {
    return this.db
      .prepare(
        "SELECT id, project_id, thread_id, topic, state, deadline, summary, created_at, closed_at FROM conversations WHERE id = ?",
      )
      .get<ConversationRow>(conversationId);
  }

  /** True when the member is a participant of the conversation. */
  async isParticipant(conversationId: number, member: string): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT 1 AS ok FROM conversation_participants WHERE conversation_id = ? AND member = ?")
      .get<{ ok: number }>(conversationId, member);
    return !!row;
  }

  /**
   * Record a participant's reply: append it as a thread message and stamp the
   * participant's replied_at. Throws when the conversation is not OPEN or the
   * caller is not a participant — a reply to a settled conversation, or from a
   * bystander, is a caller error, not a silent no-op.
   */
  async reply(conversationId: number, member: string, content: string): Promise<ConversationView> {
    const projectId = await this.db.transaction(async () => {
      const conv = await this.row(conversationId);
      if (!conv) throw new Error(`conversation ${conversationId} not found`);
      if (conv.state !== "OPEN") {
        throw new Error(`conversation ${conversationId} is ${conv.state}, not OPEN`);
      }
      if (!(await this.isParticipant(conversationId, member))) {
        throw new Error(`${member} is not a participant of conversation ${conversationId}`);
      }
      const now = Date.now();
      await this.db
        .prepare(
          "INSERT INTO thread_messages (thread_id, role, author, content, created_at) VALUES (?, 'human', ?, ?, ?)",
        )
        .run(conv.thread_id, member, content, now);
      await this.db
        .prepare("UPDATE conversation_participants SET replied_at = ? WHERE conversation_id = ? AND member = ?")
        .run(now, conversationId, member);
      return conv.project_id;
    });
    this.queue.notifyChanged(projectId);
    return (await this.get(conversationId))!;
  }

  /** Append a mediator message to a conversation's thread (framing, settlement). */
  async addMediatorMessage(conversationId: number, content: string): Promise<void> {
    const conv = await this.row(conversationId);
    if (!conv) throw new Error(`conversation ${conversationId} not found`);
    await this.db
      .prepare(
        "INSERT INTO thread_messages (thread_id, role, author, content, created_at) VALUES (?, 'mediator', 'mediator', ?, ?)",
      )
      .run(conv.thread_id, content, Date.now());
    this.queue.notifyChanged(conv.project_id);
  }

  private async participantsOf(conversationId: number): Promise<ConversationParticipant[]> {
    return this.db
      .prepare(
        "SELECT member, replied_at FROM conversation_participants WHERE conversation_id = ? ORDER BY member",
      )
      .all<ConversationParticipant>(conversationId);
  }

  private async taskIdsOf(conversationId: number): Promise<number[]> {
    const rows = await this.db
      .prepare("SELECT task_id FROM conversation_tasks WHERE conversation_id = ? ORDER BY task_id")
      .all<{ task_id: number }>(conversationId);
    return rows.map((r) => r.task_id);
  }

  private async decisionIdsOf(conversationId: number): Promise<number[]> {
    const rows = await this.db
      .prepare("SELECT decision_id FROM conversation_decisions WHERE conversation_id = ? ORDER BY decision_id")
      .all<{ decision_id: number }>(conversationId);
    return rows.map((r) => r.decision_id);
  }

  /** True once every participant has replied at least once. */
  async allReplied(conversationId: number): Promise<boolean> {
    const parts = await this.participantsOf(conversationId);
    return parts.length > 0 && parts.every((p) => p.replied_at != null);
  }

  async get(conversationId: number): Promise<ConversationView | undefined> {
    const conv = await this.row(conversationId);
    if (!conv) return undefined;
    const messages = await this.db
      .prepare(
        "SELECT role, author, content, created_at FROM thread_messages WHERE thread_id = ? ORDER BY id ASC",
      )
      .all<ConversationMessage>(conv.thread_id);
    return {
      ...conv,
      participants: await this.participantsOf(conversationId),
      task_ids: await this.taskIdsOf(conversationId),
      messages,
      decision_ids: await this.decisionIdsOf(conversationId),
    };
  }

  /** Conversation summaries for a project (all states), newest first. */
  async listForProject(projectId: string): Promise<ConversationSummary[]> {
    const rows = await this.db
      .prepare(
        "SELECT id, project_id, thread_id, topic, state, deadline, summary, created_at, closed_at FROM conversations WHERE project_id = ? ORDER BY id DESC",
      )
      .all<ConversationRow>(projectId);
    return Promise.all(rows.map((r) => this.summarize(r)));
  }

  /** Open conversations across a set of projects — the human_status surface. */
  async listOpenForProjects(projectIds: string[]): Promise<ConversationView[]> {
    if (projectIds.length === 0) return [];
    const rows = await this.db
      .prepare(
        `SELECT id FROM conversations WHERE state = 'OPEN' AND project_id IN (${projectIds.map(() => "?").join(",")}) ORDER BY id DESC`,
      )
      .all<{ id: number }>(...projectIds);
    const views = await Promise.all(rows.map((r) => this.get(r.id)));
    return views.filter((v): v is ConversationView => v !== undefined);
  }

  private async summarize(r: ConversationRow): Promise<ConversationSummary> {
    const thread = r.thread_id;
    const { n: message_count } = (await this.db
      .prepare("SELECT COUNT(*) AS n FROM thread_messages WHERE thread_id = ?")
      .get<{ n: number }>(thread)) as { n: number };
    return {
      ...r,
      participants: await this.participantsOf(r.id),
      task_ids: await this.taskIdsOf(r.id),
      message_count,
      decision_count: (await this.decisionIdsOf(r.id)).length,
    };
  }

  /** OPEN conversations whose deadline has struck — the timeout sweep's input. */
  async dueForTimeout(now: number = Date.now()): Promise<{ id: number; project_id: string }[]> {
    return this.db
      .prepare(
        "SELECT id, project_id FROM conversations WHERE state = 'OPEN' AND deadline <= ? ORDER BY id ASC",
      )
      .all<{ id: number; project_id: string }>(now);
  }

  /**
   * Close a conversation: set the terminal state (CLOSED when settled, EXPIRED
   * on timeout), the settlement summary, and closed_at. State-guarded on OPEN
   * so a double-close (early settle racing the timeout sweep) safely no-ops.
   */
  async close(
    conversationId: number,
    state: "CLOSED" | "EXPIRED",
    summary: string,
  ): Promise<boolean> {
    const now = Date.now();
    const res = await this.db
      .prepare(
        "UPDATE conversations SET state = ?, summary = ?, closed_at = ? WHERE id = ? AND state = 'OPEN'",
      )
      .run(state, summary, now, conversationId);
    if (res.changes === 0) return false;
    const conv = await this.row(conversationId);
    if (conv) this.queue.notifyChanged(conv.project_id);
    return true;
  }

  /** Link a decision_log entry to this conversation (close-provenance). */
  async linkDecision(conversationId: number, decisionId: number): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO conversation_decisions (conversation_id, decision_id) VALUES (?, ?)",
      )
      .run(conversationId, decisionId);
  }
}
