import * as Dialog from "@radix-ui/react-dialog";
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, ExternalLink, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { TimelineIsland } from "../../island/index.js";
import { dashboardApi, DashboardApiError } from "../data/api.js";
import type { CitationDto, EvidenceDto, TaskDetailDto, TaskImageDto } from "../data/dto.js";
import { queryKeys } from "../data/query-keys.js";
import { parseResultSummary, taskOutcome } from "../lib/home-model.js";
import { preferTaskConversationThread } from "../lib/task-conversation.js";
import { resolveTaskTrigger } from "../lib/task-trigger.js";
import { DashboardErrorBoundary } from "./error-boundary.js";
import { TaskPrStatus } from "./task-pr-status.js";
import { Avatar, actorDisplayName, actorRoleDisplayName, type ActorRole } from "./ui/avatar.js";
import { Badge, StatusBadge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { Card, SidebarSection } from "./ui/card.js";
import { Select } from "./ui/select.js";
import { EmptyState, ErrorState, LoadingState, resolveQueryView } from "./ui/state.js";
import { Tabs } from "./ui/tabs.js";
import { Tooltip } from "./ui/tooltip.js";

function CitationChip({ citation, onTask }: { citation: CitationDto; onTask: (id: number) => void }) {
  if (citation.type === "pr") return <a className="citation-chip" href={citation.url} target="_blank" rel="noreferrer"><ExternalLink size={10} />{citation.label}</a>;
  if (citation.type === "task" && citation.url.endsWith("#plan")) return <a className="citation-chip" href={citation.url}>{citation.label}</a>;
  return <button className="citation-chip" type="button" onClick={() => citation.type === "task" ? onTask(citation.id) : window.dispatchEvent(new CustomEvent("memracer:citation", { detail: citation }))}>{citation.label}</button>;
}

function CitationList({ citations, onTask }: { citations: CitationDto[]; onTask: (id: number) => void }) {
  return citations.length ? <div className="citation-list">{citations.map((citation) => <CitationChip citation={citation} onTask={onTask} key={`${citation.type}:${citation.id}:${citation.url}`} />)}</div> : null;
}

function TaskActor({ name, role }: { name: string | null; role: ActorRole }) {
  const readableName = actorDisplayName(name, role);
  return <Tooltip content={actorRoleDisplayName(role)}><span className="task-actor" data-actor-role={role}><Avatar name={readableName} role={role} /><b>{readableName}</b></span></Tooltip>;
}

function CopyButton({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!navigator.clipboard) return;
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };
  return <Button variant="ghost" size="sm" type="button" aria-label={`Copy ${label}`} onClick={() => void copy()}>{copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}{copied ? "Copied" : "Copy"}</Button>;
}

function CodeBlock({ label, value }: { label: string; value: string }) {
  return <Card className="task-code-block"><header><span>{label}</span><CopyButton label={label} value={value} /></header><code>{value}</code></Card>;
}

function TaskImageCard({ image, index, project }: { image: TaskImageDto; index: number; project: string }) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retrySuffix = attempt > 0 ? `?retry=${attempt}` : "";
  const alt = image.caption?.trim() || `Attached image ${index + 1}`;
  return <figure className="task-image-card">
    <div className="task-image-frame">
      {failed
        ? <div className="task-image-failure" role="alert"><b>Image unavailable</b><Button size="sm" type="button" onClick={() => { setFailed(false); setAttempt((value) => value + 1); }}>Retry image</Button></div>
        : <img src={`${dashboardApi.taskImageUrl(project, image.id)}${retrySuffix}`} alt={alt} loading="lazy" decoding="async" onError={() => setFailed(true)} />}
    </div>
    <figcaption><span>image {index + 1}</span>{image.caption?.trim() || "No caption"}</figcaption>
  </figure>;
}

function TaskImageGallery({ project, taskId }: { project: string; taskId: number }) {
  const query = useQuery({
    queryKey: queryKeys.taskImages(project, taskId),
    queryFn: () => dashboardApi.taskImages(project, taskId),
    retry: false,
  });
  if (query.isPending) return <LoadingState className="task-images task-images-loading" label="Loading attached images…" />;
  if (query.isError) return <ErrorState className="task-images task-images-error" heading="Images unavailable" label="The rest of the task is still available." retry={() => void query.refetch()} />;
  if (!query.data.images.length) return null;
  return <section className="task-images" aria-label="Attached images">
    <header><h3>Images</h3><Badge>{query.data.images.length}</Badge></header>
    <div className="task-image-grid">{query.data.images.map((image, index) => <TaskImageCard image={image} index={index} project={project} key={`${project}:${taskId}:${image.id}`} />)}</div>
  </section>;
}

function EvidenceCard({ evidence }: { evidence: EvidenceDto }) {
  const reference = [evidence.path, evidence.lines].filter(Boolean).join(":") || `evidence #${evidence.id}`;
  return <Card className="evidence-row" data-evidence-id={evidence.id}>
    <header><Badge>{evidence.kind}</Badge><span className="mono">{reference}</span></header>
    {evidence.note && <p>{evidence.note}</p>}
    {evidence.snippet && <CodeBlock label={reference} value={evidence.snippet} />}
  </Card>;
}

function relativeExpiry(timestamp: number | null): string {
  if (!timestamp) return "No active lease";
  const minutes = Math.round((timestamp - Date.now()) / 60_000);
  if (Math.abs(minutes) < 60) return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(minutes, "minute");
  return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(Math.round(minutes / 60), "hour");
}

function DetailBody({ task, project, selectedThread, onThread, onTask }: { task: TaskDetailDto; project: string; selectedThread: number | null; onThread: (id: number | null) => void; onTask: (id: number) => void }) {
  const firstThread = preferTaskConversationThread(task.threads, task.root_thread_id);
  const requestedThread = selectedThread != null && (selectedThread === task.root_thread_id || task.threads.some((thread) => thread.id === selectedThread)) ? selectedThread : firstThread;
  const [session, setSession] = useState<number | null>(requestedThread);
  const [selectedTab, setSelectedTab] = useState(0);
  useEffect(() => setSession(requestedThread), [requestedThread, task.id]);
  useLayoutEffect(() => {
    if (window.location.hash !== "#plan") return;
    setSelectedTab(1);
    window.requestAnimationFrame(() => document.getElementById("plan")?.scrollIntoView({ block: "center" }));
  }, [task.id]);
  useEffect(() => {
    const onCitation = (event: Event) => {
      const citation = (event as CustomEvent<CitationDto>).detail;
      if (citation.type === "task") { onTask(citation.id); return; }
      if (citation.type === "thread") { setSelectedTab(0); setSession(citation.id); onThread(citation.id); return; }
      const tab = citation.type === "evidence" ? 2 : citation.type === "decision" ? 5 : selectedTab;
      setSelectedTab(tab);
      window.requestAnimationFrame(() => {
        const selector = citation.type === "evidence" ? `[data-evidence-id="${citation.id}"]` : citation.type === "decision" ? `[data-decision-id="${citation.id}"]` : null;
        const target = selector ? document.querySelector<HTMLElement>(selector) : null;
        if (!target) return;
        target.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
        target.dataset.citationTarget = "true";
        window.setTimeout(() => { delete target.dataset.citationTarget; }, 1_600);
      });
    };
    window.addEventListener("memracer:citation", onCitation);
    return () => window.removeEventListener("memracer:citation", onCitation);
  }, [onTask, onThread, selectedTab]);

  const conversation = <section className="task-timeline" aria-label="Task session context">
    <header><div><span className="section-kicker">Conversation</span><h3>Activity</h3></div>{task.threads.length > 1 && <Select ariaLabel="Task session" value={`${session ?? ""}`} onValueChange={(value) => { const id = Number(value); setSession(id); onThread(id); }} options={task.threads.map((thread) => ({ value: `${thread.id}`, label: `${thread.kind} · session #${thread.id}` }))} />}</header>
    {session == null ? <EmptyState label="Activity will appear after the first task session starts." /> : <DashboardErrorBoundary resetKey={`${project}:${task.id}:${task.threads.find((thread) => thread.id === session)?.root_id ?? session}:${session}`} heading="Activity stopped rendering"><TimelineIsland selection={{ projectId: project, sessionId: task.threads.find((thread) => thread.id === session)?.root_id ?? session, threadId: session, taskId: task.id }} onSelectionChange={(next) => {
      const threadId = next.threadId ?? next.sessionId;
      if (next.taskId != null && next.taskId !== task.id) { onTask(next.taskId); return; }
      setSession(threadId);
      onThread(threadId);
    }} /></DashboardErrorBoundary>}
  </section>;

  const specification = <section className="task-tab-stack" aria-label="Task specification">
    <Card className="task-content-card"><header><h3>Groomed specification</h3><Badge>source</Badge></header><p className="task-body-copy">{task.body || "No groomed specification is attached to this task."}</p></Card>
    {task.grooming_rationale ? <Card className="task-content-card"><header><h3>Grooming rationale</h3></header><p>{task.grooming_rationale}</p><CitationList citations={task.grooming_citations} onTask={onTask} /></Card> : <EmptyState label="No grooming rationale was recorded." />}
    {task.plan ? <section id="plan"><CodeBlock label="Approved plan" value={task.plan} /></section> : <EmptyState label="An approved plan has not been recorded." />}
  </section>;

  const evidence = <section className="task-tab-stack" id="task-evidence" aria-label="Task evidence">
    <TaskImageGallery project={project} taskId={task.id} />
    {task.evidence.length ? task.evidence.map((item) => <EvidenceCard evidence={item} key={item.id} />) : <EmptyState label="No code, logs, links, or research are attached." />}
  </section>;

  const completion = parseResultSummary(task.result_summary);
  return <div className="task-sheet-body">
    <header className="task-human-summary">
      <div className="detail-identity mono">Task #{task.id}</div>
      <Tooltip content={task.title}><h2 tabIndex={0}>{task.title}</h2></Tooltip>
      <p>{taskOutcome(task.body, completion.summary ?? "No outcome summary was recorded.")}</p>
      {completion.verification ? <Card className="task-content-card task-verification" aria-label="How I verified"><header><h3>How I verified</h3></header><p>{completion.verification}</p></Card> : null}
      <div className="task-summary-status"><StatusBadge state={task.state} /><TaskActor name={task.lease_agent ?? task.submitted_by} role={task.lease_agent ? "coder" : "human"} /></div>
      <TaskPrStatus resultPrUrl={task.result_pr_url} resultPrNumber={task.result_pr_number} prVerification={task.pr_verification} />
    </header>
    <div className="task-sheet-layout">
      <main className="task-sheet-main">
        <Tabs selected={selectedTab} onSelect={setSelectedTab} items={[
          { id: "conversation", label: "Conversation", count: task.threads.length, content: conversation },
          { id: "specification", label: "Specification", count: Number(Boolean(task.body)) + Number(Boolean(task.grooming_rationale)) + Number(Boolean(task.plan)), content: specification },
          { id: "evidence", label: "Evidence", count: task.evidence.length, content: evidence },
          { id: "attempts", label: "Attempts", count: task.attempts.length, content: <section className="task-tab-stack">{task.attempts.length ? task.attempts.map((attempt, index) => <Card className="attempt-row" key={`${attempt.agent}:${index}`}><header><TaskActor name={attempt.agent} role="coder" /><Badge>{attempt.outcome.replaceAll("_", " ")}</Badge></header><p>{attempt.notes ?? "No attempt note was recorded."}</p></Card>) : <EmptyState label="No implementation attempts have been recorded." />}</section> },
          { id: "questions", label: "Questions", count: task.questions.length, content: <section className="task-tab-stack">{task.questions.length ? task.questions.map((question, index) => <Card className="question-row" key={index}><header><TaskActor name={question.asked_by} role={/^(?:mediator|steward)$/i.test(question.asked_by.trim()) ? "mediator" : task.lease_agent === question.asked_by || task.attempts.some((attempt) => attempt.agent === question.asked_by) ? "coder" : "human"} /><Badge variant={question.answer ? "success" : "warning"}>{question.status}</Badge></header><p>{question.question}</p><span>{question.answer ?? "Waiting for an answer."}</span></Card>) : <EmptyState label="No clarification questions are attached." />}</section> },
          { id: "decisions", label: "Decisions", count: task.decisions.length, content: <section className="task-tab-stack">{task.decisions.length ? task.decisions.map((decision) => <Card className="decision-row" data-decision-id={decision.id} key={decision.id}><header><TaskActor name="steward" role="mediator" /><Badge variant="live">{decision.kind}</Badge></header><h3>{decision.summary}</h3><p>{decision.rationale}</p><CitationList citations={decision.citations} onTask={onTask} /></Card>) : <EmptyState label="No Frigg decisions have been recorded." />}</section> },
        ]} />
      </main>
      <SidebarSection className="task-sheet-sidebar" aria-label="Task metadata">
        <section><h3>Status</h3><StatusBadge state={task.state} /></section>
        {task.result_pr_url ? <section><h3>Pull request</h3><TaskPrStatus resultPrUrl={task.result_pr_url} resultPrNumber={task.result_pr_number} prVerification={task.pr_verification} /></section> : null}
        <section><h3>Priority</h3><Badge variant={task.priority <= 1 ? "danger" : task.priority === 2 ? "warning" : "neutral"}>P{task.priority}</Badge></section>
        <section>
          <h3>Submitted by</h3>
          <TaskActor name={task.submitted_by} role="human" />
          {task.parent_id != null ? (
            <p className="muted task-lineage">
              follow-up to #{task.parent_id}
              {task.parent_submitted_by ? ` · ${task.parent_submitted_by}` : ""}
              {task.parent_title ? ` — ${task.parent_title}` : ""}
            </p>
          ) : null}
        </section>
        <section><h3>Lease actor</h3>{task.lease_agent ? <TaskActor name={task.lease_agent} role="coder" /> : <span className="muted">Unassigned</span>}</section>
        <section><h3>Base SHA</h3>{task.base_sha ? <div className="task-metadata-value"><code>{task.base_sha}</code><CopyButton label="base SHA" value={task.base_sha} /></div> : <span className="muted">Not pinned</span>}</section>
        <section><h3>Lease expires</h3><time className="mono" dateTime={task.lease_expires_at ? new Date(task.lease_expires_at).toISOString() : undefined}>{relativeExpiry(task.lease_expires_at)}</time></section>
        <section className="task-count-links"><h3>Task records</h3>{[["Attempts", task.attempts.length, 3], ["Questions", task.questions.length, 4], ["Decisions", task.decisions.length, 5]].map(([label, count, tab]) => <Button variant="ghost" type="button" onClick={() => setSelectedTab(Number(tab))} key={String(label)}><span>{label}</span><Badge>{count}</Badge></Button>)}</section>
      </SidebarSection>
    </div>
  </div>;
}

function TaskSheetSkeleton({ taskId }: { taskId: number | null }) {
  return <div className="task-sheet-skeleton"><LoadingState label={`Loading task #${taskId}…`} /><div className="task-skeleton-header" aria-hidden="true"><i /><i /><i /></div><div className="task-skeleton-layout" aria-hidden="true"><i /><i /></div></div>;
}

export function TaskDetailSheet({ project, taskId, threadId, onOpenTask, onThread, onClose, returnFocus }: {
  project: string | null;
  taskId: number | null;
  threadId: number | null;
  onOpenTask: (id: number) => void;
  onThread: (id: number | null) => void;
  onClose: () => void;
  returnFocus: React.RefObject<HTMLElement | null>;
}) {
  const intent = useRef(0);
  const lastTaskId = useRef<number | null>(taskId);
  if (taskId != null) lastTaskId.current = taskId;
  const query = useQuery({
    queryKey: project && taskId != null ? queryKeys.task(project, taskId) : ["task", "closed"],
    queryFn: async () => {
      const generation = ++intent.current;
      const value = await dashboardApi.task(project!, taskId!);
      if (generation !== intent.current) throw new Error("stale task request");
      return value;
    },
    enabled: Boolean(project && taskId != null),
    retry: false,
  });
  useEffect(() => () => { intent.current += 1; }, [project, taskId]);
  const view = resolveQueryView({ error: query.isError, pending: query.isPending, empty: !query.data });
  return <Dialog.Root open={taskId != null} onOpenChange={(open) => { if (!open) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="task-sheet-overlay" />
      <Dialog.Content className="task-sheet" aria-describedby={undefined} onCloseAutoFocus={(event) => { event.preventDefault(); resolveTaskTrigger(lastTaskId.current, returnFocus.current)?.focus(); }}>
        <Dialog.Title className="sr-only">Task {taskId ?? "detail"}</Dialog.Title>
        <Dialog.Close className="task-sheet-close" aria-label="Close task detail"><X size={16} /></Dialog.Close>
        {view === "loading" ? <TaskSheetSkeleton taskId={taskId} /> : view === "error" ? <ErrorState className="sheet-state" heading={query.error instanceof DashboardApiError && query.error.missing ? "Task not found" : "Task unavailable"} label={query.error instanceof DashboardApiError && query.error.missing ? `Task #${taskId} does not exist in this Project.` : "The task request failed. Close this sheet or retry."} retry={() => void query.refetch()} /> : view === "empty" ? <EmptyState className="sheet-state" label="No task details are available." /> : <DetailBody task={query.data!} project={project!} selectedThread={threadId} onThread={onThread} onTask={onOpenTask} />}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
