// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/dashboard/web/src/app.js";
import { NO_ORG_KEY } from "../src/dashboard/web/lib/org-workspace.js";
import { parseUrlState } from "../src/dashboard/web/lib/url-state.js";

vi.mock("../src/dashboard/island/index.js", () => ({
  TimelineIsland: () => null,
}));

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(_url: string) {
    queueMicrotask(() => this.onopen?.());
  }
  addEventListener() { /* unused */ }
  close() { /* unused */ }
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

const memberships = [
  {
    projectId: "pA",
    projectName: "Project A",
    repo: null,
    role: "admin" as const,
    orgId: "orgA",
    orgName: "Org A",
  },
  {
    projectId: "pB",
    projectName: "Project B",
    repo: null,
    role: "admin" as const,
    orgId: "orgB",
    orgName: "Org B",
  },
  {
    projectId: "pNone",
    projectName: "Solo Project",
    repo: null,
    role: "admin" as const,
    orgId: null,
    orgName: null,
  },
];

let root: Root;
let host: HTMLDivElement;

async function mountApp(search: string) {
  window.history.replaceState(null, "", `/dashboard/${search}`);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  await act(async () => {
    root.render(
      createElement(QueryClientProvider, { client }, createElement(App)),
    );
  });
  // Flush query microtasks
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, EventSource: FakeEventSource });
  vi.stubGlobal("localStorage", memoryStorage());
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const path = String(input);
    if (path.endsWith("/api/projects")) {
      return new Response(JSON.stringify({ projects: memberships }));
    }
    if (path.endsWith("/api/session")) {
      return new Response(JSON.stringify({ userId: "u1", name: "Ada", email: "ada@example.com" }));
    }
    if (path.endsWith("/api/push/status")) {
      return new Response(JSON.stringify({
        configured: false, vapid_public_key: null, subscribed: false, subscription_count: 0, last_error_at: null,
      }));
    }
    if (path.includes("/api/org/") && path.endsWith("/settings")) {
      return new Response(JSON.stringify({
        orgId: "orgA",
        orgName: "Org A",
        plan: "free",
        seats: { used: 1, limit: 3 },
        providerKeys: [],
        billing: null,
      }));
    }
    if (path.includes("/api/p/")) {
      if (path.endsWith("/queue")) {
        return new Response(JSON.stringify({
          tasks: [],
          overview: {
            window: { label: "last 7 days", since: Date.now() - 7 * 864e5 },
            trends: { open: 0, active: 0, ready: 0, done: 0 },
            transitions: [],
          },
        }));
      }
      if (path.endsWith("/agents")) return new Response(JSON.stringify({ agents: [], queued: 0 }));
      if (path.endsWith("/attention")) return new Response(JSON.stringify({ items: [] }));
      if (path.endsWith("/threads")) return new Response(JSON.stringify({ threads: [] }));
      if (path.includes("/tasks/done")) {
        return new Response(JSON.stringify({ tasks: [], limit: 20, offset: 0, next_offset: null }));
      }
      if (path.endsWith("/health")) {
        return new Response(JSON.stringify({ inFlight: 0, sweepErrors: {}, drainErrors: {} }));
      }
      if (path.endsWith("/seat-readiness")) {
        return new Response(JSON.stringify({ ready: true, seats: [] }));
      }
    }
    return new Response("missing", { status: 404 });
  }));
});

afterEach(() => {
  act(() => { root.unmount(); });
  host.remove();
  vi.unstubAllGlobals();
});

describe("org-settings fallthrough + cohort", () => {
  it("renders EmptyState for unresolvable org — never Operations tree", async () => {
    await mountApp("?project=pA&view=org-settings&org=missing-org");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.querySelector('[data-testid="org-settings-unresolved"]')).toBeTruthy();
    expect(host.querySelector(".operations-surfaces")).toBeNull();
    expect(host.querySelector(".org-settings-view")).toBeNull();
  });

  it("never keeps org=__none__ in the URL on org-settings", async () => {
    await mountApp(`?project=pNone&view=org-settings&org=${NO_ORG_KEY}`);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const state = parseUrlState(window.location.search);
    expect(state.org).not.toBe(NO_ORG_KEY);
    // No membership org → unresolved EmptyState, not Operations.
    expect(host.querySelector('[data-testid="org-settings-unresolved"]')).toBeTruthy();
    expect(host.querySelector(".operations-surfaces")).toBeNull();
  });

  it("Jump picker cohort follows URL org, not shell project org", async () => {
    // Shell project pB is in orgB; form org is orgA.
    await mountApp("?project=pB&view=org-settings&org=orgA");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const jump = host.querySelector<HTMLElement>("#project-select")
      ?? host.querySelector('[aria-label="Jump to project Operations"]');
    // Select trigger is present; open options if custom Select stores options on the control.
    expect(host.querySelector(".org-settings-view, .settings-view")).toBeTruthy();
    // Project A (orgA) must appear in Jump options; Project B alone is the shell project of orgB.
    const labels = [...host.querySelectorAll("[role='option'], .ui-select-item, option")]
      .map((node) => node.textContent ?? "");
    // If options are not in DOM until open, at least the current select value label should not force orgB-only.
    // Drive open via the Jump select trigger.
    const trigger = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Jump to project Operations"], #project-select',
    );
    if (trigger) {
      await act(async () => {
        trigger.click();
      });
    }
    const afterOpen = [...host.querySelectorAll("[role='option'], .ui-select-item, option")]
      .map((node) => node.textContent ?? "");
    const all = [...labels, ...afterOpen].join("\n");
    expect(all).toMatch(/Project A/);
    expect(all).not.toMatch(/Project B/);
  });
});

describe("github-connection-grid-org CSS", () => {
  it("defines a single-column grid for org scope", async () => {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const css = await readFile(
      resolve(process.cwd(), "src/dashboard/web/styles/theme.css"),
      "utf8",
    );
    expect(css).toMatch(/\.github-connection-grid-org\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });
});
