import * as Dialog from "@radix-ui/react-dialog";
import { Archive, ChevronLeft, ChevronRight, Search, X } from "lucide-react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { dashboardApi } from "../data/api.js";
import { queryKeys } from "../data/query-keys.js";
import type { CompletedTaskDto } from "../data/dto.js";
import { Button, buttonVariants } from "./ui/button.js";
import { EmptyState, ErrorState, LoadingState } from "./ui/state.js";
import { StatusBadge } from "./ui/badge.js";
import { TaskPrStatus } from "./task-pr-status.js";

const PAGE_SIZE = 20;

function completedDate(task: CompletedTaskDto): string {
  return new Date(task.updated_at).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

function completedTitle(task: CompletedTaskDto): string {
  return task.title.trim() || "untitled";
}

function activateOnEnterSpace(event: React.KeyboardEvent, activate: () => void) {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  activate();
}

function CompletedCard({ task, select }: { task: CompletedTaskDto; select: (task: CompletedTaskDto) => void }) {
  // div+role=button (not <button>) so the nested PR <a> stays valid HTML.
  return <div
    className="completed-row completed-card"
    role="button"
    tabIndex={0}
    onClick={() => select(task)}
    onKeyDown={(event) => activateOnEnterSpace(event, () => select(task))}
  >
    <span className="completed-row-status"><StatusBadge state="DONE" /><time dateTime={new Date(task.updated_at).toISOString()}>{completedDate(task)}</time></span>
    <span className="completed-row-task"><b>{completedTitle(task)}</b><span>#{task.id}</span></span>
    <TaskPrStatus resultPrUrl={task.result_pr_url} resultPrNumber={task.result_pr_number} prVerification={task.pr_verification} />
    <span className="completed-row-owner">{task.submitted_by}</span>
    <ChevronRight size={15} aria-hidden="true" />
  </div>;
}

function CompletedTableRow({ task, select }: { task: CompletedTaskDto; select: (task: CompletedTaskDto) => void }) {
  return <tr className="completed-row" onClick={() => select(task)}>
    <td><span className="completed-row-status"><StatusBadge state="DONE" /><time dateTime={new Date(task.updated_at).toISOString()}>{completedDate(task)}</time></span></td>
    <td>
      <span className="completed-row-task"><b>{completedTitle(task)}</b><span>#{task.id}</span></span>
      <TaskPrStatus resultPrUrl={task.result_pr_url} resultPrNumber={task.result_pr_number} prVerification={task.pr_verification} />
    </td>
    <td><span className="completed-row-owner">{task.submitted_by}</span></td>
    <td><button type="button" aria-label={`Open completed task ${task.id}: ${completedTitle(task)}`} onClick={(event) => { event.stopPropagation(); select(task); }}><ChevronRight size={15} aria-hidden="true" /></button></td>
  </tr>;
}

export function CompletedArchive({ project, onSelect }: {
  project: string;
  onSelect: (id: number, returnFocus: HTMLElement) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const selecting = useRef(false);

  useEffect(() => {
    setQuery("");
    setDebouncedQuery("");
    setOffset(0);
  }, [project]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQuery(query.trim());
      setOffset(0);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  const params = { q: debouncedQuery, limit: PAGE_SIZE, offset };
  const completed = useQuery({
    queryKey: queryKeys.completedTasks(project, params),
    queryFn: () => dashboardApi.completedTasks(project, params),
    enabled: open,
    placeholderData: keepPreviousData,
    retry: false,
  });
  const tasks = completed.data?.tasks ?? [];
  const stale = completed.isFetching && Boolean(completed.data);
  const select = (task: CompletedTaskDto) => {
    if (!trigger.current) return;
    selecting.current = true;
    setSelectedTaskId(task.id);
    const returnFocus = trigger.current;
    setOpen(false);
    window.setTimeout(() => onSelect(task.id, returnFocus), 0);
  };

  return <Dialog.Root open={open} onOpenChange={setOpen}>
    <Dialog.Trigger asChild><button ref={trigger} className={`${buttonVariants({ variant: "ghost", size: "sm" })} completed-trigger`} type="button" data-task-trigger={selectedTaskId ?? undefined}><Archive size={13} />Completed</button></Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="task-sheet-overlay completed-overlay" />
      <Dialog.Content className="completed-dialog" aria-describedby="completed-description" onCloseAutoFocus={(event) => {
        if (!selecting.current) return;
        event.preventDefault();
        selecting.current = false;
      }}>
        <header className="completed-header">
          <div><Dialog.Title>Completed tasks</Dialog.Title><Dialog.Description id="completed-description">Search work that has already shipped.</Dialog.Description></div>
          <Dialog.Close className="task-sheet-close" aria-label="Close completed tasks"><X size={16} /></Dialog.Close>
        </header>
        <label className="completed-search"><Search size={15} aria-hidden="true" /><span className="sr-only">Search completed tasks</span><input autoFocus aria-label="Search completed tasks" type="search" value={query} placeholder="Search title, task ID, or author…" onChange={(event) => setQuery(event.target.value)} /></label>
        <div className="completed-results" aria-live="polite" aria-busy={completed.isFetching}>
          {stale && <p className="completed-stale" role="status">Updating completed tasks…</p>}
          {completed.isError && completed.data && <p className="completed-stale" role="alert"><span>Showing the last update; completed tasks could not refresh.</span><Button variant="ghost" size="sm" type="button" onClick={() => void completed.refetch()}>Retry</Button></p>}
          {completed.isPending ? <LoadingState label="Loading completed tasks…" />
            : completed.isError && !completed.data ? <ErrorState label="Completed tasks temporarily unavailable." retry={() => void completed.refetch()} />
              : tasks.length === 0 ? <EmptyState label={debouncedQuery ? "No completed tasks match this search." : "No completed tasks yet."} />
                : <><table className="completed-table" aria-label="Completed tasks"><thead><tr><th>Completed</th><th>Task</th><th>Author</th><th><span className="sr-only">Open</span></th></tr></thead><tbody>{tasks.map((task) => <CompletedTableRow key={task.id} task={task} select={select} />)}</tbody></table><div className="completed-cards">{tasks.map((task) => <CompletedCard key={task.id} task={task} select={select} />)}</div></>}
        </div>
        <footer className="completed-pagination">
          <span>{tasks.length ? `${completed.data!.offset + 1}–${completed.data!.offset + tasks.length}` : "0 results"}</span>
          <div><Button variant="ghost" size="sm" type="button" disabled={offset === 0 || completed.isFetching} onClick={() => setOffset(Math.max(0, offset - (completed.data?.limit ?? PAGE_SIZE)))}><ChevronLeft size={14} />Previous</Button><Button variant="ghost" size="sm" type="button" disabled={completed.data?.next_offset == null || completed.isFetching} onClick={() => setOffset(completed.data!.next_offset!)}>Next<ChevronRight size={14} /></Button></div>
        </footer>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
