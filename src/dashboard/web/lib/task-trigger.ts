export function resolveTaskTrigger(taskId: number | null, preferred: HTMLElement | null): HTMLElement | null {
  if (taskId == null) return null;
  const expected = String(taskId);
  const matches = (node: HTMLElement) =>
    node.isConnected
    && node.dataset.taskTrigger === expected
    && node.getClientRects().length > 0;
  if (preferred && matches(preferred)) return preferred;
  return [...document.querySelectorAll<HTMLElement>(`[data-task-trigger="${expected}"]`)].find(matches) ?? null;
}
