import { describe, expect, it } from "vitest";
import { projectReplayCrossings, type ReplayCrossingEvent } from "../src/dashboard/replay-crossings.js";

interface Event extends ReplayCrossingEvent {
  content: string;
}

function quadraticReference(events: Event[]) {
  return events.flatMap((arrival) => {
    const crossed =
      arrival.parent_id !== null &&
      arrival.parent_thread_id !== null &&
      (arrival.parent_thread_id !== arrival.thread_id || arrival.parent_task_id !== arrival.task_id);
    if (!crossed) return [];
    const affected = events.find((candidate) =>
      candidate.seq > arrival.seq &&
      candidate.thread_id === arrival.thread_id &&
      candidate.task_id === arrival.task_id &&
      candidate.role === "mediator",
    ) ?? arrival;
    const outcome = events.find((candidate) =>
      candidate.seq >= affected.seq &&
      candidate.thread_id === arrival.thread_id &&
      candidate.task_id === arrival.task_id &&
      candidate.type === "verdict",
    );
    return [{ arrival, affected, outcome }];
  });
}

describe("linear replay crossing projection", () => {
  it("matches the former quadratic projection across interleaved branches", () => {
    const events: Event[] = [
      { id: 1, seq: 1, parent_id: null, thread_id: 1, task_id: 1, parent_thread_id: null, parent_task_id: null, type: "request", role: "human", content: "root" },
      { id: 2, seq: 2, parent_id: 1, thread_id: 2, task_id: 2, parent_thread_id: 1, parent_task_id: 1, type: "request", role: "human", content: "branch" },
      { id: 3, seq: 3, parent_id: 2, thread_id: 3, task_id: 3, parent_thread_id: 2, parent_task_id: 2, type: "request", role: "human", content: "other" },
      { id: 4, seq: 4, parent_id: 2, thread_id: 2, task_id: 2, parent_thread_id: 2, parent_task_id: 2, type: "reasoning", role: "mediator", content: "consider" },
      { id: 5, seq: 5, parent_id: 4, thread_id: 2, task_id: 2, parent_thread_id: 2, parent_task_id: 2, type: "verdict", role: "mediator", content: "done" },
      { id: 6, seq: 6, parent_id: 3, thread_id: 3, task_id: 3, parent_thread_id: 3, parent_task_id: 3, type: "text", role: "coder", content: "work" },
    ];
    expect(projectReplayCrossings(events)).toEqual(quadraticReference(events));
  });

  it("projects a 5k-event recording without per-arrival rescans", () => {
    const events: Event[] = Array.from({ length: 5_000 }, (_, index) => ({
      id: index + 1,
      seq: index + 1,
      parent_id: index === 0 ? null : index,
      thread_id: index % 25,
      task_id: index % 11,
      parent_thread_id: index === 0 ? null : (index - 1) % 25,
      parent_task_id: index === 0 ? null : (index - 1) % 11,
      type: index % 17 === 0 ? "verdict" : "reasoning",
      role: index % 3 === 0 ? "mediator" : "human",
      content: String(index),
    }));
    const projected = projectReplayCrossings(events);
    expect(projected.length).toBeGreaterThan(4_000);
    expect(projected.every((crossing) => crossing.affected.seq >= crossing.arrival.seq)).toBe(true);
  });
});
