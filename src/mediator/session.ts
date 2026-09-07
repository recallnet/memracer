import type { Db } from "../db.js";

/** The Vercel AI-SDK-shaped event kinds a mediator session is built from. */
export type SessionEventType =
  | "request"
  | "reasoning"
  | "tool_call"
  | "tool_result"
  | "clarification_q"
  | "clarification_a"
  | "verdict"
  | "text";

export interface SessionEventInput {
  type: SessionEventType;
  role: "human" | "coder" | "mediator" | "system";
  author: string;
  /** Text, or a JSON payload for tool_call/tool_result/verdict events. */
  content: string;
  status?: "ok" | "error" | "pending";
}

export interface SessionEventRow {
  id: number;
  project_id: string;
  session_id: number;
  parent_id: number | null;
  thread_id: number | null;
  task_id: number | null;
  seq: number;
  type: SessionEventType;
  role: string;
  author: string;
  content: string;
  status: string;
  start_time: number;
  end_time: number | null;
}

/**
 * Appends one ordered, typed, parent-linked run of events to a session (the
 * owning root thread). Continues the session's seq and clock from whatever is
 * already stored, so a groom-with-clarification spread across several jobs
 * reads back as ONE monotonic stream. Timestamps are forced strictly
 * increasing — two events written inside the same Date.now() millisecond
 * still get distinct, ordered times — so a UI that sorts by time never sees
 * the old "everything shares one Date.now()" collapse.
 *
 * @param firstParentEventId  For a forked child task: the parent task's last
 *   event id, so the child's first event branches off it via parent_id.
 * @returns the inserted rows' ids, in order.
 */
export async function appendSessionEvents(
  db: Db,
  opts: {
    projectId: string;
    sessionId: number;
    threadId: number | null;
    taskId: number | null;
    firstParentEventId?: number | null;
  },
  events: SessionEventInput[],
): Promise<number[]> {
  if (events.length === 0) return [];
  const head = await db
    .prepare(
      "SELECT MAX(seq) AS max_seq, MAX(end_time) AS max_end FROM session_events WHERE session_id = ?",
    )
    .get<{ max_seq: number | null; max_end: number | null }>(opts.sessionId);
  let seq = (head?.max_seq ?? 0) + 1;
  let clock = head?.max_end ?? 0;
  const stmt = db.prepare(
    `INSERT INTO session_events
       (project_id, session_id, parent_id, thread_id, task_id, seq, type, role, author, content, status, start_time, end_time)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  );
  const ids: number[] = [];
  let prevId: number | null = opts.firstParentEventId ?? null;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    // Strictly-increasing real clock: never reuse or go backwards.
    const start = Math.max(Date.now(), clock + 1);
    clock = start;
    // First event links to the fork parent (if any); the rest chain to the
    // previous event so the run is a connected branch.
    const parentId = i === 0 ? (opts.firstParentEventId ?? null) : prevId;
    const row = await stmt.get<{ id: number }>(
      opts.projectId,
      opts.sessionId,
      parentId,
      opts.threadId,
      opts.taskId,
      seq,
      e.type,
      e.role,
      e.author,
      e.content,
      e.status ?? "ok",
      start,
      start,
    );
    prevId = row!.id;
    ids.push(row!.id);
    seq++;
  }
  return ids;
}

/** The session a thread belongs to: its root, or itself when it is the root. */
export function sessionIdForThread(thread: { id: number; root_id: number | null }): number {
  return thread.root_id ?? thread.id;
}

/** Last event id recorded for a task — the branch point a fork hangs off. */
export async function lastEventForTask(db: Db, taskId: number): Promise<number | null> {
  const row = await db
    .prepare("SELECT id FROM session_events WHERE task_id = ? ORDER BY seq DESC LIMIT 1")
    .get<{ id: number }>(taskId);
  return row?.id ?? null;
}
