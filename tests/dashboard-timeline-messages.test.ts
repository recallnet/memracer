// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { mergeFrame, reduceFrames, type Frame, type FrameMeta } from "../src/dashboard/island/index.js";

function meta(timelineOrder: number, eventId: number, role: string): FrameMeta {
  return {
    timelineOrder,
    eventId,
    seq: timelineOrder,
    parentId: null,
    threadId: 1,
    taskId: 2,
    role,
    author: role,
    startTime: timelineOrder,
    endTime: null,
    status: "pending",
  };
}

describe("dashboard timeline messages", () => {
  it("marks only an assistant tail as running", () => {
    const assistant = { type: "text-delta", id: "1", kind: "text", delta: "working", ...meta(1, 1, "mediator") } satisfies Frame;
    expect(reduceFrames([assistant], true)[0]).toMatchObject({ role: "assistant", status: { type: "running" } });

    for (const role of ["coder", "human", "system"]) {
      const tail = { type: "start-step", id: role, text: "input", ...meta(2, 2, role) } satisfies Frame;
      const messages = reduceFrames([assistant, tail], true);
      expect(messages.at(-1)?.role).not.toBe("assistant");
      expect(messages.every((message) => message.status == null)).toBe(true);
    }

    const coderTool = { type: "tool-input-available", id: "3", toolCallId: "3", input: JSON.stringify({ action: "verify" }), ...meta(3, 3, "coder") } satisfies Frame;
    expect(reduceFrames([assistant, coderTool], true).at(-1)).toMatchObject({
      role: "assistant",
      status: { type: "running" },
      metadata: { custom: { actor: "coder" } },
    });
  });

  it("accumulates new delta chunks, replaces reconnect replays, and keeps message ids unique", () => {
    const first = { type: "text-delta", id: "42", kind: "text", delta: "hello ", ...meta(1, 42, "mediator") } satisfies Frame;
    const second = { type: "text-delta", id: "42", kind: "text", delta: "world", ...meta(2, 42, "mediator") } satisfies Frame;
    const merged = mergeFrame(mergeFrame([], first), second);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ delta: "hello world" });

    const replayStart = mergeFrame(merged, first);
    const replayed = mergeFrame(replayStart, second);
    expect(replayed).toHaveLength(1);
    expect(replayed[0]).toMatchObject({ delta: "hello world" });

    const start = { type: "start-step", id: "42", text: "request", ...meta(0, 42, "human") } satisfies Frame;
    const messages = reduceFrames([start, ...merged], false);
    expect(messages.map((message) => message.id)).toEqual(["start-step-42", "text-delta-42"]);
    expect(new Set(messages.map((message) => message.id)).size).toBe(messages.length);
  });

});
