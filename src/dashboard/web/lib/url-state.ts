export const DASHBOARD_VIEWS = ["dashboard", "team", "knowledge", "settings", "org-settings"] as const;
export type DashboardView = (typeof DASHBOARD_VIEWS)[number];

export const TASK_STATES = [
  "INCUBATING", "QUEUED", "CLAIMED", "PLANNED", "EXECUTING", "AWAITING_MERGE",
  "DONE", "BLOCKED", "PARKED", "HELD",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const QUEUE_SORTS = ["priority", "updated", "created", "title", "state"] as const;
export type QueueSort = (typeof QUEUE_SORTS)[number];
export type SortDirection = "asc" | "desc";

export interface DashboardUrlState {
  project: string | null;
  /** Org id for org-settings chrome; optional on other views. */
  org: string | null;
  view: DashboardView;
  task: number | null;
  thread: number | null;
  concept: string | null;
  state: TaskState | null;
  agent: string | null;
  /** Optional queue ordering. Null preserves URLs created before sorting shipped. */
  sort: QueueSort | null;
  direction: SortDirection | null;
}

const viewSet = new Set<string>(DASHBOARD_VIEWS);
const taskStateSet = new Set<string>(TASK_STATES);
const queueSortSet = new Set<string>(QUEUE_SORTS);

function positiveInt(value: unknown): number | null {
  if (value === null || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

export function parseUrlState(search: string): DashboardUrlState {
  const params = new URLSearchParams(search || "");
  const project = params.get("project");
  const org = params.get("org");
  const view = params.get("view");
  const concept = params.get("concept");
  const state = params.get("state");
  return {
    project: project || null,
    org: org || null,
    view: viewSet.has(view ?? "") ? view as DashboardView : "dashboard",
    task: positiveInt(params.get("task")),
    thread: positiveInt(params.get("thread")),
    concept: concept || null,
    state: taskStateSet.has(state ?? "") ? state as TaskState : null,
    agent: params.get("agent") || null,
    sort: queueSortSet.has(params.get("sort") ?? "") ? params.get("sort") as QueueSort : null,
    direction: params.get("direction") === "asc" || params.get("direction") === "desc"
      ? params.get("direction") as SortDirection
      : null,
  };
}

export function serializeUrlState(selection: Partial<DashboardUrlState>): string {
  const params = new URLSearchParams();
  if (selection.project) params.set("project", selection.project);
  if (selection.org) params.set("org", selection.org);
  params.set("view", viewSet.has(selection.view ?? "") ? selection.view! : "dashboard");
  if (positiveInt(selection.task) !== null) params.set("task", String(selection.task));
  if (positiveInt(selection.thread) !== null) params.set("thread", String(selection.thread));
  if (selection.concept) params.set("concept", selection.concept);
  if (taskStateSet.has(selection.state ?? "")) params.set("state", selection.state!);
  if (selection.agent) params.set("agent", selection.agent);
  if (queueSortSet.has(selection.sort ?? "")) params.set("sort", selection.sort!);
  if (selection.direction === "asc" || selection.direction === "desc") params.set("direction", selection.direction);
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function dashboardHref(selection: Partial<DashboardUrlState>, pathname = "/dashboard"): string {
  return `${pathname}${serializeUrlState(selection)}`;
}

export function writeUrlState(
  mode: "push" | "replace",
  selection: Partial<DashboardUrlState>,
  currentLocation: Pick<Location, "pathname" | "search" | "hash"> = window.location,
  currentHistory: Pick<History, "pushState" | "replaceState"> = window.history,
): boolean {
  const next = `${dashboardHref(selection, currentLocation.pathname)}${currentLocation.hash || ""}`;
  const current = `${currentLocation.pathname}${currentLocation.search}${currentLocation.hash || ""}`;
  if (next === current) return false;
  currentHistory[mode === "replace" ? "replaceState" : "pushState"](null, "", next);
  return true;
}
