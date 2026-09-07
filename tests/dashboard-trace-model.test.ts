import { describe, expect, it } from "vitest";
import { buildTraceGraph, projectGenAiLifecycles, replayTrace, type TraceFrame } from "../src/dashboard/trace-model.js";

const frames: TraceFrame[] = [
  { type: "start", timelineOrder: 0 },
  { type: "start-step", timelineOrder: 1, eventId: 10, parentId: null, threadId: 4, taskId: 7, role: "human", author: "ada", status: "ok", startTime: 10 },
  { type: "reasoning-delta", timelineOrder: 2, eventId: 11, parentId: 10, threadId: 4, taskId: 7, role: "mediator", author: "pi", status: "ok", startTime: 11 },
  { type: "tool-input-available", timelineOrder: 3, eventId: 12, parentId: 11, threadId: 4, taskId: 7, role: "mediator", author: "pi", status: "ok", toolCallId: "12", input: JSON.stringify({ tool: "queue.update", action: "queue.claim" }), startTime: 12 },
  { type: "tool-output-available", timelineOrder: 4, eventId: 13, parentId: 12, threadId: 4, taskId: 7, role: "mediator", author: "pi", status: "ok", toolCallId: "12", startTime: 13 },
  { type: "start-step", timelineOrder: 5, eventId: 14, parentId: 13, threadId: 8, taskId: 7, role: "coder", author: "codex", status: "ok", startTime: 14 },
  { type: "start-step", timelineOrder: 6, eventId: 15, parentId: 13, threadId: 9, taskId: 9, role: "coder", author: "codex", status: "pending", startTime: 15 },
  { type: "finish", timelineOrder: 7 },
];

describe("dashboard causal trace model", () => {
  it("builds directed causal, handoff, and fork edges from recorded ancestry", () => {
    const graph = buildTraceGraph(frames);
    expect(graph.nodes.map((node) => node.eventId)).toEqual([10, 11, 12, 13, 14, 15]);
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: "event-10", to: "event-11", kind: "handoff" }),
      expect.objectContaining({ from: "event-13", to: "event-14", kind: "handoff" }),
      expect.objectContaining({ from: "event-13", to: "event-15", kind: "fork" }),
    ]));
  });

  it("rewinds actor state and identifies future events at each cutoff", () => {
    const graph = buildTraceGraph(frames);
    const mediatorTurn = replayTrace(graph, 2);
    expect(mediatorTurn.current).toMatchObject({ eventId: 11, actor: "mediator", eventType: "reasoning" });
    expect([...mediatorTurn.futureEventIds]).toEqual([12, 13, 14, 15]);
    expect(mediatorTurn.actorStates.map((state) => state.actor)).toEqual(["human", "mediator"]);
    expect(mediatorTurn.recordingEnded).toBe(false);

    const end = replayTrace(graph, 7, 7);
    expect(end.current?.eventId).toBe(15);
    expect(end.actorStates.at(-1)).toMatchObject({ actor: "coder", status: "pending" });
    expect(end.recordingEnded).toBe(true);

    expect(replayTrace(graph, 6, 7).recordingEnded).toBe(false);
  });

  it("does not call an open transport snapshot complete", () => {
    const openFrames = frames.filter((frame) => frame.type !== "finish");
    const graph = buildTraceGraph(openFrames);
    expect(replayTrace(graph, 99, null).recordingEnded).toBe(false);
  });

  it("folds rows into OTel agent/tool lifecycles without fabricating spans", () => {
    const projected = projectGenAiLifecycles(frames, 4);
    const agents = projected.lifecycles.filter((lifecycle) => lifecycle.kind === "agent");
    const tools = projected.lifecycles.filter((lifecycle) => lifecycle.kind === "tool");
    expect(agents).toHaveLength(3);
    expect(agents[0]).toMatchObject({
      spanName: "invoke_agent pi",
      attributes: {
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.conversation.id": "4",
        "gen_ai.agent.name": "pi",
        "memracer.actor": "mediator",
        "memracer.task.id": 7,
        "memracer.thread.id": 4,
      },
    });
    expect(agents[0].attributes).not.toHaveProperty("gen_ai.agent.id");
    expect(agents[0].events.map((event) => event.eventId)).toEqual([10, 11]);
    expect(agents[0].events[0]).toMatchObject({ actor: "human", phase: "input" });
    expect(projected.lifecycles.some((lifecycle) => lifecycle.spanName.includes("ada"))).toBe(false);

    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      spanName: "execute_tool queue.update",
      correlationKey: "tool:12",
      parentLifecycleKey: agents[0].correlationKey,
      attributes: {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.conversation.id": "4",
        "gen_ai.agent.name": "pi",
        "gen_ai.tool.call.id": "12",
        "gen_ai.tool.name": "queue.update",
      },
    });
    expect(tools[0].events.map((event) => [event.eventId, event.eventType])).toEqual([[12, "tool_call"], [13, "tool_result"]]);
    const projectedIds = projected.lifecycles.flatMap((lifecycle) => lifecycle.events.map((event) => event.eventId));
    expect(projectedIds).toHaveLength(new Set(projectedIds).size);
    expect(projected.unassignedEvents).toEqual([]);

    const inputOnly = projectGenAiLifecycles([frames[1]], 4);
    expect(inputOnly.lifecycles).toEqual([]);
    expect(inputOnly.unassignedEvents).toHaveLength(1);
  });
});
