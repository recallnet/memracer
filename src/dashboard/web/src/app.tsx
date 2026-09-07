import { flexRender, getCoreRowModel, useReactTable, type CellContext, type ColumnDef, type RowData } from "@tanstack/react-table";
import { ArrowDown, ArrowUp, BookOpen, Building2, ChevronDown, ChevronRight, ChevronUp, CircleHelp, Command, LayoutDashboard, ListFilter, LogOut, Menu, Minus, PanelLeftClose, PanelLeftOpen, Search, Settings, Users, X } from "lucide-react";
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { TimelineIsland } from "../../island/index.js";
import { ActorAttribution, IdentityMark } from "../components/identity-mark.js";
import { KnowledgeView, Onboarding, ProjectCreationMenu, SettingsView, TeamView } from "../components/auxiliary-views.js";
import { GetStartedPanel } from "../components/get-started-panel.js";
import { OrgSettingsView } from "../components/org-settings-view.js";
import { DashboardErrorBoundary } from "../components/error-boundary.js";
import { CompletedArchive } from "../components/completed-archive.js";
import { TaskDetailSheet } from "../components/task-detail-sheet.js";
import { TaskPrStatus } from "../components/task-pr-status.js";
import { ActorLabel, Avatar, type ActorRole } from "../components/ui/avatar.js";
import { StatusBadge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Card } from "../components/ui/card.js";
import { Select } from "../components/ui/select.js";
import { EmptyState, ErrorState, LoadingState, resolveQueryView } from "../components/ui/state.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.js";
import { Tooltip } from "../components/ui/tooltip.js";
import type { AgentDto, AttentionItemDto, MembershipDto, QueueOverviewDto, QueueTaskDto, ThreadDto } from "../data/dto.js";
import { dashboardApi, DashboardApiError } from "../data/api.js";
import { queryKeys } from "../data/query-keys.js";
import { useProjectEvents, useProjectHome, useProjects } from "../hooks/home-data.js";
import { agentIdentity, taskIdentity, threadRole } from "../lib/identity.js";
import {
  desktopNotificationCopy,
  detectDesktopNotificationState,
  disableDesktopNotifications,
  enableDesktopNotifications,
  type DesktopNotificationState,
} from "../lib/desktop-notifications.js";
import { activityThreadGroups, displayDisposition, displayTaskState, formatCountdown, holdCauseLabel, homeSnapshot, latestTaskTransitions, liveAgentRows, liveConnectionLabel, onHoldRows, queueRows, threadSummary, trendPresentation } from "../lib/home-model.js";
import {
  groupMembershipsByOrg,
  NO_ORG_KEY,
  paletteProjectLabel,
  pickProjectForOrg,
  projectOptionLabel,
  recoverSelection,
  resolveOrgKey,
  writeLastProjectForOrg,
} from "../lib/org-workspace.js";
import { resolveTaskTrigger } from "../lib/task-trigger.js";
import {
  parseUrlState, QUEUE_SORTS, serializeUrlState, writeUrlState,
  type DashboardUrlState, type QueueSort, type SortDirection,
} from "../lib/url-state.js";

const EMPTY_TASKS: QueueTaskDto[] = [];
const EMPTY_AGENTS: AgentDto[] = [];
const MOBILE_TABS = ["you", "feed", "queue", "knowledge", "team", "settings"] as const;
const MOBILE_MEDIA_QUERY = "(max-width: 850px)";
const readMobileTab = () => {
  try { const value = globalThis.localStorage?.getItem("memracer.react.mobile-tab"); return MOBILE_TABS.includes(value as typeof MOBILE_TABS[number]) ? value! : "you"; } catch { return "you"; }
};
const saveMobileTab = (tab: string) => { try { globalThis.localStorage?.setItem("memracer.react.mobile-tab", tab); } catch { /* storage is optional */ } };
const readSidebarCollapsed = () => { try { return globalThis.localStorage?.getItem("memracer.react.sidebar-collapsed") === "true"; } catch { return false; } };
const saveSidebarCollapsed = (collapsed: boolean) => { try { globalThis.localStorage?.setItem("memracer.react.sidebar-collapsed", String(collapsed)); } catch { /* storage is optional */ } };
const THEME_STORAGE_KEY = "memracer.react.theme";
const THEME_OPTIONS = ["system", "light", "dark"] as const;
export type ThemePreference = typeof THEME_OPTIONS[number];
export const readThemePreference = (): ThemePreference => {
  try {
    const value = globalThis.localStorage?.getItem(THEME_STORAGE_KEY);
    return THEME_OPTIONS.includes(value as ThemePreference) ? value as ThemePreference : "system";
  } catch { return "system"; }
};
export const applyThemePreference = (preference: ThemePreference) => {
  if (preference === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.dataset.theme = preference;
};
export const saveThemePreference = (preference: ThemePreference) => {
  try { globalThis.localStorage?.setItem(THEME_STORAGE_KEY, preference); } catch { /* storage is optional */ }
};

type QueueOpenTask = (id: number, trigger: HTMLElement) => void;

declare module "@tanstack/react-table" {
  interface TableMeta<TData extends RowData> {
    queueNow: number;
    openQueueTask: QueueOpenTask | undefined;
  }
}

function QueryNotice({ label, retry, stale = false }: { label: string; retry: () => void; stale?: boolean }) {
  return <ErrorState label={`${label} temporarily unavailable.`} retry={retry} stale={stale} />;
}

function PendingPanel({ className, label }: { className: string; label: string }) {
  return <section className={`${className} panel`} aria-label={label}><p className="empty-copy" role="status">Loading {label.toLowerCase()}…</p></section>;
}

function UnavailablePanel({ className, label, retry }: { className: string; label: string; retry: () => void }) {
  return <section className={`${className} panel`} aria-label={label}><QueryNotice label={label} retry={retry} /></section>;
}

function useClock(enabled = true): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [enabled]);
  return now;
}

function StateChip({ state }: { state: QueueTaskDto["state"] }) {
  return <StatusBadge state={state} label={displayTaskState(state)} />;
}

function DispositionChip({ task }: { task: QueueTaskDto }) {
  const op = task.operational;
  if (!op || op.disposition === "terminal") return null;
  return (
    <span
      className={`disposition-chip${op.holding ? " is-holding" : ""}`}
      data-disposition={op.disposition}
      data-testid="disposition-chip"
      title={op.reason}
    >
      {displayDisposition(op.disposition)}
    </span>
  );
}

function formatQueueAge(timestamp: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function QueueActor({ task }: { task: QueueTaskDto }) {
  const leased = Boolean(task.lease_agent);
  const role = leased ? "coder" : "human";
  const name = textOrUntitled(leased ? task.lease_agent : task.submitted_by);
  const lineage = !leased && task.parent_id != null
    ? `follow-up to #${task.parent_id}${task.parent_submitted_by ? ` · ${task.parent_submitted_by}` : ""}`
    : null;
  return <Tooltip content={leased ? "Coder lease owner" : lineage ? `Human submitter · ${lineage}` : "Human submitter"}>
    <span className="queue-owner">
      <ActorAttribution name={name} role={role} />
      {lineage ? <i className="queue-lineage muted">{lineage}</i> : null}
    </span>
  </Tooltip>;
}

function QueueTiming({ task, now }: { task: QueueTaskDto; now: number }) {
  if (task.lease_agent && task.lease_expires_at) {
    const expired = task.lease_expires_at <= now;
    return <span className={`queue-timing${expired ? " is-expired" : " is-live"}`}>
      <span>{expired ? "Lease expired" : "Lease"}</span>
      {!expired && <time dateTime={new Date(task.lease_expires_at).toISOString()}>{formatCountdown(task.lease_expires_at, now)}</time>}
    </span>;
  }
  if (task.state === "INCUBATING" && task.incubate_until) {
    return <span className="queue-timing is-waiting"><span>Warms in</span><time dateTime={new Date(task.incubate_until).toISOString()}>{formatCountdown(task.incubate_until, now)}</time></span>;
  }
  return <span className="queue-timing"><span>Updated</span><time dateTime={new Date(task.updated_at).toISOString()}>{formatQueueAge(task.updated_at, now)}</time></span>;
}

function textOrUntitled(value: string | null | undefined): string {
  return value?.trim() || "untitled";
}

function QueueStateCell({ row }: CellContext<QueueTaskDto, unknown>) {
  return (
    <span className="queue-state-stack">
      <StateChip state={row.original.state} />
      <DispositionChip task={row.original} />
    </span>
  );
}

function QueueTaskCell({ row, table }: CellContext<QueueTaskDto, unknown>) {
  const task = row.original;
  const now = table.options.meta!.queueNow;
  return <div className="queue-task-summary"><b>{textOrUntitled(task.title)}</b><span><span>#{task.id}</span><time dateTime={new Date(task.created_at).toISOString()}>opened {formatQueueAge(task.created_at, now)}</time>{task.evidence_count > 0 && <span>{task.evidence_count} evidence</span>}</span><TaskPrStatus resultPrUrl={task.result_pr_url} resultPrNumber={task.result_pr_number} prVerification={task.pr_verification} /></div>;
}

function QueueOwnerCell({ row }: CellContext<QueueTaskDto, unknown>) {
  return <QueueActor task={row.original} />;
}

function QueuePriorityCell({ row }: CellContext<QueueTaskDto, unknown>) {
  return <span className="queue-priority">P{row.original.priority}</span>;
}

function QueueActivityCell({ row, table }: CellContext<QueueTaskDto, unknown>) {
  return <QueueTiming task={row.original} now={table.options.meta!.queueNow} />;
}

function QueueOpenHeader() {
  return <span className="sr-only">Open task</span>;
}

function QueueOpenCell({ row, table }: CellContext<QueueTaskDto, unknown>) {
  const task = row.original;
  return <Button className="queue-open-button queue-task-trigger" variant="ghost" size="sm" type="button" data-task-trigger={task.id} aria-haspopup="dialog" aria-label={`Open task ${task.id}: ${textOrUntitled(task.title)}`} onClick={(event) => table.options.meta!.openQueueTask?.(task.id, event.currentTarget)}>Open <ChevronRight size={13} /></Button>;
}

const QUEUE_COLUMNS: ColumnDef<QueueTaskDto>[] = [
  { accessorKey: "state", header: "Status", cell: QueueStateCell },
  { accessorKey: "title", header: "Task", cell: QueueTaskCell },
  { accessorKey: "lease_agent", header: "Owner", cell: QueueOwnerCell },
  { accessorKey: "priority", header: "Priority", cell: QueuePriorityCell },
  { id: "timing", header: "Activity", cell: QueueActivityCell },
  { id: "open", header: QueueOpenHeader, cell: QueueOpenCell },
];

function JargonHelp({ label, explanation }: { label: string; explanation: string }) {
  return <Tooltip content={explanation}><button className="jargon-help" type="button"><span>{label}</span><CircleHelp size={12} /></button></Tooltip>;
}

function VisualKey() {
  return <details className="visual-key">
    <Tooltip content="Visual key"><summary aria-label="Open visual key"><CircleHelp size={14} /><span className="sr-only">Visual key</span></summary></Tooltip>
    <div className="visual-key-popover">
      <section><h3>Identity</h3>
        <ActorAttribution role="human" name="submitter" />
        <ActorAttribution role="mediator" name="steward" />
        <ActorAttribution role="coder" name="agent" />
        <span className="key-task"><IdentityMark identity={taskIdentity(1)} /><span>task</span><b>#id</b></span>
        <span className="key-unknown"><IdentityMark identity={agentIdentity("unknown", null)} /><span>unknown</span></span>
      </section>
      <section><h3>State</h3>
        <StateChip state="EXECUTING" /><StateChip state="DONE" /><StateChip state="BLOCKED" /><StateChip state="QUEUED" /><StateChip state="PARKED" />
      </section>
      <section className="jargon-key"><h3>Terms</h3>
        <JargonHelp label="Lease" explanation="A time-limited claim held by one coder session." />
        <JargonHelp label="Held" explanation="Work intentionally paused until a human changes direction." />
        <JargonHelp label="Verdict" explanation="Frigg's recorded decision on a submission or plan." />
        <JargonHelp label="Incubating" explanation="A task warming outside the coder queue while humans refine it." />
        <JargonHelp label="Handoff" explanation="Context transferred between a human, Frigg, and a coder." />
      </section>
    </div>
  </details>;
}

function Trend({ delta, window }: { delta: number; window: string }) {
  const trend = trendPresentation(delta);
  const Icon = trend.direction === "up" ? ArrowUp : trend.direction === "down" ? ArrowDown : Minus;
  return <span className="snapshot-trend" data-direction={trend.direction}>
    <Icon size={12} aria-hidden="true" /><span aria-hidden="true">{trend.text}</span>
    <span className="sr-only">{trend.text} over the {window}</span>
  </span>;
}

const STATUS_METRICS = [
  { key: "open", label: "Open work", help: "All tasks that are not done, including blocked and held work." },
  { key: "active", label: "Active coders", help: "Coder leases that are live in this project right now." },
  { key: "ready", label: "Ready to claim", help: "Queued tasks available for a coder to claim." },
  { key: "done", label: "Done in window", help: "Tasks completed during the selected activity window." },
] as const;

function MetricLabel({ label, help }: { label: string; help: string }) {
  return <Tooltip content={help}><button className="status-label" type="button" aria-label={`About ${label}`}>
    <span>{label}</span><CircleHelp size={11} aria-hidden="true" />
  </button></Tooltip>;
}

function StatusBand({
  tasks, agents, overview, error, pending, retry,
}: {
  tasks: QueueTaskDto[];
  agents: AgentDto[];
  overview: QueueOverviewDto | undefined;
  error: boolean;
  pending: boolean;
  retry: () => void;
}) {
  const now = useClock();
  const view = resolveQueryView({ error: error && !overview, pending: pending && !overview, empty: !overview });
  const activeCount = liveAgentRows(agents, now).length;
  const snapshot = { ...(overview?.current ?? homeSnapshot(tasks, Date.now())) };
  snapshot.active = activeCount;
  const stats = STATUS_METRICS.map((metric) => ({
    ...metric,
    value: snapshot[metric.key],
    delta: overview?.trends[metric.key] ?? 0,
  }));
  const windowLabel = overview?.window.label ?? "current window";
  return <Card className="status-band" aria-label="Current project status" data-query-view={view}>
    <div className="status-band-heading"><h2>Project health</h2><span className="status-window"><span>net change</span><span aria-hidden="true">{" · "}</span><strong>{windowLabel}</strong></span></div>
    <div className="status-grid">
      {view === "ready" ? stats.map(({ key, label, help, value, delta }) =>
        <div className="status-cell" data-metric={key} key={key}>
          <span className="status-reading"><span className="status-value">{value}</span><Trend delta={delta} window={windowLabel} /></span>
          <MetricLabel label={label} help={help} />
        </div>) : <div className="status-band-state">
          {view === "loading" ? <LoadingState label="Loading project readings" />
            : view === "error" ? <ErrorState label="Project readings temporarily unavailable." retry={retry} />
              : <EmptyState label="No project readings yet." />}
        </div>}
    </div>
  </Card>;
}

type AttentionRow = {
  key: string;
  taskId: number | null;
  context: string;
  title: string;
  recovery: string | null;
  state: string;
  badge: string;
  kind: AttentionItemDto["kind"];
  actor: { name: string; role: "human" | "mediator" | "coder" | "system" };
  expiresAt?: number;
};

function AttentionActor({ actor, taskLinked }: { actor: AttentionRow["actor"]; taskLinked: boolean }) {
  return <Tooltip content={`${actor.role[0].toUpperCase()}${actor.role.slice(1)} attention source`}>
    <span className="attention-actor" onClick={taskLinked ? (event) => event.currentTarget.closest("article")?.querySelector<HTMLButtonElement>(".attention-task-trigger")?.click() : undefined}>
      <ActorAttribution name={actor.name} role={actor.role} />
    </span>
  </Tooltip>;
}

function attentionRowsFromServer(items: AttentionItemDto[]): AttentionRow[] {
  return items
    // Product: queue_alert never appears on Needs-You (server also omits them).
    .filter((item) => item.kind !== "queue_alert")
    .map((item) => ({
      key: item.episode_id,
      taskId: item.task_id,
      context: item.task_id != null
        ? textOrUntitled(item.title)
        : (item.kind === "conversation" ? "Conflict" : "Project question"),
      // Human-readable reason is the primary line; recovery rides in context/meta.
      title: item.reason || item.title,
      recovery: item.recovery ?? null,
      state: item.state ?? "REVIEW",
      badge: item.badge ?? item.kind.toUpperCase(),
      kind: item.kind,
      actor: {
        name: textOrUntitled(item.actor_name ?? item.kind),
        role: item.actor_role === "mediator" || item.actor_role === "coder" || item.actor_role === "system" ? item.actor_role : "human",
      },
      expiresAt: item.expires_at,
    }));
}

/** Needs you — consumes the canonical server attention API (task #418). */
function NeedsYouPanel({ id, project, openTask }: { id: string; project: string | null; openTask?: (id: number, trigger: HTMLElement) => void }) {
  const now = useClock();
  const [expanded, setExpanded] = useState(false);
  const attention = useQuery({
    queryKey: queryKeys.attention(project ?? ""),
    queryFn: () => dashboardApi.attention(project!),
    enabled: Boolean(project),
  });
  const rows = useMemo(
    () => attentionRowsFromServer(attention.data?.items ?? []),
    [attention.data?.items],
  );
  const total = rows.length;
  const view = resolveQueryView({
    error: attention.isError && total === 0,
    pending: attention.isPending && total === 0,
    empty: attention.isSuccess && total === 0,
  });
  const visibleRows = expanded ? rows : rows.slice(0, 5);
  const hiddenCount = Math.max(0, rows.length - 5);
  const note = attention.isPending
    ? "Checking attention…"
    : attention.isError
      ? "Attention unavailable"
      : total === 0 ? "all clear" : `${total} item${total === 1 ? "" : "s"}`;
  return <section className="needs-you-panel panel" aria-labelledby={id}>
    <header className="panel-heading"><h2 id={id}>Needs you</h2><span className="panel-note">{note}</span></header>
    {attention.isError && total > 0 && <div className="surface-error query-notice" role="alert" data-query-view="error"><span>Attention temporarily unavailable. Showing last-good items.</span><Button size="sm" aria-label="Retry attention" onClick={() => void attention.refetch()}>Retry</Button></div>}
    {attention.isPending && total > 0 && <p className="questions-status" role="status">Checking attention…</p>}
    {view === "error" ? <ErrorState label="Attention temporarily unavailable." retry={() => void attention.refetch()} />
      : view === "loading" ? <LoadingState label="Checking attention…" />
        : view === "empty" ? <EmptyState label="No open questions, blocked tasks, conflicts, or expiring leases." />
          : <div className="attention-list" data-expanded={expanded}>{visibleRows.map((row) => <article className="attention-row" data-kind={row.kind} key={row.key}>
            {row.taskId !== null && <button className="attention-task-trigger" type="button" data-task-trigger={row.taskId} aria-haspopup="dialog" aria-label={`Open task ${row.taskId}: ${row.context}`} onClick={(event) => openTask?.(row.taskId!, event.currentTarget)} />}
            <StatusBadge state={row.state} label={row.badge} />
            <div className="attention-row-copy"><span className="attention-context">{row.taskId !== null ? <><code>#{row.taskId}</code><span aria-hidden="true">—</span><span>{row.kind}</span></> : <span>{row.context}</span>}</span><Tooltip content={[row.title, row.recovery].filter(Boolean).join(" · ")}><b tabIndex={0} onClick={row.taskId !== null ? (event) => event.currentTarget.closest("article")?.querySelector<HTMLButtonElement>(".attention-task-trigger")?.click() : undefined}>{row.title}</b></Tooltip>{row.recovery ? <span className="attention-recovery muted">{row.recovery}</span> : null}<span className="attention-meta"><AttentionActor actor={row.actor} taskLinked={row.taskId !== null} />{row.expiresAt && <span className="attention-lease">ends in <time dateTime={new Date(row.expiresAt).toISOString()}>{formatCountdown(row.expiresAt, now)}</time></span>}</span></div>
            {row.taskId !== null && <ChevronRight className="attention-open-icon" size={15} aria-hidden="true" />}
          </article>)}
          {hiddenCount > 0 && <button className="attention-disclosure" type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? <><ChevronUp size={14} />Show fewer</> : <><ChevronDown size={14} />{hiddenCount} more</>}</button>}
          </div>}
  </section>;
}

function DesktopNotificationsControl() {
  const push = useQuery({ queryKey: queryKeys.pushStatus, queryFn: dashboardApi.pushStatus, retry: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pushUnavailable, setPushUnavailable] = useState(false);
  const permission = typeof Notification === "undefined" ? "unsupported" as const : Notification.permission;
  const state: DesktopNotificationState = busy
    ? "busy"
    : pushUnavailable
      ? "push_unavailable"
      : detectDesktopNotificationState(push.data ?? null, permission);
  const copy = desktopNotificationCopy(state);
  const onEnable = async () => {
    setBusy(true);
    setError("");
    setPushUnavailable(false);
    try {
      // VAPID key must already be in the pushStatus query cache — never await
      // network before requestPermission (Safari drops the user gesture).
      const vapidPublicKey = push.data?.vapid_public_key;
      if (!vapidPublicKey) throw new Error("Server is missing VAPID keys. Wait for status to load, then try again.");
      await enableDesktopNotifications(vapidPublicKey, (body) => dashboardApi.pushSubscribe(body).then(() => undefined));
      await push.refetch();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not enable notifications.";
      setError(message);
      if (/push service|Couldn't register with the push service|AbortError/i.test(message)) {
        setPushUnavailable(true);
      }
    } finally {
      setBusy(false);
    }
  };
  const onDisable = async () => {
    setBusy(true);
    setError("");
    try {
      await disableDesktopNotifications((endpoint) => dashboardApi.pushUnsubscribe(endpoint).then(() => undefined));
      await push.refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not disable notifications.");
    } finally {
      setBusy(false);
    }
  };
  return <div className="desktop-notifications" aria-label="Desktop notifications">
    <div className="desktop-notifications-copy">
      <b>Desktop notifications</b>
      <small>{copy.label} · {copy.help}</small>
    </div>
    {state === "unsubscribed" && (
      <Button className="desktop-notifications-action" size="sm" type="button" disabled={busy} onClick={() => void onEnable()}>Enable</Button>
    )}
    {state === "delivery_error" && (
      <Button className="desktop-notifications-action" size="sm" type="button" disabled={busy} onClick={() => void onEnable()}>Retry</Button>
    )}
    {state === "subscribed" && (
      <Button className="desktop-notifications-action" size="sm" variant="ghost" type="button" disabled={busy} onClick={() => void onDisable()}>Disable</Button>
    )}
    {error && <p className="desktop-notifications-error" role="alert">{error}</p>}
  </div>;
}

function Raceway({ overview }: { overview: QueueOverviewDto }) {
  const transitions = latestTaskTransitions(overview.transitions);
  return <section className="raceway panel" aria-labelledby="raceway-title">
    <header className="panel-heading">
      <h2 id="raceway-title">Recent transitions</h2>
      <span className="panel-note">recent · {overview.window.label}</span>
    </header>
    {transitions.length === 0 ? <p className="empty-copy">No task movement in the last 7 days.</p> :
      <div className="raceway-lanes">{transitions.map((event) =>
        <div className="raceway-lane" key={event.id}>
          <div className="raceway-label"><IdentityMark identity={taskIdentity(event.task_id)} labelled /><span>#{event.task_id}</span><b>{textOrUntitled(event.title)}</b></div>
          <div className="raceway-track">
            <span className="observed-transition"><i>{displayTaskState(event.from_state)}</i><span aria-hidden="true">→</span><i>{displayTaskState(event.to_state)}</i></span>
            <time dateTime={new Date(event.changed_at).toISOString()}>{new Date(event.changed_at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time>
          </div>
        </div>)}</div>}
  </section>;
}

function OnHoldMeta({ task, now }: { task: QueueTaskDto; now: number }) {
  if (task.state === "INCUBATING" && task.incubate_until) {
    return <span className="on-hold-meta"><span>Warms in</span><time dateTime={new Date(task.incubate_until).toISOString()}>{formatCountdown(task.incubate_until, now)}</time></span>;
  }
  if (task.state === "HELD") {
    return <span className="on-hold-meta">{holdCauseLabel(task.hold_cause)}</span>;
  }
  return null;
}

function OnHoldPanel({ tasks, openTask }: {
  tasks: QueueTaskDto[];
  openTask?: (id: number, trigger: HTMLElement) => void;
}) {
  const now = useClock();
  const rows = useMemo(() => onHoldRows(tasks), [tasks]);
  return <section className="on-hold-panel panel" aria-labelledby="on-hold-title">
    <header className="panel-heading"><h2 id="on-hold-title">On hold</h2><span className="panel-note">{rows.length === 0 ? "none" : `${rows.length} parked`}</span></header>
    {rows.length === 0
      ? <EmptyState label="No tasks on hold. Held and incubating work will appear here." />
      : <div className="on-hold-list">{rows.map((task) => <article className="on-hold-row" data-state={task.state} key={task.id}>
        <StateChip state={task.state} />
        <div className="on-hold-copy">
          <b>{textOrUntitled(task.title)}</b>
          <span className="on-hold-detail"><span>#{task.id}</span><OnHoldMeta task={task} now={now} /><span>{textOrUntitled(task.submitted_by)}</span></span>
        </div>
        <button className="on-hold-task-trigger" type="button" data-task-trigger={task.id} aria-haspopup="dialog" aria-label={`Open task ${task.id}: ${textOrUntitled(task.title)}`} onClick={(event) => openTask?.(task.id, event.currentTarget)}>Open <ChevronRight size={13} aria-hidden="true" /></button>
      </article>)}</div>}
  </section>;
}

function QueueSurface({ tasks, error, pending, retry, state, update, openTask }: {
  tasks: QueueTaskDto[];
  error: boolean;
  pending: boolean;
  retry: () => void;
  state: DashboardUrlState;
  update: (next: Partial<DashboardUrlState>) => void;
  openTask?: (id: number, trigger: HTMLElement) => void;
}) {
  const now = useClock();
  const [showAll, setShowAll] = useState(false);
  const sort = state.sort ?? "priority";
  const direction = state.direction ?? "asc";
  const data = useMemo(() => queueRows(tasks, { state: state.state, agent: state.agent, sort, direction, includeHidden: showAll }), [tasks, state.state, state.agent, sort, direction, showAll]);
  const allQueueCount = useMemo(() => queueRows(tasks, { state: null, agent: null, sort, direction, includeHidden: true }).length, [tasks, sort, direction]);
  const table = useReactTable({ data, columns: QUEUE_COLUMNS, meta: { queueNow: now, openQueueTask: openTask }, getRowId: (task) => String(task.id), getCoreRowModel: getCoreRowModel() });
  const setSort = (next: QueueSort) => update({ sort: next, direction: sort === next && direction === "desc" ? "asc" : "desc" });
  const view = resolveQueryView({ error: error && tasks.length === 0, pending: pending && tasks.length === 0, empty: data.length === 0 });
  return <Card className="queue-panel panel" aria-labelledby="queue-title">
    <header className="panel-heading queue-heading">
      <h2 id="queue-title">Queue</h2>
      <span className="panel-note">{data.length} {state.state || showAll ? "shown" : "actionable"}</span>
      <div className="queue-sort-controls">
        <CompletedArchive key={state.project} project={state.project!} onSelect={(id, trigger) => openTask?.(id, trigger)} />
        {!state.state && (showAll || allQueueCount > data.length) && <Button className="queue-visibility" variant="ghost" size="sm" type="button" aria-pressed={showAll} onClick={() => setShowAll((value) => !value)}><ListFilter size={13} />{showAll ? "Show actionable" : `View all ${allQueueCount}`}</Button>}
        <Select id="queue-sort" ariaLabel="Sort queue" value={sort} onValueChange={(value) => setSort(value as QueueSort)} options={QUEUE_SORTS.map((value) => ({ value, label: ({ priority: "Priority", updated: "Recently updated", created: "Recently created", title: "Title", state: "Status" } satisfies Record<QueueSort, string>)[value] }))} />
        <Tooltip content={`Sort ${direction === "desc" ? "ascending" : "descending"}`}><Button className="direction-button" variant="ghost" size="icon" type="button" aria-label={`Sort ${direction === "desc" ? "ascending" : "descending"}`} onClick={() => update({ sort, direction: direction === "desc" ? "asc" : "desc" })}>
          {direction === "desc" ? <ArrowDown size={13} /> : <ArrowUp size={13} />}
        </Button></Tooltip>
      </div>
    </header>
    {error && tasks.length > 0 && <QueryNotice label="Queue" retry={retry} stale />}
    {view === "error" ? <ErrorState label="Queue temporarily unavailable." retry={retry} /> : view === "loading" ? <LoadingState label="Loading queue…" /> : view === "empty" ? <EmptyState label="No tasks match the current URL filters." /> : <>
      <div className="queue-table-wrap"><Table><TableHeader>{table.getHeaderGroups().map((group) => <TableRow key={group.id}>{group.headers.map((header) =>
        <TableHead key={header.id}>{flexRender(header.column.columnDef.header, header.getContext())}</TableHead>)}</TableRow>)}</TableHeader>
        <TableBody>{table.getRowModel().rows.map((row) => <TableRow key={row.id}>{row.getVisibleCells().map((cell) =>
          <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>)}</TableRow>)}</TableBody></Table></div>
      <div className="queue-cards">{table.getRowModel().rows.map((row) => <article className="queue-card" key={row.id}>
        <div className="queue-card-top"><StateChip state={row.original.state} /><span className="queue-priority">P{row.original.priority}</span></div>
        <h3>{textOrUntitled(row.original.title)}</h3>
        <div className="queue-card-detail"><span>#{row.original.id}</span><time dateTime={new Date(row.original.created_at).toISOString()}>opened {formatQueueAge(row.original.created_at, now)}</time>{row.original.evidence_count > 0 && <span>{row.original.evidence_count} evidence</span>}</div>
        <TaskPrStatus resultPrUrl={row.original.result_pr_url} resultPrNumber={row.original.result_pr_number} prVerification={row.original.pr_verification} />
        <div className="queue-card-meta"><QueueActor task={row.original} /><QueueTiming task={row.original} now={now} /></div>
        <Button className="queue-open-button queue-task-trigger" variant="ghost" size="sm" type="button" data-task-trigger={row.original.id} aria-haspopup="dialog" aria-label={`Open task ${row.original.id}: ${textOrUntitled(row.original.title)}`} onClick={(event) => openTask?.(row.original.id, event.currentTarget)}>Open <ChevronRight size={13} /></Button>
      </article>)}</div>
    </>}
  </Card>;
}

function ActiveRoster({ agents, clockActive, error = false, openTask, pending = false, retry = () => undefined, titleId, collapsible = false }: {
  agents: AgentDto[];
  clockActive: boolean;
  error?: boolean;
  openTask: (id: number, trigger: HTMLElement) => void;
  pending?: boolean;
  retry?: () => void;
  titleId: string;
  /** Desktop home strip: collapsed by default with Active Coders: N header. */
  collapsible?: boolean;
}) {
  const now = useClock(clockActive);
  const liveAgents = liveAgentRows(agents, now);
  const [expanded, setExpanded] = useState(false);
  const view = resolveQueryView({ error: error && liveAgents.length === 0, pending: pending && liveAgents.length === 0, empty: liveAgents.length === 0 });
  const body = <>
    {error && liveAgents.length > 0 && <QueryNotice label="Active agents" retry={retry} stale />}
    {view === "error" ? <ErrorState label="Active agents temporarily unavailable." retry={retry} />
      : view === "loading" ? <LoadingState label="Loading active agents…" />
        : view === "empty" ? <EmptyState label="No coder is holding a live lease in this project." />
          : <div className="roster-list">{liveAgents.map((row) => <article className="roster-row" data-state={row.state} key={`${row.agent}:${row.task_id}`}>
            <div className="roster-actor"><ActorLabel name={textOrUntitled(row.agent)} role="coder" /><StateChip state={row.state} /></div>
            <button className="roster-task-trigger" type="button" data-task-trigger={row.task_id} aria-haspopup="dialog" aria-label={`Open task ${row.task_id}: ${textOrUntitled(row.title)}`} onClick={(event) => openTask(row.task_id, event.currentTarget)}>
              <span className="roster-task"><span>#{row.task_id}</span><strong>{textOrUntitled(row.title)}</strong></span>
              <span className="roster-lease"><span>Lease</span><time dateTime={new Date(row.lease_expires_at).toISOString()}>{formatCountdown(row.lease_expires_at, now)}</time></span>
              <ChevronRight size={14} aria-hidden="true" />
            </button>
          </article>)}</div>}
  </>;
  if (collapsible) {
    return <section className="roster panel active-coders-strip" data-expanded={expanded} aria-labelledby={titleId}>
      <button
        type="button"
        className="active-coders-toggle"
        id={titleId}
        aria-expanded={expanded}
        aria-controls={`${titleId}-body`}
        onClick={() => setExpanded((value) => !value)}
      >
        <span>Active Coders: {liveAgents.length}</span>
        {expanded ? <ChevronUp size={15} aria-hidden="true" /> : <ChevronDown size={15} aria-hidden="true" />}
      </button>
      {expanded ? <div className="active-coders-body" id={`${titleId}-body`}>{body}</div> : null}
    </section>;
  }
  return <aside className="roster panel" aria-labelledby={titleId}>
    <header className="panel-heading"><h2 id={titleId}>Active agents</h2><span className="panel-note">{liveAgents.length} current</span></header>
    {body}
  </aside>;
}

function LoadingHome() {
  return <main className="dashboard-shell"><div className="loading-block" role="status"><span className="live-pulse" />Loading the operational snapshot…</div></main>;
}

function activityActor(thread: ThreadDto): { name: string; role: ActorRole } {
  const role = thread.last_role ?? threadRole(thread.kind);
  const fallback = role === "human" ? "submitter" : role === "mediator" ? "steward" : role;
  return { name: thread.last_author?.trim() || fallback, role };
}

function ActivityTimestamp({ value }: { value: number }) {
  const date = new Date(value);
  const visible = date.toLocaleDateString([], { month: "short", day: "numeric" });
  return <Tooltip content={date.toLocaleString()}><time dateTime={date.toISOString()}>{visible}</time></Tooltip>;
}

function FeedSurface({ error, pending, project, retry, threads, selected, onSelect, openTask }: {
  error: boolean;
  pending: boolean;
  project: string;
  retry: () => void;
  threads: ThreadDto[];
  selected: number | null;
  onSelect: (thread: ThreadDto) => void;
  openTask?: (id: number, trigger: HTMLElement) => void;
}) {
  const groups = useMemo(() => activityThreadGroups(threads), [threads]);
  const current = threads.find((thread) => thread.id === selected) ?? groups[0]?.thread ?? null;
  const currentGroup = current ? groups.find((group) => group.threadIds.includes(current.id)) : null;
  const context = currentGroup?.thread ?? current;
  const view = resolveQueryView({ error: error && threads.length === 0, pending: pending && threads.length === 0, empty: groups.length === 0 && current === null });
  return <section className="feed-surface panel" aria-label="Activity">
    <header className="panel-heading"><h2>Activity</h2><span className="panel-note">{groups.length} recent</span></header>
    {error && threads.length > 0 && <QueryNotice label="Activity" retry={retry} stale />}
    {view === "error" ? <ErrorState label="Activity temporarily unavailable." retry={retry} /> : view === "loading" ? <LoadingState label="Loading activity…" /> : view === "empty" ? <EmptyState label="No activity has been recorded yet. New task and project conversations will appear here." /> : <div className="feed-layout">
      <nav aria-label="Project threads">{groups.map((group) => {
        const thread = group.thread;
        const actor = activityActor(thread);
        const active = Boolean(current && group.threadIds.includes(current.id));
        const taskTitle = group.taskTitle ?? "Task activity";
        const head = group.taskId !== null ? `#${group.taskId} — ${taskTitle}` : "Project activity";
        return <div className={active ? "feed-row active" : "feed-row"} data-thread-id={thread.id} key={thread.id}>
          <button type="button" className="feed-row-select" aria-current={active ? "true" : undefined} onClick={() => onSelect(thread)}>
            <span className="feed-row-head"><b>{head}</b>{thread.task_state && <StatusBadge state={thread.task_state} />}</span>
            <span className="feed-row-summary">{threadSummary(thread, threads)}</span>
            <span className="feed-row-meta"><ActorLabel role={actor.role} name={actor.name} /><span className="feed-row-detail">{group.threadIds.length > 1 && <i>{group.threadIds.length} sessions</i>}<ActivityTimestamp value={thread.last_activity} /></span></span>
          </button>
          {group.taskId !== null && <button type="button" className="feed-task-trigger" data-task-trigger={group.taskId} aria-haspopup="dialog" aria-label={`Open task ${group.taskId}: ${taskTitle}`} onClick={(event) => openTask?.(group.taskId!, event.currentTarget)}>Open <ChevronRight size={13} aria-hidden="true" /></button>}
        </div>;
      })}</nav>
      <div className="feed-timeline">{current && context ? <>
        <header className="feed-timeline-heading">
          <div><span>{currentGroup?.taskId !== null && currentGroup?.taskId !== undefined ? `Task #${currentGroup.taskId}` : "Project activity"}</span><h3>{currentGroup?.taskTitle || context.task_title || threadSummary(context, threads)}</h3></div>
          <div>{context.task_state && <StatusBadge state={context.task_state} />}<ActivityTimestamp value={context.last_activity} /></div>
        </header>
        <DashboardErrorBoundary resetKey={`${project}:${current.root_id ?? current.id}:${current.id}`} heading="Activity stopped rendering"><TimelineIsland selection={{ projectId: project, sessionId: current.root_id ?? current.id, threadId: current.id, taskId: current.task_id }} onSelectionChange={(next) => { const thread = threads.find((item) => item.id === next.threadId); if (thread) onSelect(thread); }} /></DashboardErrorBoundary>
      </> : <EmptyState label="Choose a conversation to inspect its timeline." />}</div>
    </div>}
  </section>;
}

function YouSurface({ project, agents, agentsError, agentsPending, clockActive, retryAgents, openTask }: { project: string | null; agents: AgentDto[]; agentsError: boolean; agentsPending: boolean; clockActive: boolean; retryAgents: () => void; openTask: (id: number, trigger: HTMLElement) => void }) {
  return <section className="you-surface" aria-label="Needs you"><NeedsYouPanel id="mobile-needs-you-title" project={project} openTask={openTask} /><ActiveRoster agents={agents} clockActive={clockActive} error={agentsError} openTask={openTask} pending={agentsPending} retry={retryAgents} titleId="mobile-active-agents-title" /></section>;
}

function CommandPalette({ open, projects, tasks, threads, close, navigate, selectProject, openTask, openThread }: {
  open: boolean;
  projects: MembershipDto[];
  tasks: QueueTaskDto[];
  threads: ThreadDto[];
  close: () => void;
  navigate: (view: DashboardUrlState["view"]) => void;
  selectProject: (id: string) => void;
  openTask: (id: number, trigger: HTMLElement) => void;
  openThread: (thread: ThreadDto) => void;
}) {
  const [query, setQuery] = useState("");
  const field = React.useRef<HTMLInputElement>(null);
  React.useLayoutEffect(() => {
    if (!open) return;
    setQuery("");
    field.current?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [close, open]);
  useEffect(() => {
    if (!open) return;
    const moveFromSearch = (event: KeyboardEvent) => {
      if (event.key !== "ArrowDown" || !(event.target as HTMLElement | null)?.matches('[role="combobox"]')) return;
      event.preventDefault();
      window.setTimeout(() => document.querySelector<HTMLButtonElement>(".command-results button")?.focus(), 0);
    };
    window.addEventListener("keydown", moveFromSearch, true);
    return () => window.removeEventListener("keydown", moveFromSearch, true);
  }, [open]);
  if (!open) return null;
  const needle = query.trim().toLowerCase();
  const matchingTasks = tasks.filter((task) => !needle || `${task.id} ${task.title} ${task.state} ${task.lease_agent ?? ""}`.toLowerCase().includes(needle)).slice(0, 8);
  const matchingProjects = projects.filter((project) => {
    const label = paletteProjectLabel(project, projects);
    return !needle || `${label} ${project.projectName} ${project.projectId} ${project.orgId ?? ""} ${project.orgName ?? ""}`.toLowerCase().includes(needle);
  }).slice(0, 8);
  const matchingThreads = threads.map((thread) => ({ thread, summary: threadSummary(thread, threads) })).filter(({ thread, summary }) => !needle || `${thread.id} ${thread.kind} ${summary}`.toLowerCase().includes(needle)).slice(0, 5);
  const onKeys = (event: React.KeyboardEvent<HTMLElement>) => {
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".command-results button")];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus(); }
    if (event.key === "Tab") { const focusables = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])")]; const at = focusables.indexOf(document.activeElement as HTMLElement); if ((event.shiftKey && at === 0) || (!event.shiftKey && at === focusables.length - 1)) { event.preventDefault(); focusables[event.shiftKey ? focusables.length - 1 : 0]?.focus(); } }
  };
  return <div className="command-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><section className="command-dialog" role="dialog" aria-modal="true" aria-labelledby="command-title" onKeyDown={onKeys}><header><Command size={14} /><h2 id="command-title">Go to</h2><button aria-label="Close command palette" onClick={close}><X size={14} /></button></header><input ref={field} role="combobox" aria-controls="command-results" aria-expanded="true" aria-label="Search views, projects, tasks, and threads" placeholder="View, project, task, or thread…" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(".command-results button")?.focus(); } }} /><div className="command-results" id="command-results"><button onClick={() => { navigate("dashboard"); close(); }}>Operations</button><button onClick={() => { navigate("team"); close(); }}>Team analytics</button><button onClick={() => { navigate("knowledge"); close(); }}>Knowledge</button><button onClick={() => { navigate("settings"); close(); }}>Settings</button><button onClick={() => { navigate("org-settings"); close(); }}>Org Settings</button><button type="button" onClick={() => { window.location.assign("/faq"); close(); }}>Help / FAQ</button>{matchingProjects.map((project) => <button key={`p:${project.projectId}`} onClick={() => { selectProject(project.projectId); close(); }}>{paletteProjectLabel(project, projects)}</button>)}{matchingTasks.map((task) => <button key={`t:${task.id}`} onClick={(event) => { openTask(task.id, event.currentTarget); close(); }}><IdentityMark identity={taskIdentity(task.id)} /><span>#{task.id} · {task.title}</span><i>{task.state}</i></button>)}{matchingThreads.map(({ thread, summary }) => <button key={`r:${thread.id}`} onClick={() => { openThread(thread); close(); }}><span>Thread {thread.id} · {summary}</span></button>)}</div></section></div>;
}

const SHELL_VIEWS = [
  { view: "dashboard" as const, label: "Operations", icon: LayoutDashboard, group: "Work" },
  { view: "team" as const, label: "Team analytics", icon: Users, group: "Project" },
  { view: "knowledge" as const, label: "Knowledge", icon: BookOpen, group: "Project" },
  { view: "settings" as const, label: "Project settings", icon: Settings, group: "Project" },
  { view: "org-settings" as const, label: "Org settings", icon: Building2, group: "Organization" },
];

function PageHeader({ view, projectName, onAction }: { view: DashboardUrlState["view"]; projectName: string; onAction: () => void }) {
  const content = view === "knowledge"
    ? { title: "Knowledge", detail: `Project memory for ${projectName}`, action: "Browse concepts", icon: BookOpen }
    : view === "team"
      ? { title: "Team analytics", detail: `Analytics for ${projectName}`, action: "View analytics", icon: Users }
      : view === "settings"
        ? { title: "Project settings", detail: `Project administration for ${projectName}`, action: "Open settings", icon: Settings }
      : view === "org-settings"
        ? { title: "Org settings", detail: "Provider keys, models, and org policy", action: "Open org settings", icon: Building2 }
      : { title: "Operations", detail: projectName, action: "Find work", icon: Search };
  const ActionIcon = content.icon;
  return <header className="page-header"><div><span>{content.detail}</span><h1>{content.title}</h1></div>{view !== "team" && <Button type="button" variant="secondary" onClick={onAction}><ActionIcon size={14} />{content.action}</Button>}</header>;
}

export function App() {
  const [urlState, setUrlState] = useState(() => parseUrlState(window.location.search));
  const [paletteOpen, setPaletteOpen] = useState(false);
  const returnFocus = React.useRef<HTMLElement | null>(null);
  const [projectNotice, setProjectNotice] = useState("");
  const [mobileTab, setMobileTab] = useState<"feed" | "queue" | "you" | "knowledge" | "team" | "settings">(() => readMobileTab() as "feed" | "queue" | "you" | "knowledge" | "team" | "settings");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed);
  const [themePreference, setThemePreference] = useState<ThemePreference>(readThemePreference);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(() => typeof window.matchMedia === "function" && window.matchMedia(MOBILE_MEDIA_QUERY).matches);
  const mobileMenuButton = React.useRef<HTMLButtonElement | null>(null);
  const paletteReturnFocus = React.useRef<HTMLElement | null>(null);
  const projects = useProjects();
  const session = useQuery({ queryKey: queryKeys.session, queryFn: dashboardApi.session, retry: false });
  const memberships = projects.data?.projects ?? [];
  const orgGroups = useMemo(() => groupMembershipsByOrg(memberships), [memberships]);
  const selectedProject = useMemo(() => {
    if (urlState.project) return urlState.project;
    if (memberships.length === 0) return null;
    const recovered = recoverSelection(memberships, null);
    return recovered?.projectId ?? memberships[0]?.projectId ?? null;
  }, [urlState.project, memberships]);
  const selectedMembership = memberships.find((item) => item.projectId === selectedProject) ?? null;
  const activeOrgKey = selectedMembership ? resolveOrgKey(selectedMembership) : (orgGroups[0]?.key ?? null);
  /** Org Settings resolves from URL org (or selected membership org), not the shell project alone. */
  const onOrgSettings = urlState.view === "org-settings";
  const orgSettingsOrgId = onOrgSettings
    ? (urlState.org === NO_ORG_KEY
      ? null
      : (urlState.org ?? selectedMembership?.orgId ?? null))
    : null;
  // Jump/project chrome on Org Settings follows the form org, not the shell project cohort.
  const orgProjects = useMemo(() => {
    if (onOrgSettings && orgSettingsOrgId) {
      return memberships.filter((item) => item.orgId === orgSettingsOrgId);
    }
    return activeOrgKey ? memberships.filter((item) => resolveOrgKey(item) === activeOrgKey) : [];
  }, [memberships, activeOrgKey, onOrgSettings, orgSettingsOrgId]);
  const home = useProjectHome(selectedProject);
  const tasks = home.queue.data?.tasks ?? EMPTY_TASKS;
  const agents = home.agents.data?.agents ?? EMPTY_AGENTS;
  const live = useProjectEvents(selectedProject);
  const threads = useQuery({ queryKey: queryKeys.threads(selectedProject ?? ""), queryFn: () => dashboardApi.threads(selectedProject!), enabled: Boolean(selectedProject) });
  const seatReadiness = useQuery({
    queryKey: queryKeys.seatReadiness(selectedProject ?? ""),
    queryFn: () => dashboardApi.seatReadiness(selectedProject!),
    enabled: Boolean(selectedProject),
    retry: false,
  });
  const overview = home.queue.data?.overview;
  const knownProjects = React.useRef(new Set<string>());

  useEffect(() => applyThemePreference(themePreference), [themePreference]);
  useEffect(() => {
    if (!urlState.project && selectedProject) {
      const next = { ...urlState, project: selectedProject };
      writeUrlState("replace", next);
      setUrlState(next);
    }
  }, [selectedProject, urlState]);
  useEffect(() => {
    if (selectedMembership) writeLastProjectForOrg(resolveOrgKey(selectedMembership), selectedMembership.projectId);
  }, [selectedMembership]);
  // Org Settings must carry a real org= in the URL; never leave or pin NO_ORG_KEY.
  useEffect(() => {
    if (urlState.view !== "org-settings") return;
    if (urlState.org && urlState.org !== NO_ORG_KEY) return;
    const orgId = selectedMembership?.orgId;
    if (!orgId) {
      if (urlState.org === NO_ORG_KEY) {
        const next = { ...urlState, org: null };
        writeUrlState("replace", next);
        setUrlState(next);
      }
      return;
    }
    const next = { ...urlState, org: orgId };
    writeUrlState("replace", next);
    setUrlState(next);
  }, [urlState, selectedMembership]);
  useEffect(() => {
    const restore = () => setUrlState(parseUrlState(window.location.search));
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);
  useEffect(() => {
    if (urlState.view === "knowledge" || urlState.view === "team" || urlState.view === "settings" || urlState.view === "org-settings") {
      setMobileTab(urlState.view === "org-settings" ? "settings" : urlState.view);
    }
    setSidebarOpen(false);
  }, [urlState.view]);
  useEffect(() => {
    if (!sidebarOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setSidebarOpen(false);
      requestAnimationFrame(() => mobileMenuButton.current?.focus());
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [sidebarOpen]);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(MOBILE_MEDIA_QUERY);
    const restoreTopLevelTab = () => {
      setIsMobile(media.matches);
      if (!media.matches || urlState.view !== "dashboard" || (mobileTab !== "knowledge" && mobileTab !== "team" && mobileTab !== "settings")) return;
      const next = { ...urlState, view: mobileTab };
      writeUrlState("replace", next);
      setUrlState(next);
    };
    restoreTopLevelTab();
    media.addEventListener("change", restoreTopLevelTab);
    return () => media.removeEventListener("change", restoreTopLevelTab);
  }, [mobileTab, urlState]);
  useEffect(() => {
    for (const project of projects.data?.projects ?? []) knownProjects.current.add(project.projectId);
  }, [projects.data]);
  useEffect(() => {
    if (projects.error instanceof DashboardApiError && projects.error.unauthorized) window.location.assign("/signin");
  }, [projects.error]);
  useEffect(() => {
    const onCommand = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k" || target?.matches("input, textarea, select, [contenteditable=true]") || target?.closest(".aui-thread")) return;
      event.preventDefault();
      setPaletteOpen((value) => {
        if (!value) paletteReturnFocus.current = target;
        else requestAnimationFrame(() => paletteReturnFocus.current?.isConnected && paletteReturnFocus.current.focus());
        return !value;
      });
    };
    window.addEventListener("keydown", onCommand);
    return () => window.removeEventListener("keydown", onCommand);
  }, []);
  useEffect(() => {
    if (live !== "unavailable" || !selectedProject || !knownProjects.current.has(selectedProject)) return;
    void projects.refetch().then((result) => {
      if (!result.data || result.data.projects.some((project) => project.projectId === selectedProject)) return;
      const recovered = recoverSelection(result.data.projects, selectedProject);
      const next = { ...urlState, project: recovered?.projectId ?? null, task: null, thread: null, concept: null, state: null, agent: null };
      writeUrlState("replace", next);
      setUrlState(next);
    });
  }, [live, projects, selectedProject, urlState]);

  const update = (patch: Partial<DashboardUrlState>) => {
    const next = { ...urlState, ...patch };
    writeUrlState("push", next);
    setUrlState(next);
  };
  const setTab = (tab: typeof mobileTab) => { setMobileTab(tab); saveMobileTab(tab); if (tab === "knowledge" || tab === "team" || tab === "settings") navigate(tab); else navigate("dashboard"); };
  const openTask = (id: number, trigger?: HTMLElement) => {
    if (trigger) returnFocus.current = trigger;
    update({ task: id, thread: null });
  };
  const closeTask = () => {
    const closingId = urlState.task;
    update({ task: null, thread: null });
    requestAnimationFrame(() => {
      resolveTaskTrigger(closingId, returnFocus.current)?.focus();
    });
  };
  const navigate = (view: DashboardUrlState["view"]) =>
    update({
      view,
      concept: view === "knowledge" ? urlState.concept : null,
      // Org settings are org-scoped: pin org id so chrome stays stable across same-org project switches.
      org: view === "org-settings" ? (selectedMembership?.orgId ?? urlState.org) : urlState.org,
    });
  const closePalette = () => { setPaletteOpen(false); requestAnimationFrame(() => paletteReturnFocus.current?.isConnected && paletteReturnFocus.current.focus()); };
  const openPalette = (trigger?: HTMLElement) => { paletteReturnFocus.current = trigger ?? document.activeElement as HTMLElement; setPaletteOpen(true); };
  const openThread = (thread: ThreadDto) => { setMobileTab("feed"); saveMobileTab("feed"); update({ view: "dashboard", thread: thread.id, task: null }); };

  if (projects.isPending) return <LoadingHome />;
  if (projects.isError) return <main className="dashboard-shell"><section className="error-panel" role="alert"><h1>Projects unavailable</h1><p>The identity-wide project list could not be loaded.</p><button type="button" onClick={() => projects.refetch()}>Retry</button></section></main>;
  if (!projects.data.projects.length) return <Onboarding onCreated={(project, warning) => { void projects.refetch().then(() => { const next = { ...urlState, project, view: "dashboard" as const }; writeUrlState("replace", next); setUrlState(next); setProjectNotice(warning ?? ""); }); }} />;

  const closeMobileSidebar = () => { setSidebarOpen(false); requestAnimationFrame(() => mobileMenuButton.current?.focus()); };
  const clearProjectLocalState = { task: null as null, thread: null as null, concept: null as null, state: null as null, agent: null as null };
  const orgSettingsMembership = orgSettingsOrgId
    ? (memberships.find((m) => m.orgId === orgSettingsOrgId && m.role === "admin")
      ?? memberships.find((m) => m.orgId === orgSettingsOrgId)
      ?? null)
    : null;
  const changeProject = (project: string) => {
    setProjectNotice("");
    const membership = memberships.find((item) => item.projectId === project);
    if (membership) writeLastProjectForOrg(resolveOrgKey(membership), project);
    if (onOrgSettings) {
      // Demoted picker: jump to Operations for the chosen project; do not reframe Org Settings.
      update({
        project,
        view: "dashboard",
        ...clearProjectLocalState,
        org: membership?.orgId ?? (urlState.org !== NO_ORG_KEY ? urlState.org : null),
      });
      if (isMobile) closeMobileSidebar();
      return;
    }
    update({ project, ...clearProjectLocalState });
    if (isMobile) closeMobileSidebar();
  };
  const changeOrg = (orgKey: string) => {
    setProjectNotice("");
    const next = pickProjectForOrg(memberships, orgKey);
    if (!next) return;
    writeLastProjectForOrg(orgKey, next.projectId);
    // Same project-local clear as changeProject — keep queue sort/direction (project-agnostic).
    // On Org Settings, pin real org ids only — never serialize NO_ORG_KEY into the URL.
    if (onOrgSettings) {
      if (!next.orgId || orgKey === NO_ORG_KEY) {
        update({
          project: next.projectId,
          view: "dashboard",
          org: null,
          ...clearProjectLocalState,
        });
      } else {
        update({
          project: next.projectId,
          view: "org-settings",
          org: next.orgId,
          ...clearProjectLocalState,
        });
      }
    } else {
      update({ project: next.projectId, ...clearProjectLocalState });
    }
    if (isMobile) closeMobileSidebar();
  };
  const toggleSidebar = () => { const next = !sidebarCollapsed; setSidebarCollapsed(next); saveSidebarCollapsed(next); };
  const changeThemePreference = (preference: ThemePreference) => {
    applyThemePreference(preference);
    saveThemePreference(preference);
    setThemePreference(preference);
  };
  const signOut = async () => { await fetch("/api/auth/sign-out", { method: "POST", credentials: "same-origin" }).catch(() => undefined); window.location.assign("/signin"); };
  const pageAction = () => {
    if (urlState.view === "knowledge") { update({ concept: null }); requestAnimationFrame(() => document.querySelector<HTMLElement>(".knowledge-search input, .knowledge-tree")?.focus()); return; }
    if (urlState.view === "team") { document.querySelector<HTMLElement>(".analytics-metric-rail")?.scrollIntoView({ block: "start", behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); return; }
    if (urlState.view === "settings" || urlState.view === "org-settings") { document.querySelector<HTMLElement>(".settings-view")?.scrollIntoView({ block: "start", behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); return; }
    openPalette();
  };
  const activeOrgGroup = orgGroups.find((group) => group.key === activeOrgKey) ?? null;
  const showOrgSwitcher = orgGroups.length > 1;
  const orgOptions = orgGroups.map((group) => ({ value: group.key, label: group.label }));
  const projectOptions = [
    ...(!selectedMembership && selectedProject ? [{ value: selectedProject, label: `Unavailable project · ${selectedProject}` }] : []),
    ...orgProjects.map((project) => ({ value: project.projectId, label: projectOptionLabel(project, orgProjects) })),
  ];
  const accountName = session.data?.name || "Account";
  const accountEmail = session.data?.email || "Signed in";
  return <main className="dashboard-shell" data-dashboard-generation="react" data-mobile-tab={mobileTab} data-sidebar-collapsed={sidebarCollapsed}>
    {sidebarOpen && <button className="sidebar-scrim" type="button" aria-label="Close navigation" onClick={closeMobileSidebar} />}
    <aside className={`shell-sidebar${sidebarOpen ? " is-open" : ""}`} aria-label="Dashboard navigation" inert={isMobile && !sidebarOpen ? true : undefined}>
      <div className="sidebar-brand"><a className="wordmark" href="/dashboard/" aria-label="memracer dashboard"><i className="brand-notch" /><span>mem</span><b>racer</b></a><Tooltip content={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}><Button className="sidebar-collapse" variant="ghost" size="icon" type="button" aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"} onClick={toggleSidebar}>{sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}</Button></Tooltip><Button className="sidebar-mobile-close" variant="ghost" size="icon" type="button" aria-label="Close navigation" onClick={closeMobileSidebar}><X size={17} /></Button></div>
      <div className="sidebar-project">
        {showOrgSwitcher ? (
          <><label htmlFor="org-select">Organization</label><Select id="org-select" ariaLabel="Organization" value={activeOrgKey ?? ""} onValueChange={changeOrg} options={orgOptions} /></>
        ) : activeOrgGroup ? (
          <p className="org-current" aria-label={`Organization ${activeOrgGroup.label}`}><span className="section-kicker">Organization</span><b>{activeOrgGroup.label}</b></p>
        ) : null}
        {onOrgSettings ? (
          <>
            <label htmlFor="project-select">Jump to project Operations</label>
            <Select
              id="project-select"
              ariaLabel="Jump to project Operations"
              value={selectedProject ?? ""}
              onValueChange={changeProject}
              options={projectOptions}
            />
          </>
        ) : (
          <>
            <label htmlFor="project-select">Project</label>
            <Select id="project-select" ariaLabel="Project" value={selectedProject ?? ""} onValueChange={changeProject} options={projectOptions} />
          </>
        )}
        {!onOrgSettings && selectedMembership?.role === "admin" && <ProjectCreationMenu membership={selectedMembership} onCreated={(project, warning) => { void projects.refetch().then(() => { setProjectNotice(warning ?? ""); update({ project, view: "dashboard", ...clearProjectLocalState }); }); }} />}
      </div>
      <nav className="sidebar-nav" aria-label="Primary">{SHELL_VIEWS.map(({ view, label, icon: Icon, group }, index) => <React.Fragment key={view}>{index === 0 || SHELL_VIEWS[index - 1].group !== group ? <span className="sidebar-group">{group}</span> : null}<a aria-current={urlState.view === view ? "page" : undefined} href={serializeUrlState({ ...urlState, view })} onClick={(event) => { event.preventDefault(); navigate(view); if (isMobile) closeMobileSidebar(); }}><Icon size={17} /><span>{label}</span></a></React.Fragment>)}</nav>
      <div className="sidebar-tools"><button className="palette-button" type="button" aria-label="Open command palette" onClick={(event) => openPalette(event.currentTarget)}><Command size={15} /><span>Go to</span><kbd>⌘K</kbd></button><div className="live-heartbeat" data-status={live} role="status" aria-live={live === "live" || live === "connecting" ? "off" : "polite"}><span /> <b>{liveConnectionLabel(live)}</b></div><VisualKey /></div>
      <details className="account-menu"><summary><Avatar name={accountName} role="human" size={28} /><span><b>{accountName}</b><small>{accountEmail}</small></span><ChevronUp size={14} /></summary><div className="account-menu-popover">
        <button type="button" onClick={() => { navigate("settings"); if (isMobile) closeMobileSidebar(); }}><Settings size={14} />Settings</button>
        <a href="/faq" onClick={() => { if (isMobile) closeMobileSidebar(); }}><CircleHelp size={14} />Help / FAQ</a>
        <fieldset className="theme-preference">
          <legend>Theme</legend>
          <div className="theme-options">
            {THEME_OPTIONS.map((preference) => <label key={preference} htmlFor={`theme-${preference}`}>
              <input id={`theme-${preference}`} name="dashboard-theme" type="radio" value={preference} checked={themePreference === preference} onChange={() => changeThemePreference(preference)} />
              <span>{preference[0].toUpperCase() + preference.slice(1)}</span>
            </label>)}
          </div>
        </fieldset>
        <DesktopNotificationsControl />
        {showOrgSwitcher && <label>Switch organization<Select ariaLabel="Switch organization" value={activeOrgKey ?? ""} onValueChange={changeOrg} options={orgOptions} /></label>}
        {onOrgSettings ? (
          <label>Jump to project Operations<Select ariaLabel="Jump to project Operations" value={selectedProject ?? ""} onValueChange={changeProject} options={projectOptions} /></label>
        ) : (
          <label>Switch project<Select ariaLabel="Switch project" value={selectedProject ?? ""} onValueChange={changeProject} options={projectOptions} /></label>
        )}
        <button type="button" onClick={() => void signOut()}><LogOut size={14} />Sign out</button>
      </div></details>
    </aside>
    <div className="shell-main">
      <header className="mobile-shell-bar"><Button variant="ghost" size="icon" type="button" aria-label="Open navigation" onClick={(event) => { mobileMenuButton.current = event.currentTarget; setSidebarOpen(true); }}><Menu size={18} /></Button><a className="wordmark" href="/dashboard/"><i className="brand-notch" /><span>mem</span><b>racer</b></a><div className="mobile-connection" data-status={live} role="status"><span /><b>{liveConnectionLabel(live)}</b></div></header>
      {projectNotice && <div className="project-notice" role="status" aria-live="polite">{projectNotice}<button aria-label="Dismiss Project warning" onClick={() => setProjectNotice("")}>×</button></div>}
      <div className="page-content"><PageHeader view={urlState.view} projectName={textOrUntitled(selectedMembership?.projectName)} onAction={pageAction} />
      {urlState.view === "knowledge" && selectedProject ? <DashboardErrorBoundary resetKey={`knowledge:${selectedProject}:${urlState.concept ?? ""}`} heading="Knowledge stopped rendering"><KnowledgeView project={selectedProject} concept={urlState.concept} onConcept={(concept) => update({ concept })} onTask={(id) => openTask(id)} /></DashboardErrorBoundary> : urlState.view === "team" && selectedMembership ? <DashboardErrorBoundary resetKey={`team:${selectedMembership.projectId}`} heading="Team stopped rendering"><TeamView key={selectedMembership.projectId} membership={selectedMembership} /></DashboardErrorBoundary> : urlState.view === "settings" && selectedMembership ? <DashboardErrorBoundary resetKey={`settings:${selectedMembership.projectId}`} heading="Settings stopped rendering"><SettingsView key={selectedMembership.projectId} membership={selectedMembership} onMembershipChange={(project, warning) => void projects.refetch().then((result) => { if (project) { setProjectNotice(warning ?? ""); update({ project, ...clearProjectLocalState }); return; } if (selectedProject && result.data && !result.data.projects.some((item) => item.projectId === selectedProject)) { const recovered = recoverSelection(result.data.projects, selectedProject); update({ project: recovered?.projectId ?? null, ...clearProjectLocalState }); } })} /></DashboardErrorBoundary> : urlState.view === "org-settings" && orgSettingsMembership && orgSettingsOrgId ? <DashboardErrorBoundary resetKey={`org-settings:${orgSettingsOrgId}`} heading="Org settings stopped rendering"><OrgSettingsView key={orgSettingsOrgId} membership={orgSettingsMembership} orgProjectCount={memberships.filter((m) => m.orgId && m.orgId === orgSettingsOrgId).length} /></DashboardErrorBoundary> : urlState.view === "org-settings" ? <section className="settings-view org-settings-unresolved" data-testid="org-settings-unresolved" role="alert" aria-labelledby="org-settings-unresolved-title"><h1 id="org-settings-unresolved-title">Organization unavailable</h1><EmptyState label="This organization could not be resolved or you do not have access. Pick an organization you belong to, or return to Operations." /></section> : live === "unavailable" ? <section className="error-panel" role="alert"><h1>Project unavailable</h1><p>This scoped project could not be found or is no longer available to this identity.</p></section> : <>
        <div className="operations-surfaces">
          {selectedProject ? (
            <GetStartedPanel
              projectId={selectedProject}
              readiness={seatReadiness.isPending || seatReadiness.isError ? null : seatReadiness.data}
              onOpenSettings={() => update({ view: "settings" })}
              onSetupBilling={() => navigate("org-settings")}
            />
          ) : null}
          <NeedsYouPanel id="desktop-needs-you-title" project={selectedProject} openTask={openTask} />
          <StatusBand tasks={tasks} agents={agents} overview={overview} error={home.queue.isError} pending={home.queue.isPending} retry={() => void home.queue.refetch()} />
          <QueueSurface tasks={tasks} error={home.queue.isError} pending={home.queue.isPending} retry={() => void home.queue.refetch()} state={urlState} update={update} openTask={openTask} />
          <OnHoldPanel tasks={tasks} openTask={openTask} />
          <ActiveRoster
            agents={agents}
            clockActive={!isMobile}
            collapsible
            error={home.agents.isError}
            openTask={openTask}
            pending={home.agents.isPending}
            retry={() => void home.agents.refetch()}
            titleId="desktop-active-agents-title"
          />
          <div className="live-work-grid">
            {selectedProject && urlState.task == null && (
              <FeedSurface
                project={selectedProject}
                threads={threads.data?.threads ?? []}
                error={threads.isError}
                pending={threads.isPending}
                retry={() => void threads.refetch()}
                selected={urlState.thread}
                onSelect={openThread}
                openTask={openTask}
              />
            )}
          </div>
          {overview ? <Raceway overview={overview} /> : home.queue.isPending ? <PendingPanel className="raceway" label="Recent transitions" /> : <UnavailablePanel className="raceway" label="Recent transitions" retry={() => void home.queue.refetch()} />}
        </div>
        <YouSurface project={selectedProject} agents={agents} agentsError={home.agents.isError} agentsPending={home.agents.isPending} clockActive={isMobile && mobileTab === "you"} retryAgents={() => void home.agents.refetch()} openTask={openTask} />
      </>}</div>
      <nav className="mobile-tabs" aria-label="Mobile views">{MOBILE_TABS.map((tab) => <button key={tab} aria-current={mobileTab === tab ? "page" : undefined} onClick={() => setTab(tab)}>{tab === "feed" ? "Activity" : tab === "team" ? "Team analytics" : tab[0].toUpperCase() + tab.slice(1)}</button>)}</nav>
      <TaskDetailSheet project={selectedProject} taskId={urlState.task} threadId={urlState.thread} onOpenTask={(id) => openTask(id)} onThread={(thread) => update({ thread })} onClose={closeTask} returnFocus={returnFocus} />
      <CommandPalette open={paletteOpen} projects={projects.data.projects} tasks={tasks} threads={threads.data?.threads ?? []} close={closePalette} navigate={navigate} selectProject={changeProject} openTask={openTask} openThread={openThread} />
      <footer><span>Read-only operations surface</span><span>Counts: current database snapshot · trends and transitions: persisted over the last 7 days</span></footer>
    </div>
  </main>;
}
