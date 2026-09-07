/**
 * Default conversation session for a task detail sheet.
 * Prefer groom/review/answer/… over a bare submission root so legacy orphan
 * roots (threads.task_id NULL, empty messages) do not blank the Activity pane
 * when linked task threads exist (#462 / #499 class).
 * `threads` is expected newest-first (API ORDER BY id DESC).
 */
export function preferTaskConversationThread(
  threads: Array<{ id: number; kind: string }>,
  rootThreadId: number | null,
): number | null {
  const linked = threads.find((thread) => thread.kind !== "submission");
  if (linked) return linked.id;
  if (threads[0]) return threads[0].id;
  return rootThreadId;
}
