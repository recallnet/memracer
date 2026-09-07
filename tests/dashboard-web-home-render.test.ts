// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, readThemePreference } from "../src/dashboard/web/src/app.js";

const { timelineRender } = vi.hoisted(() => ({ timelineRender: vi.fn() }));
vi.mock("../src/dashboard/island/index.js", () => ({ TimelineIsland: (props: unknown) => { timelineRender(props); return null; } }));

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(_url: string) { queueMicrotask(() => this.onopen?.()); }
  addEventListener() { /* no frames needed for the render contract */ }
  close() { /* cleanup contract */ }
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

const queue = {
  tasks: [
    {
      id: 41, title: "Repair claim handoff", body: "", priority: 1, state: "EXECUTING", base_sha: null,
      repo: null, submitted_by: "Ada", lease_agent: "codex-a", lease_expires_at: Date.now() + 120_000,
      result_summary: null, result_pr_url: null, result_pr_number: null, pr_verification: null, grooming_rationale: null, parent_id: null,
      incubate_until: null, hold_cause: null, created_at: 1, updated_at: 2, evidence_count: 0, latest_attempt_note: null,
    },
    {
      id: 42, title: "Document replay", body: "", priority: 2, state: "QUEUED", base_sha: null,
      repo: null, submitted_by: "Ada", lease_agent: null, lease_expires_at: null,
      result_summary: null, result_pr_url: null, result_pr_number: null, pr_verification: null, grooming_rationale: null, parent_id: null,
      incubate_until: null, hold_cause: null, created_at: 2, updated_at: 3, evidence_count: 0, latest_attempt_note: null,
    },
    {
      id: 43, title: "Archived replay", body: "", priority: 2, state: "DONE", base_sha: null,
      repo: null, submitted_by: "Ada", lease_agent: null, lease_expires_at: null,
      result_summary: null, result_pr_url: null, result_pr_number: null, pr_verification: null, grooming_rationale: null, parent_id: null,
      incubate_until: null, hold_cause: null, created_at: 3, updated_at: 4, evidence_count: 0, latest_attempt_note: null,
    },
  ],
  overview: {
    window: { label: "last 7 days", since: Date.now() - 7 * 24 * 60 * 60 * 1000 },
    trends: { open: 0, active: 1, ready: -1, done: 0 },
    transitions: [{
      id: 1, task_id: 41, title: "Repair claim handoff", from_state: "QUEUED", to_state: "EXECUTING", changed_at: Date.now(),
    }],
  },
};

let root: Root;
let host: HTMLDivElement;
let attentionFetch: () => Promise<Response>;
let queueFetch: () => Promise<Response>;
let threadsFetch: () => Promise<Response>;
let agentsFetch: () => Promise<Response>;
let completedFetch: () => Promise<Response>;

const leaseAttentionItem = () => ({
  episode_id: `lease:41:${queue.tasks[0].lease_expires_at}`,
  kind: "lease",
  project: "p1",
  task_id: 41,
  title: "Repair claim handoff",
  reason: "Lease expires soon.",
  recovery: "Coder should heartbeat.",
  badge: "LEASE",
  state: "CLAIMED",
  actor_name: "codex-a",
  actor_role: "coder",
  expires_at: queue.tasks[0].lease_expires_at,
  pushable: false,
  task_uri: "task://41",
  dashboard_url: null,
});

beforeEach(() => {
  timelineRender.mockClear();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, EventSource: FakeEventSource });
  vi.stubGlobal("localStorage", memoryStorage());
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  window.history.replaceState(null, "", "/dashboard/?project=p1&view=dashboard&sort=title&direction=asc");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  attentionFetch = async () => new Response(JSON.stringify({ items: [leaseAttentionItem()] }));
  queueFetch = async () => new Response(JSON.stringify(queue));
  agentsFetch = async () => new Response(JSON.stringify({ agents: [{ agent: "codex-a", task_id: 41, title: "Repair claim handoff", state: "EXECUTING", lease_expires_at: Date.now() + 120_000 }], queued: 1 }));
  threadsFetch = async () => new Response(JSON.stringify({ threads: [
    { id: 2, kind: "review", task_id: 41, root_id: 1, created_at: 2, task_title: "Repair claim handoff", task_state: "EXECUTING", summary: null, first_message: "plan", last_message: JSON.stringify({ verdict: "approved" }), first_human_message: null, last_author: "steward", last_role: "mediator", last_activity: 3 },
    { id: 1, kind: "submission", task_id: null, root_id: null, created_at: 1, task_title: null, task_state: null, summary: null, first_message: "Repair the handoff", last_message: "Repair the handoff", first_human_message: "Repair the handoff", last_author: "Ada", last_role: "human", last_activity: 1 },
  ] }));
  completedFetch = async () => new Response(JSON.stringify({
    tasks: [queue.tasks[2]], limit: 20, offset: 0, next_offset: null,
  }));
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const path = String(input);
    if (path.endsWith("/api/projects")) return new Response(JSON.stringify({ projects: [{ projectId: "p1", projectName: "Project One", repo: null, role: "admin", orgId: null, orgName: null }] }));
    if (path.endsWith("/api/session")) return new Response(JSON.stringify({ userId: "u1", name: "Ada", email: "ada@example.com" }));
    if (path.endsWith("/api/push/status")) return new Response(JSON.stringify({ configured: false, vapid_public_key: null, subscribed: false, subscription_count: 0, last_error_at: null }));
    if (path.endsWith("/api/p/p1/queue")) return queueFetch();
    if (path.endsWith("/api/p/p1/agents")) return agentsFetch();
    if (path.endsWith("/api/p/p1/attention")) return attentionFetch();
    if (path.endsWith("/api/p/p1/threads")) return threadsFetch();
    if (path.includes("/api/p/p1/tasks/done")) return completedFetch();
    if (path.endsWith("/api/p/p1/health")) return new Response(JSON.stringify({ inFlight: 0, sweepErrors: {}, drainErrors: {} }));
    // Mature fixture: seats connected + billing active → Get started hidden.
    if (path.endsWith("/api/p/p1/seat-readiness")) {
      return new Response(JSON.stringify({
        factoryReady: true,
        humanSeats: 1,
        coderSeats: 1,
        hasTaskHistory: true,
        friggReady: true,
      }));
    }
    return new Response("missing", { status: 404 });
  }));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("React operational home", () => {
  it("defaults invalid or unreadable theme storage to System", () => {
    window.localStorage.setItem("memracer.react.theme", "sepia");
    expect(readThemePreference()).toBe("system");

    const read = vi.spyOn(window.localStorage, "getItem").mockImplementation(() => { throw new Error("storage unavailable"); });
    expect(readThemePreference()).toBe("system");
    read.mockRestore();
  });

  it("reflects, applies, and persists the account theme preference", async () => {
    window.localStorage.setItem("memracer.react.theme", "light");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client }, createElement(App)));
    });
    await vi.waitFor(() => expect(host.querySelector(".account-menu")).not.toBeNull());

    const fieldset = host.querySelector<HTMLFieldSetElement>(".theme-preference");
    const radios = [...host.querySelectorAll<HTMLInputElement>('input[name="dashboard-theme"]')];
    expect(fieldset?.querySelector("legend")?.textContent).toBe("Theme");
    expect(radios.map((radio) => radio.labels?.[0]?.textContent)).toEqual(["System", "Light", "Dark"]);
    expect(host.querySelector<HTMLInputElement>("#theme-light")?.checked).toBe(true);
    await vi.waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));

    const themeAtWrite: Array<string | undefined> = [];
    const write = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      themeAtWrite.push(document.documentElement.dataset.theme);
      throw new Error("storage unavailable");
    });
    await act(async () => host.querySelector<HTMLInputElement>("#theme-dark")?.click());
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(themeAtWrite).toEqual(["dark"]);
    expect(window.localStorage.getItem("memracer.react.theme")).toBe("light");
    write.mockRestore();

    await act(async () => host.querySelector<HTMLInputElement>("#theme-light")?.click());
    await act(async () => host.querySelector<HTMLInputElement>("#theme-dark")?.click());
    expect(window.localStorage.getItem("memracer.react.theme")).toBe("dark");

    await act(async () => host.querySelector<HTMLInputElement>("#theme-system")?.click());
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(window.localStorage.getItem("memracer.react.theme")).toBe("system");
  });

  it("stacks desktop-notifications copy above a full-width Enable action in the account popover", async () => {
    // Mirror the real popover width so a side-by-side flex row would still fail structural checks.
    const POPOVER_WIDTH_PX = 216;
    vi.mocked(fetch).mockImplementation(async (input: string | URL | Request) => {
      const path = String(input);
      if (path.endsWith("/api/projects")) return new Response(JSON.stringify({ projects: [{ projectId: "p1", projectName: "Project One", repo: null, role: "admin", orgId: null, orgName: null }] }));
      if (path.endsWith("/api/session")) return new Response(JSON.stringify({ userId: "u1", name: "Ada", email: "ada@example.com" }));
      if (path.endsWith("/api/push/status")) {
        return new Response(JSON.stringify({
          configured: true,
          vapid_public_key: "BPtestvapidpublickey0000000000000000000000000000000000000000000000000000000000000000000",
          subscribed: false,
          subscription_count: 0,
          last_error_at: null,
        }));
      }
      if (path.endsWith("/api/p/p1/queue")) return queueFetch();
      if (path.endsWith("/api/p/p1/agents")) return agentsFetch();
      if (path.endsWith("/api/p/p1/attention")) return attentionFetch();
      if (path.endsWith("/api/p/p1/threads")) return threadsFetch();
      if (path.includes("/api/p/p1/tasks/done")) return completedFetch();
      if (path.endsWith("/api/p/p1/health")) return new Response(JSON.stringify({ inFlight: 0, sweepErrors: {}, drainErrors: {} }));
      return new Response("missing", { status: 404 });
    });
    vi.stubGlobal("Notification", { permission: "default" });
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: {} });
    Object.defineProperty(window, "PushManager", { configurable: true, value: function PushManager() {} });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client }, createElement(App)));
    });
    await vi.waitFor(() => {
      const enable = [...host.querySelectorAll(".desktop-notifications button")].find((button) => button.textContent === "Enable");
      expect(enable).toBeDefined();
    });

    const popover = host.querySelector<HTMLElement>(".account-menu-popover")!;
    popover.style.width = `${POPOVER_WIDTH_PX}px`;
    const control = host.querySelector<HTMLElement>(".desktop-notifications")!;
    const copy = control.querySelector<HTMLElement>(".desktop-notifications-copy");
    const enable = [...control.querySelectorAll("button")].find((button) => button.textContent === "Enable");
    expect(copy).not.toBeNull();
    expect(copy!.querySelector("b")?.textContent).toBe("Desktop notifications");
    expect(copy!.querySelector("small")?.textContent).toMatch(/Off · Native desktop alerts/);
    expect(enable).toBeDefined();
    // Action must not share a horizontal flex row with the description (the regression).
    expect(enable!.closest(".desktop-notifications-row")).toBeNull();
    expect(enable!.parentElement).toBe(control);
    expect(enable!.className).toMatch(/desktop-notifications-action/);
    // Copy and action are stacked siblings under the control, matching THEME / SWITCH PROJECT width discipline.
    const children = [...control.children];
    expect(children[0]).toBe(copy);
    expect(children).toContain(enable);
    expect(children.indexOf(enable!)).toBeGreaterThan(children.indexOf(copy!));
  });

  it("renders truthful labels and stable identities across home surfaces", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client }, createElement(App)));
    });
    await vi.waitFor(() => expect(host.querySelector("#raceway-title")?.textContent).toBe("Recent transitions"));
    await vi.waitFor(() => expect(host.textContent).toContain("Lease expires soon."));

    const completed = host.querySelector<HTMLButtonElement>('.queue-heading button[aria-haspopup="dialog"]');
    expect(completed?.textContent).toContain("Completed");
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("/tasks/done"))).toBe(false);

    expect(host.textContent).toContain("net change · last 7 days");
    expect(host.textContent).toContain("1 fewer");
    expect(host.textContent).toContain("QUEUED→EXECUTING");
    expect(host.querySelector(".sidebar-tools .live-heartbeat")?.textContent).toContain("Connected");
    expect(host.querySelectorAll(".queue-table-wrap tbody tr")).toHaveLength(2);
    expect(host.querySelectorAll(".queue-cards .queue-card")).toHaveLength(2);
    expect(host.querySelectorAll(".queue-table-wrap tbody tr:not([role])")).toHaveLength(2);
    expect(host.querySelectorAll(".queue-cards article.queue-card:not([role])")).toHaveLength(2);
    const queueTriggers = [...host.querySelectorAll<HTMLButtonElement>('.queue-panel button.queue-task-trigger[data-task-trigger][aria-haspopup="dialog"]')];
    expect(queueTriggers).toHaveLength(4);
    expect(queueTriggers.map((trigger) => trigger.dataset.taskTrigger)).toEqual(["42", "41", "42", "41"]);
    expect(queueTriggers.every((trigger) => trigger.type === "button")).toBe(true);
    expect(queueTriggers.every((trigger) => trigger.textContent?.includes("Open"))).toBe(true);
    expect([...host.querySelectorAll(".queue-table-wrap tbody tr, .queue-cards article.queue-card")].every((container) =>
      container.querySelectorAll('button, a[href], input, select, textarea, [role="button"], [tabindex]:not([tabindex="-1"])').length === 1,
    )).toBe(true);
    expect(host.querySelectorAll('.queue-panel [data-identity-key^="task:"]')).toHaveLength(0);
    expect(host.querySelectorAll(".queue-panel .state-chip")).toHaveLength(4);
    expect(host.querySelectorAll(".queue-panel .queue-owner")).toHaveLength(4);
    expect(host.querySelectorAll(".queue-panel .queue-priority")).toHaveLength(4);
    expect(host.querySelectorAll(".queue-panel .queue-timing")).toHaveLength(4);
    expect(host.querySelectorAll(".queue-table-wrap .queue-task-summary")).toHaveLength(2);
    expect(host.querySelector("#queue-state-filter")).toBeNull();
    expect(host.querySelector("#queue-agent-filter")).toBeNull();
    expect(host.querySelector(".queue-panel .filter-rail")).toBeNull();
    expect(host.querySelector(".queue-heading #queue-sort")).not.toBeNull();
    expect(host.querySelector(".queue-heading .panel-note")?.textContent).toBe("2 actionable");
    expect(host.querySelector(".queue-visibility")).toBeNull();
    expect(host.querySelector('[data-thread-id="2"]')?.textContent).toContain("Approved · #41 · Repair claim handoff");
    expect(host.querySelector('[data-thread-id="2"] .feed-row-head')?.textContent).toContain("#41 — Repair claim handoff");
    expect(host.querySelector('[data-thread-id="2"]')?.textContent).toContain("2 sessions");
    // Row is a div shell; select control is the identity button, Open is a sibling.
    expect(host.querySelectorAll(".feed-surface nav .feed-row-select")).toHaveLength(1);
    expect(host.querySelectorAll(".feed-surface nav .feed-task-trigger")).toHaveLength(1);
    expect(host.querySelector(".feed-surface nav")?.textContent).not.toContain('{"verdict"');
    expect(host.querySelector(".feed-surface nav")?.textContent).not.toMatch(/thread \d+/i);
    expect(host.querySelector('[data-thread-id="2"] [data-actor-role="mediator"] b')?.textContent).toBe("Frigg");
    expect(host.querySelector('[data-thread-id="2"] .state-chip')?.getAttribute("data-state")).toBe("EXECUTING");
    expect(host.querySelector(".feed-timeline-heading .state-chip")?.getAttribute("data-state")).toBe("EXECUTING");
    expect(host.querySelector('[data-thread-id="1"]')).toBeNull();
    expect(host.querySelectorAll(".panel-heading .section-kicker")).toHaveLength(0);
    expect(host.querySelectorAll(".status-reading")).toHaveLength(4);
    expect([...host.querySelectorAll(".status-reading")].every((reading) =>
      reading.querySelector(":scope > .status-value") && reading.querySelector(":scope > .snapshot-trend")
    )).toBe(true);
    const operations = host.querySelector(".operations-surfaces")!;
    // Mock has a connected coder seat → no Get started flash.
    expect([...operations.children].map((child) => child.classList[0])).toEqual([
      "needs-you-panel", "status-band", "queue-panel", "on-hold-panel", "roster", "live-work-grid", "raceway",
    ]);
    expect(host.querySelector(".get-started-panel")).toBeNull();
    expect(host.querySelector(".on-hold-panel .panel-note")?.textContent).toMatch(/none/);
    expect(operations.textContent).not.toMatch(/Signal raceway|Lifecycle motion|Work signals|Live roster|Active leases/);

    const taskMarks = [...host.querySelectorAll('[data-identity-key="task:41"]')];
    expect(taskMarks.length).toBeGreaterThanOrEqual(1);
    expect(new Set(taskMarks.map((mark) => `${mark.getAttribute("data-identity-slot")}:${mark.getAttribute("data-identity-icon")}`)).size).toBe(1);
    const agentMarks = [...host.querySelectorAll('[data-identity-key="agent:codex-a"]')];
    expect(agentMarks.length).toBeGreaterThanOrEqual(1);
    expect(new Set(agentMarks.map((mark) => `${mark.getAttribute("data-identity-slot")}:${mark.getAttribute("data-identity-icon")}`)).size).toBe(1);
    expect(host.querySelectorAll('.queue-table-wrap tbody tr [data-actor-role]')).toHaveLength(2);
    const desktopRoster = host.querySelector(".operations-surfaces > .roster.active-coders-strip")!;
    const toggle = desktopRoster.querySelector<HTMLButtonElement>(".active-coders-toggle")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toMatch(/Active Coders:\s*1/);
    expect(desktopRoster.querySelector(".roster-row")).toBeNull();
    await act(async () => { toggle.click(); });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(desktopRoster.querySelector('[data-actor-role="coder"] b')?.textContent).toBe("codex-a");
    expect(desktopRoster.querySelector('[data-actor-role="coder"]')?.getAttribute("aria-label")).toBe("codex-a, coder");
    expect(desktopRoster.querySelector('.state-chip[data-state="EXECUTING"]')).not.toBeNull();
    expect(desktopRoster.querySelector('button.roster-task-trigger[data-task-trigger="41"][aria-haspopup="dialog"]')).not.toBeNull();
    expect(desktopRoster.querySelector("select, pre")).toBeNull();
    expect(desktopRoster.querySelector('[data-identity-key^="task:"]')).toBeNull();
    expect(desktopRoster.textContent).not.toMatch(/\/agents|payload|endpoint|\{.*\}/i);
    expect(host.querySelector(".live-work-grid > .feed-surface")).not.toBeNull();
    expect(host.querySelector(".live-work-grid > .roster")).toBeNull();
    expect(host.querySelectorAll('.visual-key [data-actor-role]')).toHaveLength(3);
    expect(host.querySelectorAll('.visual-key .state-chip')).toHaveLength(5);
    expect(host.querySelectorAll(".visual-key .jargon-help")).toHaveLength(5);
    expect(host.querySelectorAll('.sidebar-nav a')).toHaveLength(5);
    expect(host.querySelector('.sidebar-nav a[aria-current="page"]')?.textContent).toContain("Operations");
    expect(host.querySelector(".page-header h1")?.textContent).toBe("Operations");
    expect(host.querySelector(".page-header .ui-button")?.textContent).toContain("Find work");
    expect(host.querySelector(".account-menu")).not.toBeNull();
  });

  it("loads and searches completed work only while the archive is open", async () => {
    const completedCalls: string[] = [];
    completedFetch = async () => {
      const path = vi.mocked(fetch).mock.calls.at(-1)?.[0];
      completedCalls.push(String(path));
      return new Response(JSON.stringify({ tasks: [queue.tasks[2]], limit: 20, offset: 0, next_offset: null }));
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(createElement(QueryClientProvider, { client }, createElement(App))));
    await vi.waitFor(() => expect(host.querySelector("#queue-title")).not.toBeNull());
    expect(completedCalls).toEqual([]);

    await act(async () => {
      host.querySelector<HTMLButtonElement>('.queue-heading button[aria-haspopup="dialog"]')!.click();
      await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Archived replay"));
    });
    expect(completedCalls).toHaveLength(1);

    const search = document.querySelector<HTMLInputElement>('input[aria-label="Search completed tasks"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "replay");
      search.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 300));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await vi.waitFor(() => expect(completedCalls).toHaveLength(2));
    expect(completedCalls[1]).toContain("q=replay");

    completedFetch = async () => new Response("failed", { status: 503 });
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["project", "p1", "tasks", "done"] });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await vi.waitFor(() => expect(document.querySelector(".completed-stale")?.textContent).toContain("Showing the last update"));
    expect(document.querySelector(".completed-table")?.textContent).toContain("Archived replay");

    completedFetch = async () => new Response(JSON.stringify({ tasks: [queue.tasks[2]], limit: 20, offset: 0, next_offset: null }));
    await act(async () => {
      document.querySelector<HTMLButtonElement>(".completed-stale button")!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => { await vi.waitFor(() => expect(document.querySelector(".completed-stale")).toBeNull()); });

    await act(async () => {
      document.querySelector<HTMLButtonElement>('[aria-label="Close completed tasks"]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => {
      host.querySelector<HTMLButtonElement>('.queue-heading button[aria-haspopup="dialog"]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Search completed tasks"]')?.value).toBe("replay");
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[aria-label="Close completed tasks"]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });

  it("does not commit TimelineIsland on one-second clock ticks", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(createElement(QueryClientProvider, { client }, createElement(App))));
    await vi.waitFor(() => expect(timelineRender).toHaveBeenCalled());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    const settledRenders = timelineRender.mock.calls.length;

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_100)); });

    expect(timelineRender).toHaveBeenCalledTimes(settledRenders);
  });

  it("resolves active-agent empty and first-load error states without transport copy", async () => {
    agentsFetch = async () => new Response(JSON.stringify({ agents: [], queued: 0 }));
    const emptyClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(createElement(QueryClientProvider, { client: emptyClient }, createElement(App))));
    const strip = () => host.querySelector(".operations-surfaces > .roster.active-coders-strip")!;
    await act(async () => { strip().querySelector<HTMLButtonElement>(".active-coders-toggle")?.click(); });
    await vi.waitFor(() => expect(strip().querySelector("[data-query-view=empty]")?.textContent).toContain("No coder is holding a live lease"));
    expect(strip().textContent).not.toContain("/agents");

    await act(async () => root.unmount());
    root = createRoot(host);
    agentsFetch = async () => new Response("unavailable", { status: 503 });
    const errorClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(createElement(QueryClientProvider, { client: errorClient }, createElement(App))));
    await act(async () => { strip().querySelector<HTMLButtonElement>(".active-coders-toggle")?.click(); });
    await vi.waitFor(() => expect(strip().querySelector("[data-query-view=error]")?.textContent).toContain("temporarily unavailable"));
    expect(strip().querySelector("[data-query-view=empty]")).toBeNull();
  });

  it("keeps a directly selected thread reachable when the navigator filters it out", async () => {
    window.history.replaceState(null, "", "/dashboard/?project=p1&view=dashboard&thread=5");
    threadsFetch = async () => new Response(JSON.stringify({ threads: [{
      id: 5, kind: "groom", task_id: null, root_id: null, created_at: 5,
      task_title: null, task_state: null, summary: "internal mediator activity",
      first_message: "internal mediator activity", last_message: "internal mediator activity",
      first_human_message: null, last_author: "steward", last_role: "mediator", last_activity: 5,
    }] }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => root.render(createElement(QueryClientProvider, { client }, createElement(App))));
    await vi.waitFor(() => expect(timelineRender).toHaveBeenCalled());

    expect(timelineRender.mock.calls.at(-1)?.[0]).toMatchObject({
      selection: { projectId: "p1", sessionId: 5, threadId: 5, taskId: null },
    });
    expect(host.querySelector(".feed-layout")).not.toBeNull();
    expect(host.querySelectorAll(".feed-surface nav > button")).toHaveLength(0);
  });

  it("does not report all clear while attention is loading", async () => {
    attentionFetch = () => new Promise<Response>(() => undefined);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client }, createElement(App)));
    });
    await vi.waitFor(() => expect(host.querySelectorAll(".needs-you-panel")).toHaveLength(2));

    expect([...host.querySelectorAll(".needs-you-panel")].every((panel) =>
      panel.textContent?.includes("Checking attention…")
      && !panel.textContent.includes("all clear")
    )).toBe(true);
  });

  it("shows only genuine open questions and labels project questions", async () => {
    attentionFetch = async () => new Response(JSON.stringify({ items: [{
      episode_id: "question:1", kind: "question", project: "p1", task_id: null,
      title: "Project question · p1", reason: "Which market matters first?", recovery: "Answer question #1",
      question_id: 1, badge: "QUESTION", state: "REVIEW", actor_name: "mediator", actor_role: "mediator",
      pushable: true, task_uri: null, dashboard_url: null,
    }] }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(createElement(QueryClientProvider, { client }, createElement(App))));
    await vi.waitFor(() => expect(host.querySelector('.attention-row[data-kind="question"]')?.textContent).toContain("Which market matters first?"));

    for (const panel of host.querySelectorAll(".needs-you-panel")) {
      expect(panel.querySelectorAll('.attention-row[data-kind="question"]')).toHaveLength(1);
      expect(panel.querySelector(".attention-context")?.textContent).toBe("Project question");
      expect(panel.textContent).not.toContain("Which region?");
      expect(panel.textContent).not.toContain("Resolved:");
    }
  });

  it("excludes held tasks while ranking actionable rows behind a disclosure", async () => {
    const baseTask = queue.tasks[1];
    const task = (id: number, state: string, extra: Record<string, unknown> = {}) => ({ ...baseTask, id, title: `Task ${id}`, state, created_at: id, updated_at: id, ...extra });
    queueFetch = async () => new Response(JSON.stringify({ ...queue, tasks: [
      task(103, "BLOCKED"), task(105, "BLOCKED"), task(107, "BLOCKED"), task(101, "HELD"), task(106, "HELD"),
      task(104, "QUEUED"), task(102, "EXECUTING", { lease_agent: "codex-b", lease_expires_at: Date.now() + 120_000 }),
    ] }));
    attentionFetch = async () => new Response(JSON.stringify({ items: [
      { episode_id: "blocked:103", kind: "blocked", project: "p1", task_id: 103, title: "Task 103", reason: "blocked", recovery: "unblock", badge: "BLOCKED", state: "BLOCKED", actor_name: "Ada", actor_role: "human", pushable: true, task_uri: "task://103", dashboard_url: null },
      { episode_id: "blocked:105", kind: "blocked", project: "p1", task_id: 105, title: "Task 105", reason: "blocked", recovery: "unblock", badge: "BLOCKED", state: "BLOCKED", actor_name: "Ada", actor_role: "human", pushable: true, task_uri: "task://105", dashboard_url: null },
      { episode_id: "blocked:107", kind: "blocked", project: "p1", task_id: 107, title: "Task 107", reason: "blocked", recovery: "unblock", badge: "BLOCKED", state: "BLOCKED", actor_name: "Ada", actor_role: "human", pushable: true, task_uri: "task://107", dashboard_url: null },
      { episode_id: "question:10", kind: "question", project: "p1", task_id: 104, title: "Task 104", reason: "Which path should task 104 take?", recovery: "answer", question_id: 10, badge: "QUESTION", state: "REVIEW", actor_name: "steward", actor_role: "mediator", pushable: true, task_uri: "task://104", dashboard_url: null },
      { episode_id: "question:11", kind: "question", project: "p1", task_id: null, title: "Project outcome", reason: "Which project outcome matters first?", recovery: "answer", question_id: 11, badge: "QUESTION", state: "REVIEW", actor_name: "steward", actor_role: "mediator", pushable: true, task_uri: null, dashboard_url: null },
      { episode_id: "lease:102:x", kind: "lease", project: "p1", task_id: 102, title: "Task 102", reason: "Lease expires soon.", recovery: "heartbeat", badge: "LEASE", state: "CLAIMED", actor_name: "codex-b", actor_role: "coder", pushable: false, task_uri: "task://102", dashboard_url: null },
    ] }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(createElement(QueryClientProvider, { client }, createElement(App))));
    await vi.waitFor(() => expect(host.querySelector(".attention-disclosure")?.textContent).toContain("1 more"));

    const panel = host.querySelector(".needs-you-panel")!;
    expect([...panel.querySelectorAll<HTMLElement>(".attention-row")].map((row) => row.dataset.kind)).toEqual(["blocked", "blocked", "blocked", "question", "question"]);
    expect(panel.textContent).not.toContain("HELD");
    expect(panel.textContent).not.toContain("Task 101");
    expect(panel.textContent).not.toContain("Task 106");
    expect(panel.querySelector(".attention-list")?.getAttribute("data-expanded")).toBe("false");
    await act(async () => panel.querySelector<HTMLButtonElement>(".attention-disclosure")!.click());
    expect(panel.querySelectorAll(".attention-row")).toHaveLength(6);
    expect(panel.querySelector(".attention-list")?.getAttribute("data-expanded")).toBe("true");
    expect(panel.querySelector(".attention-disclosure")?.textContent).toContain("Show fewer");
  });

  it("uses crafted zero-attention copy only after attention is known", async () => {
    queueFetch = async () => new Response(JSON.stringify({ ...queue, tasks: queue.tasks.map((task) => ({ ...task, state: "QUEUED", lease_agent: null, lease_expires_at: null })) }));
    attentionFetch = async () => new Response(JSON.stringify({ items: [] }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(createElement(QueryClientProvider, { client }, createElement(App))));
    await vi.waitFor(() => expect(host.querySelectorAll('.needs-you-panel [data-query-view="empty"]')).toHaveLength(2));
    expect([...host.querySelectorAll('.needs-you-panel [data-query-view="empty"]')].every((empty) => empty.textContent === "No open questions, blocked tasks, conflicts, or expiring leases.")).toBe(true);
  });

  it("reports unavailable attention with an accessible retry and no all clear", async () => {
    let attempts = 0;
    attentionFetch = async () => ++attempts === 1
      ? new Response("failed", { status: 500 })
      : new Response(JSON.stringify({ items: [leaseAttentionItem()] }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client }, createElement(App)));
    });
    await vi.waitFor(() => expect(host.querySelectorAll('.needs-you-panel [role="alert"]')).toHaveLength(2));

    for (const panel of host.querySelectorAll(".needs-you-panel")) {
      expect(panel.textContent).toMatch(/Attention (unavailable|temporarily unavailable)/i);
      expect(panel.textContent).not.toContain("all clear");
      expect([...panel.querySelectorAll("button")].some((button) => button.textContent === "Retry")).toBe(true);
    }

    await act(async () => {
      const retry = [...host.querySelectorAll<HTMLButtonElement>(".needs-you-panel button")]
        .find((button) => button.textContent === "Retry");
      retry!.click();
      await vi.waitFor(() => expect(attempts).toBe(2));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await vi.waitFor(() => expect([...host.querySelectorAll(".needs-you-panel")].every((panel) =>
      panel.textContent?.includes("1 item") && !panel.textContent?.includes("temporarily unavailable")
    )).toBe(true));
  });

  it("keeps last-good queue rows mounted while a failed refresh is retryable", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(createElement(QueryClientProvider, { client }, createElement(App))));
    await vi.waitFor(() => expect(host.querySelectorAll(".queue-table-wrap tbody tr")).toHaveLength(2));

    queueFetch = async () => new Response("failed", { status: 503 });
    await act(async () => { await client.invalidateQueries({ queryKey: ["project", "p1", "queue"] }); });
    await act(async () => { await vi.waitFor(() => expect(host.querySelector(".queue-panel .query-notice")?.textContent).toContain("Showing the last update")); });
    expect(host.querySelectorAll(".queue-table-wrap tbody tr")).toHaveLength(2);
    expect(host.querySelector(".shell-sidebar")).not.toBeNull();

    queueFetch = async () => new Response(JSON.stringify(queue));
    await act(async () => {
      host.querySelector<HTMLButtonElement>(".queue-panel .query-notice button")!.click();
      await vi.waitFor(() => expect(host.querySelector(".queue-panel .query-notice")).toBeNull());
    });
  });

  it("shows only the network error notice when Activity has no cached rows", async () => {
    threadsFetch = async () => new Response("failed", { status: 503 });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(createElement(QueryClientProvider, { client }, createElement(App))));
    await vi.waitFor(() => expect(host.querySelector(".feed-surface .query-notice")?.textContent).toContain("Activity temporarily unavailable"));

    expect(host.querySelector(".feed-surface .query-notice button")?.textContent).toBe("Retry");
    expect(host.querySelector(".feed-surface .feed-layout")).toBeNull();
    expect(host.querySelector(".feed-surface")?.textContent).not.toContain("No activity has been recorded");
  });
});
