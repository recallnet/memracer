export interface ReplayCrossingEvent {
  id: number;
  parent_id: number | null;
  thread_id: number | null;
  task_id: number | null;
  parent_thread_id: number | null;
  parent_task_id: number | null;
  seq: number;
  type: string;
  role: string;
}

export interface ReplayCrossing<T extends ReplayCrossingEvent> {
  arrival: T;
  affected: T;
  outcome: T | undefined;
}

function scopeKey(event: ReplayCrossingEvent): string {
  return `${event.thread_id ?? "null"}:${event.task_id ?? "null"}`;
}

/** Project cross-thread arrivals without rescanning the recording per event. */
export function projectReplayCrossings<T extends ReplayCrossingEvent>(events: T[]): ReplayCrossing<T>[] {
  const nextMediator = new Map<string, T>();
  const nextVerdict = new Map<string, T>();
  const mediatorAfter: Array<T | undefined> = new Array(events.length);
  const verdictAtOrAfter: Array<T | undefined> = new Array(events.length);
  const indexById = new Map<number, number>();

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const key = scopeKey(event);
    indexById.set(event.id, index);
    if (event.type === "verdict") nextVerdict.set(key, event);
    verdictAtOrAfter[index] = nextVerdict.get(key);
    mediatorAfter[index] = nextMediator.get(key);
    if (event.role === "mediator") nextMediator.set(key, event);
  }

  const crossings: ReplayCrossing<T>[] = [];
  for (let index = 0; index < events.length; index += 1) {
    const arrival = events[index];
    const crossed =
      arrival.parent_id !== null &&
      arrival.parent_thread_id !== null &&
      (arrival.parent_thread_id !== arrival.thread_id || arrival.parent_task_id !== arrival.task_id);
    if (!crossed) continue;
    const affected = mediatorAfter[index] ?? arrival;
    const affectedIndex = indexById.get(affected.id) ?? index;
    crossings.push({ arrival, affected, outcome: verdictAtOrAfter[affectedIndex] });
  }
  return crossings;
}

export function groupReplayCrossings<T extends ReplayCrossingEvent>(
  crossings: ReplayCrossing<T>[],
): Map<number, ReplayCrossing<T>[]> {
  const grouped = new Map<number, ReplayCrossing<T>[]>();
  for (const crossing of crossings) {
    const current = grouped.get(crossing.affected.id);
    if (current) current.push(crossing);
    else grouped.set(crossing.affected.id, [crossing]);
  }
  return grouped;
}
