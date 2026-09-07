import { createRoot } from "react-dom/client";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  groupPartByType,
  makeAssistantDataUI,
  useAuiState,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ActorLabel } from "../web/components/ui/avatar.js";
import { jitteredRetryDelay, MAX_RETRY_MS } from "../web/data/retry.js";

export interface TimelineSelection {
  projectId: string;
  sessionId: number;
  threadId?: number;
  taskId?: number | null;
}

interface TimelineIslandProps {
  selection?: TimelineSelection | null;
  onSelectionChange?: (selection: TimelineSelection) => void;
}

export interface FrameMeta {
  timelineOrder: number;
  eventId: number;
  seq: number;
  parentId: number | null;
  threadId: number | null;
  taskId: number | null;
  role: string;
  author: string;
  startTime: number;
  endTime: number | null;
  status: string;
}

export type FramePayload =
  | { type: "start"; sessionId: number }
  | ({ type: "start-step"; id: string; text?: string } & FrameMeta)
  | ({ type: "text-delta"; id: string; kind?: string; delta: string } & FrameMeta)
  | ({ type: "reasoning-delta"; id: string; delta: string } & FrameMeta)
  | ({ type: "tool-input-available"; id: string; toolCallId: string; input: string } & FrameMeta)
  | ({ type: "tool-output-available"; id: string; toolCallId: string; output: string } & FrameMeta)
  | { type: "data-decision"; id: string; taskId: number | null; createdAt: number; decisionKind: string; title: string; rationale: string; citations: Citation[] }
  | { type: "data-cross-thread"; id: string; createdAt: number; source: string; impact: string; affectedEventId: number; fromThreadId: number | null; fromTaskId: number | null; toThreadId: number | null; toTaskId: number | null }
  | { type: "finish-step" }
  | { type: "finish" };
export type Frame = FramePayload & { timelineOrder: number };

type TimelineCustom = {
  actor?: string;
  author?: string;
  kind: string;
  eventId?: number;
  parentId?: number | null;
  threadId?: number | null;
  taskId?: number | null;
  timestamp: number;
  timelineOrder: number;
};

function roleOf(actor: string): ThreadMessageLike["role"] {
  if (actor === "human" || actor === "coder") return "user";
  if (actor === "system") return "system";
  return "assistant";
}

const VERDICT_MARK = "\u0001verdict\u0001";

function formatVerdict(raw: string): string {
  let obj: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return raw;
    obj = parsed as Record<string, unknown>;
  } catch {
    return raw;
  }
  const str = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
  const decision = str(obj.verdict) ?? str(obj.action) ?? (obj.escalate === true ? "escalate" : null) ?? (obj.settled === true ? "settled" : null);
  const blocks = [
    str(obj.feedback),
    str(obj.question) ? `**Question:** ${str(obj.question)}` : null,
    str(obj.answer) ? `**Answer:** ${str(obj.answer)}` : null,
    str(obj.reply) ?? str(obj.summary),
    str(obj.rationale) ? `_Why:_ ${str(obj.rationale)}` : null,
  ].filter((value): value is string => Boolean(value));
  const body = blocks.join("\n\n");
  return decision ? `${VERDICT_MARK}${decision}${VERDICT_MARK}${body ? `\n\n${body}` : ""}` : body || raw;
}

function toolInput(raw: string): { name: string; args: Record<string, unknown> } {
  try {
    const value = JSON.parse(raw) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const args = value as Record<string, unknown>;
      return { name: typeof args.action === "string" ? args.action : "tool", args };
    }
  } catch {
    // The fallback remains inspectable in the tool disclosure.
  }
  return { name: "tool", args: { raw } };
}

function meta(frame: FrameMeta, kind: string): { custom: TimelineCustom } {
  return {
    custom: {
      actor: frame.role,
      author: frame.author,
      kind,
      eventId: frame.eventId,
      parentId: frame.parentId,
      threadId: frame.threadId,
      taskId: frame.taskId,
      timestamp: frame.startTime,
      timelineOrder: frame.timelineOrder,
    },
  };
}

export function reduceFrames(frames: Frame[], running: boolean): ThreadMessageLike[] {
  const messages: ThreadMessageLike[] = [];
  for (const frame of frames) {
    if (frame.type === "data-decision") {
      messages.push({
        id: frame.id,
        role: "assistant",
        createdAt: new Date(frame.createdAt),
        content: [{ type: "data-decision", data: { kind: frame.decisionKind, title: frame.title, rationale: frame.rationale, taskId: frame.taskId, citations: frame.citations } }],
        metadata: { custom: { kind: "decision", timestamp: frame.createdAt, timelineOrder: frame.timelineOrder } },
      });
      continue;
    }
    if (frame.type === "data-cross-thread") {
      messages.push({
        id: frame.id,
        role: "assistant",
        createdAt: new Date(frame.createdAt),
        content: [{ type: "data-cross-thread", data: { source: frame.source, impact: frame.impact, fromThreadId: frame.fromThreadId, toThreadId: frame.toThreadId } }],
        metadata: { custom: { kind: "cross-thread", timestamp: frame.createdAt, timelineOrder: frame.timelineOrder } },
      });
      continue;
    }
    if (!("startTime" in frame)) continue;
    const messageRole = frame.type === "reasoning-delta" || frame.type === "tool-input-available" || frame.type === "tool-output-available"
      ? "assistant"
      : roleOf(frame.role);
    const base = {
      id: `${frame.type}-${frame.id}`,
      role: messageRole,
      createdAt: new Date(frame.startTime),
      metadata: meta(frame, frame.type === "text-delta" ? (frame.kind ?? "text") : frame.type),
    } satisfies Partial<ThreadMessageLike>;
    if (frame.type === "start-step") {
      messages.push({ ...base, content: [{ type: "text", text: frame.text ?? "" }] } as ThreadMessageLike);
    } else if (frame.type === "text-delta") {
      messages.push({ ...base, content: [{ type: "text", text: frame.kind === "verdict" ? formatVerdict(frame.delta) : frame.delta }] } as ThreadMessageLike);
    } else if (frame.type === "reasoning-delta") {
      messages.push({ ...base, content: [{ type: "reasoning", text: frame.delta }] } as ThreadMessageLike);
    } else if (frame.type === "tool-input-available") {
      const tool = toolInput(frame.input);
      messages.push({ ...base, content: [{ type: "tool-call", toolCallId: frame.toolCallId, toolName: tool.name, args: tool.args, argsText: frame.input }] } as ThreadMessageLike);
    } else if (frame.type === "tool-output-available") {
      messages.push({ ...base, content: [{ type: "tool-call", toolCallId: frame.toolCallId, toolName: "tool result", args: {}, result: frame.output }] } as ThreadMessageLike);
    }
  }
  messages.sort((left, right) => {
    const a = left.metadata?.custom as TimelineCustom | undefined;
    const b = right.metadata?.custom as TimelineCustom | undefined;
    return (a?.timelineOrder ?? 0) - (b?.timelineOrder ?? 0);
  });
  const last = messages.length - 1;
  if (running && messages[last]?.role === "assistant") {
    messages[last] = { ...messages[last], status: { type: "running" } };
  }
  return messages;
}

function frameKey(frame: Frame): string {
  return "id" in frame ? `${frame.type}:${frame.id}` : frame.type;
}

export function mergeFrame(frames: Frame[], incoming: Frame): Frame[] {
  const incomingKey = frameKey(incoming);
  const index = frames.findIndex((frame) => frameKey(frame) === incomingKey);
  if (index < 0) return [...frames, incoming];
  const previous = frames[index];
  let merged = incoming;
  if (incoming.timelineOrder > previous.timelineOrder && previous.type === incoming.type) {
    if (previous.type === "text-delta" && incoming.type === "text-delta") {
      merged = { ...incoming, delta: previous.delta + incoming.delta };
    } else if (previous.type === "reasoning-delta" && incoming.type === "reasoning-delta") {
      merged = { ...incoming, delta: previous.delta + incoming.delta };
    }
  }
  const next = [...frames];
  next[index] = merged;
  return next;
}

interface Citation { type: "task" | "thread" | "decision" | "evidence" | "pr"; id: number; url: string; label: string }
interface DecisionData { kind: string; title: string; rationale: string; taskId: number | null; citations: Citation[] }
interface CrossThreadData { source: string; impact: string; fromThreadId: number | null; toThreadId: number | null }

function CitationChips({ citations }: { citations: Citation[] }) {
  if (!citations?.length) return null;
  return <div className="aui-citations">{citations.map((citation) => citation.type === "pr"
    ? <a key={`${citation.type}:${citation.id}`} href={citation.url} target="_blank" rel="noopener noreferrer">{citation.label}</a>
    : <button key={`${citation.type}:${citation.id}`} type="button" onClick={() => window.dispatchEvent(new CustomEvent("memracer:citation", { detail: citation }))}>{citation.label}</button>
  )}</div>;
}

const DecisionUI = makeAssistantDataUI<DecisionData>({
  name: "decision",
  render: ({ data }) => (
    <aside className="aui-decision" data-timeline-row="decision">
      <span className="aui-event-kicker">decision · {data.kind}</span>
      <strong>{data.title}</strong>
      {data.rationale ? <p>{data.rationale}</p> : null}
      <CitationChips citations={data.citations} />
    </aside>
  ),
});

const CrossThreadUI = makeAssistantDataUI<CrossThreadData>({
  name: "cross-thread",
  render: ({ data }) => (
    <div className="aui-cross-thread" data-timeline-row="cross-thread">
      <span className="aui-cross-heading"><span>Fork context</span><b>{data.source}</b></span>
      <span aria-hidden="true">→</span>
      <div className="aui-cross-impact aui-md"><ReactMarkdown remarkPlugins={[remarkGfm]}>{data.impact}</ReactMarkdown></div>
    </div>
  ),
});

function VerdictText({ text }: { text: string }) {
  let decision: string | null = null;
  let body = text;
  if (text.startsWith(VERDICT_MARK)) {
    const end = text.indexOf(VERDICT_MARK, VERDICT_MARK.length);
    if (end > 0) {
      decision = text.slice(VERDICT_MARK.length, end);
      body = text.slice(end + VERDICT_MARK.length).replace(/^\n+/, "");
    }
  }
  const tone = decision && /approv|accept|answer|settl|merg/i.test(decision) ? "ok" : decision && /revise|refuse|reject|block/i.test(decision) ? "bad" : "note";
  return <div className="aui-text-body">
    {decision ? <span className={`aui-verdict v-${tone}`}>{decision}</span> : null}
    {body ? <div className="aui-md"><ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown></div> : null}
  </div>;
}

function toolPayload(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function TimelineParts() {
  return (
    <MessagePrimitive.GroupedParts groupBy={groupPartByType({ reasoning: ["group-reasoning"] })} indicator="no-text">
      {({ part, children }) => {
        switch (part.type) {
          case "group-reasoning":
            return <details className="aui-reasoning" data-reasoning-status={part.status.type} open={part.status.type === "running"}>
              <summary>Thinking</summary>
              <div className="aui-reasoning-body">{children}</div>
            </details>;
          case "reasoning":
            return <p className="aui-reasoning-leaf">{part.text}</p>;
          case "text":
            return <VerdictText text={part.text} />;
          case "tool-call":
            return part.toolUI ?? <details className="aui-tool"><summary>{part.toolName}</summary><div className="aui-tool-payload"><span>Input</span><code>{part.argsText || toolPayload(part.args)}</code>{part.result !== undefined ? <><span>Result</span><code className="aui-tool-out">{toolPayload(part.result)}</code></> : null}</div></details>;
          case "data":
            return part.dataRendererUI ?? null;
          case "indicator":
            return <span className="aui-thinking-live">thinking…</span>;
          default:
            return null;
        }
      }}
    </MessagePrimitive.GroupedParts>
  );
}

function TimelineMessage() {
  const custom = useAuiState((state) => state.message.metadata.custom) as TimelineCustom | undefined;
  const messageStatus = useAuiState((state) => state.message.status?.type ?? "complete");
  if (custom?.kind === "decision" || custom?.kind === "cross-thread") {
    const eventActor = custom.actor === "human" || custom.actor === "coder" ? custom.actor : "mediator";
    return <MessagePrimitive.Root className="aui-event-row" data-timestamp={custom.timestamp} data-timeline-order={custom.timelineOrder} data-event-id={custom.eventId}><header className="aui-event-actor"><ActorLabel role={eventActor} name={custom.author ?? eventActor} /></header><MessagePrimitive.Parts>{({ part }) => part.type === "data" ? part.dataRendererUI ?? null : null}</MessagePrimitive.Parts></MessagePrimitive.Root>;
  }
  const actor = custom?.actor ?? "mediator";
  const actorRole: "human" | "mediator" | "coder" | "system" = actor === "human" || actor === "mediator" || actor === "coder" ? actor : "system";
  const author = custom?.author ?? actor;
  const timestamp = custom?.timestamp ? new Date(custom.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
  return (
    <MessagePrimitive.Root className={`aui-msg actor-${actor}`} data-actor={actor} data-message-status={messageStatus} data-timestamp={custom?.timestamp} data-timeline-order={custom?.timelineOrder} data-event-id={custom?.eventId}>
      <div className="aui-msg-card">
        <header className="aui-msg-head"><ActorLabel role={actorRole} name={author} size={24} /><time dateTime={custom?.timestamp ? new Date(custom.timestamp).toISOString() : undefined}>{timestamp}</time></header>
        <div className="aui-msg-body"><TimelineParts /></div>
      </div>
    </MessagePrimitive.Root>
  );
}

interface SiblingInfo { originText: string | null; siblings: { taskId: number | null; sessionId: number; threadId: number; label: string }[] }

async function fetchSiblings(opts: TimelineSelection): Promise<SiblingInfo> {
  const empty: SiblingInfo = { originText: null, siblings: [] };
  try {
    const threadId = opts.threadId ?? opts.sessionId;
    const response = await fetch(
      `/api/p/${encodeURIComponent(opts.projectId)}/sessions/${opts.sessionId}/siblings?thread=${threadId}`,
      { credentials: "same-origin" },
    );
    if (!response.ok) return empty;
    return await response.json() as SiblingInfo;
  } catch {
    return empty;
  }
}

export function TimelineIsland({ selection: controlledSelection, onSelectionChange }: TimelineIslandProps = {}) {
  const [bridgeSelection, setBridgeSelection] = useState<TimelineSelection | null>(null);
  const selection = controlledSelection === undefined ? bridgeSelection : controlledSelection;
  const [frames, setFrames] = useState<Frame[]>([]);
  const [running, setRunning] = useState(false);
  const [streamStatus, setStreamStatus] = useState<"idle" | "connecting" | "live" | "reconnecting" | "complete">("idle");
  const [pinned, setPinned] = useState(true);
  const [siblings, setSiblings] = useState<SiblingInfo>({ originText: null, siblings: [] });
  const sourceRef = useRef<EventSource | null>(null);
  const lastEventIdRef = useRef("");
  const sessionKeyRef = useRef<string | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const messages = useMemo(() => reduceFrames(frames, running), [frames, running]);

  useEffect(() => {
    if (controlledSelection !== undefined) return;
    const bridge = window as unknown as { __memracerIsland?: unknown; __memracerSelection?: TimelineSelection | null };
    bridge.__memracerIsland = { select: (value: TimelineSelection) => setBridgeSelection(value), clear: () => setBridgeSelection(null) };
    if (bridge.__memracerSelection) setBridgeSelection(bridge.__memracerSelection);
    const onSelect = (event: Event) => setBridgeSelection((event as CustomEvent<TimelineSelection | null>).detail);
    window.addEventListener("memracer:select", onSelect);
    return () => { window.removeEventListener("memracer:select", onSelect); delete bridge.__memracerIsland; };
  }, [controlledSelection]);

  useEffect(() => {
    sourceRef.current?.close();
    if (!selection) {
      sessionKeyRef.current = null;
      lastEventIdRef.current = "";
      setFrames([]);
      setSiblings({ originText: null, siblings: [] });
      setPinned(true);
      setStreamStatus("idle");
      return;
    }
    const sessionKey = `${selection.projectId}:${selection.sessionId}`;
    if (sessionKeyRef.current !== sessionKey) {
      sessionKeyRef.current = sessionKey;
      lastEventIdRef.current = "";
      setFrames([]);
      setSiblings({ originText: null, siblings: [] });
      setPinned(true);
    }
    void fetchSiblings(selection).then(setSiblings);
    let cancelled = false;
    let completed = false;
    let retryDelayMs = 1_000;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      if (cancelled || completed) return;
      setStreamStatus((status) => status === "reconnecting" ? status : "connecting");
      setRunning(true);
      let source: EventSource;
      try {
        const resume = lastEventIdRef.current
          ? `?lastEventId=${encodeURIComponent(lastEventIdRef.current)}`
          : "";
        source = new EventSource(`/api/p/${encodeURIComponent(selection.projectId)}/sessions/${selection.sessionId}/stream${resume}`);
      } catch {
        scheduleReconnect();
        return;
      }
      sourceRef.current = source;
      source.onopen = () => {
        if (cancelled || sourceRef.current !== source) return;
        retryDelayMs = 1_000;
        setStreamStatus("live");
      };
      source.onmessage = (event) => {
        if (cancelled || sourceRef.current !== source) return;
        if (event.lastEventId) lastEventIdRef.current = event.lastEventId;
        if (event.data === "[DONE]") {
          completed = true;
          source.close();
          setRunning(false);
          setStreamStatus("complete");
          return;
        }
        try {
          const frame = JSON.parse(event.data) as Frame;
          setFrames((current) => mergeFrame(current, frame));
          if (frame.type === "finish") {
            completed = true;
            source.close();
            setRunning(false);
            setStreamStatus("complete");
          }
        } catch { /* one malformed frame must not break the transcript */ }
      };
      source.onerror = () => {
        if (cancelled || completed || sourceRef.current !== source) return;
        source.close();
        scheduleReconnect();
      };
    };
    const scheduleReconnect = () => {
      if (cancelled || completed || retryTimer) return;
      setRunning(false);
      setStreamStatus("reconnecting");
      const wait = jitteredRetryDelay(retryDelayMs);
      retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_MS);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        connect();
      }, wait);
    };
    connect();
    return () => {
      cancelled = true;
      sourceRef.current?.close();
      sourceRef.current = null;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [selection?.projectId, selection?.sessionId]);

  const runtime = useExternalStoreRuntime({ messages, isRunning: running, onNew: async () => {}, convertMessage: useCallback((message: ThreadMessageLike) => message, []) });
  const onScroll = useCallback(() => {
    const viewport = viewportRef.current;
    if (viewport) setPinned(viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 24);
  }, []);

  return <AssistantRuntimeProvider runtime={runtime}>
    <DecisionUI /><CrossThreadUI />
    {(streamStatus === "connecting" || streamStatus === "reconnecting") && <div className="aui-connection" role="status">Activity {streamStatus}…</div>}
    {selection && (siblings.originText || siblings.siblings.length) ? <div className="aui-origin" role="note"><span className="aui-origin-label">forked from</span><span className="aui-origin-msg">{siblings.originText ?? "origin"}</span>{siblings.siblings.map((sibling) => <button key={sibling.threadId} className="aui-sibling" onClick={() => {
      const next = { ...selection, sessionId: sibling.sessionId, threadId: sibling.threadId, taskId: sibling.taskId };
      if (controlledSelection === undefined) setBridgeSelection(next);
      else onSelectionChange?.(next);
    }}>{sibling.label}</button>)}</div> : null}
    <ThreadPrimitive.Root className="aui-thread">
      <ThreadPrimitive.Viewport ref={viewportRef} className="aui-viewport" autoScroll={pinned} scrollToBottomOnRunStart={false} scrollToBottomOnInitialize scrollToBottomOnThreadSwitch onScroll={onScroll} data-pinned={pinned ? "true" : "false"}>
        <ThreadPrimitive.Empty><div className="aui-empty">{selection ? "No activity was recorded for this thread." : "Choose a thread to view its activity."}</div></ThreadPrimitive.Empty>
        <ThreadPrimitive.Messages>{() => <TimelineMessage />}</ThreadPrimitive.Messages>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  </AssistantRuntimeProvider>;
}

const element = document.getElementById("thread-island");
if (element) createRoot(element).render(<TimelineIsland />);
