/**
 * Browser-safe projection of recorded session-event frames into a causal
 * trace. This module deliberately has no React, DOM, database, or OTel SDK
 * dependency so replay is deterministic and can run entirely in the client.
 */

export type TraceActor = "human" | "mediator" | "coder" | "system" | string;

export interface TraceFrame {
  type: string;
  timelineOrder: number;
  eventId?: number;
  parentId?: number | null;
  threadId?: number | null;
  taskId?: number | null;
  role?: TraceActor;
  author?: string;
  status?: string;
  startTime?: number;
  endTime?: number | null;
  kind?: string;
  toolCallId?: string;
  input?: string;
  toolName?: string;
}

export interface TraceNode {
  id: string;
  eventId: number;
  parentId: number | null;
  actor: TraceActor;
  author: string;
  eventType: string;
  threadId: number | null;
  taskId: number | null;
  timelineOrder: number;
  status: string;
}

export type TraceEdgeKind = "causal" | "handoff" | "fork";

export interface TraceEdge {
  id: string;
  from: string;
  to: string;
  kind: TraceEdgeKind;
}

export interface TraceGraph {
  nodes: TraceNode[];
  edges: TraceEdge[];
}

export interface ReplayActorState {
  actor: TraceActor;
  eventType: string;
  status: string;
  taskId: number | null;
  timelineOrder: number;
}

export interface ReplayState {
  current: TraceNode | null;
  actorStates: ReplayActorState[];
  pastEventIds: Set<number>;
  futureEventIds: Set<number>;
  recordingEnded: boolean;
}

function eventType(frame: TraceFrame): string {
  if (frame.type === "text-delta") return frame.kind ?? "text";
  if (frame.type === "tool-input-available") return "tool_call";
  if (frame.type === "tool-output-available") return "tool_result";
  if (frame.type === "reasoning-delta") return "reasoning";
  if (frame.type === "start-step") return "request";
  return frame.type;
}

/** One graph node per persisted session_event; data and stream-control frames are omitted. */
export function buildTraceGraph(frames: readonly TraceFrame[]): TraceGraph {
  const nodes = frames
    .filter((frame): frame is TraceFrame & { eventId: number } => typeof frame.eventId === "number")
    .map((frame): TraceNode => ({
      id: `event-${frame.eventId}`,
      eventId: frame.eventId,
      parentId: frame.parentId ?? null,
      actor: frame.role ?? "system",
      author: frame.author ?? frame.role ?? "system",
      eventType: eventType(frame),
      threadId: frame.threadId ?? null,
      taskId: frame.taskId ?? null,
      timelineOrder: frame.timelineOrder,
      status: frame.status ?? "ok",
    }))
    .sort((left, right) => left.timelineOrder - right.timelineOrder);

  const byEvent = new Map(nodes.map((node) => [node.eventId, node]));
  const edges: TraceEdge[] = [];
  for (const node of nodes) {
    if (node.parentId == null) continue;
    const parent = byEvent.get(node.parentId);
    if (!parent) continue;
    const taskChanged = parent.taskId !== node.taskId;
    const actorChanged = parent.actor !== node.actor;
    const threadChanged = parent.threadId !== node.threadId;
    const kind: TraceEdgeKind = taskChanged ? "fork" : actorChanged ? "handoff" : threadChanged ? "fork" : "causal";
    edges.push({ id: `${parent.id}-${node.id}`, from: parent.id, to: node.id, kind });
  }
  return { nodes, edges };
}

/** Reconstructs the recorded loop at a timeline cutoff without mutating the source frames. */
export function replayTrace(graph: TraceGraph, timelineOrder: number, finishTimelineOrder: number | null = null): ReplayState {
  const visible = graph.nodes.filter((node) => node.timelineOrder <= timelineOrder);
  const current = visible.at(-1) ?? null;
  const latestByActor = new Map<TraceActor, ReplayActorState>();
  for (const node of visible) {
    latestByActor.set(node.actor, {
      actor: node.actor,
      eventType: node.eventType,
      status: node.status,
      taskId: node.taskId,
      timelineOrder: node.timelineOrder,
    });
  }
  const last = graph.nodes.at(-1);
  return {
    current,
    actorStates: [...latestByActor.values()].sort((a, b) => a.timelineOrder - b.timelineOrder),
    pastEventIds: new Set(visible.map((node) => node.eventId)),
    futureEventIds: new Set(graph.nodes.filter((node) => node.timelineOrder > timelineOrder).map((node) => node.eventId)),
    recordingEnded: Boolean(finishTimelineOrder != null && timelineOrder >= finishTimelineOrder && last),
  };
}

export type GenAiLifecycleKind = "agent" | "tool";
export type GenAiEventPhase = "input" | "activity" | "output" | "error";

export interface GenAiLifecycleEvent {
  eventId: number;
  parentEventId: number | null;
  eventType: string;
  actor: TraceActor;
  phase: GenAiEventPhase;
  timelineOrder: number;
}

export interface GenAiLifecycleProjection {
  kind: GenAiLifecycleKind;
  spanName: string;
  correlationKey: string;
  parentEventId: number | null;
  parentLifecycleKey: string | null;
  attributes: Record<string, string | number>;
  events: GenAiLifecycleEvent[];
}

export interface GenAiProjection {
  lifecycles: GenAiLifecycleProjection[];
  /** Recorded inputs for which no logical agent executor exists yet. */
  unassignedEvents: GenAiLifecycleEvent[];
}

function lifecycleEvent(frame: TraceFrame): GenAiLifecycleEvent {
  const type = eventType(frame);
  const phase: GenAiEventPhase = frame.status === "error"
    ? "error"
    : frame.role === "human" || frame.role === "system" || type === "request" || type === "clarification_a"
      ? "input"
      : type === "verdict" || type === "text" || type === "clarification_q"
        ? "output"
        : "activity";
  return {
    eventId: frame.eventId!,
    parentEventId: frame.parentId ?? null,
    eventType: type,
    actor: frame.role ?? "system",
    phase,
    timelineOrder: frame.timelineOrder,
  };
}

function parsedToolName(frame: TraceFrame): string {
  if (frame.toolName) return frame.toolName;
  if (frame.input) {
    try {
      const input = JSON.parse(frame.input) as Record<string, unknown>;
      if (typeof input.tool === "string" && input.tool.trim()) return input.tool.trim();
      if (typeof input.action === "string" && input.action.trim()) return input.action.trim();
    } catch {
      // Keep the lifecycle traceable under a stable honest fallback.
    }
  }
  return "tool";
}

/**
 * Folds recorded rows into conceptual OTel GenAI lifecycles. Rows become
 * content-free lifecycle events; they are not treated as one span each.
 * Human/system inputs attach to the next known mediator/coder invocation.
 * A tool call and its result fold into one execute_tool lifecycle.
 */
export function projectGenAiLifecycles(frames: readonly TraceFrame[], sessionId: number): GenAiProjection {
  const lifecycles: GenAiLifecycleProjection[] = [];
  const pendingInputs: GenAiLifecycleEvent[] = [];
  const toolsByCallId = new Map<string, GenAiLifecycleProjection>();
  let currentAgent: GenAiLifecycleProjection | null = null;
  let currentExecutor = "";
  let invocation = 0;

  const recorded = frames
    .filter((frame): frame is TraceFrame & { eventId: number } => typeof frame.eventId === "number")
    .sort((left, right) => left.timelineOrder - right.timelineOrder);

  for (const frame of recorded) {
    const actor = frame.role ?? "system";
    const type = eventType(frame);
    const projectedEvent = lifecycleEvent(frame);
    if (actor === "human" || actor === "system") {
      pendingInputs.push(projectedEvent);
      currentAgent = null;
      currentExecutor = "";
      continue;
    }
    if (actor !== "mediator" && actor !== "coder") {
      if (currentAgent) currentAgent.events.push(projectedEvent);
      else pendingInputs.push(projectedEvent);
      continue;
    }

    const author = frame.author ?? actor;
    const executor = `${actor}:${author}:${frame.taskId ?? "none"}:${frame.threadId ?? "none"}`;
    if (!currentAgent || currentExecutor !== executor) {
      invocation++;
      const attributes: Record<string, string | number> = {
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.conversation.id": String(sessionId),
        "gen_ai.agent.name": author,
        "memracer.actor": actor,
      };
      if (frame.taskId != null) attributes["memracer.task.id"] = frame.taskId;
      if (frame.threadId != null) attributes["memracer.thread.id"] = frame.threadId;
      currentAgent = {
        kind: "agent",
        spanName: `invoke_agent ${author}`,
        correlationKey: `agent:${sessionId}:${invocation}`,
        parentEventId: frame.parentId ?? null,
        parentLifecycleKey: null,
        attributes,
        events: pendingInputs.splice(0),
      };
      lifecycles.push(currentAgent);
      currentExecutor = executor;
    }
    if (type === "tool_call") {
      const callId = frame.toolCallId ?? String(frame.eventId);
      const toolName = parsedToolName(frame);
      const tool: GenAiLifecycleProjection = {
        kind: "tool",
        spanName: `execute_tool ${toolName}`,
        correlationKey: `tool:${callId}`,
        parentEventId: frame.parentId ?? null,
        parentLifecycleKey: currentAgent.correlationKey,
        attributes: {
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.conversation.id": String(sessionId),
          "gen_ai.agent.name": author,
          "gen_ai.tool.name": toolName,
          "gen_ai.tool.call.id": callId,
        },
        events: [projectedEvent],
      };
      lifecycles.push(tool);
      toolsByCallId.set(callId, tool);
    } else if (type === "tool_result") {
      const callId = frame.toolCallId ?? String(frame.parentId ?? frame.eventId);
      const tool = toolsByCallId.get(callId);
      if (tool) tool.events.push(projectedEvent);
      else currentAgent.events.push(projectedEvent);
    } else {
      currentAgent.events.push(projectedEvent);
    }
  }

  return { lifecycles, unassignedEvents: pendingInputs };
}
