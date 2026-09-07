// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskDetailSheet } from "../src/dashboard/web/components/task-detail-sheet.js";
import type { TaskDetailDto } from "../src/dashboard/web/data/dto.js";

vi.mock("../src/dashboard/island/index.js", () => ({ TimelineIsland: () => null }));

const task: TaskDetailDto = {
  id: 172,
  project_id: "p/a",
  title: "Attach screenshots",
  body: "Show image evidence in task detail.",
  priority: 1,
  state: "EXECUTING",
  base_sha: "abc123def456",
  repo: null,
  submitted_by: "Ada",
  lease_agent: "coder-a",
  lease_expires_at: null,
  result_summary: null,
  result_pr_url: null,
  result_pr_number: null,
  pr_verification: null,
  grooming_rationale: "The screenshots show the failing queue state.",
  parent_id: null,
  incubate_until: null,
  hold_cause: null,
  created_at: 1,
  updated_at: 2,
  watermark: null,
  result_pr_description: null,
  root_thread_id: null,
  plan: "1. Render evidence\n2. Verify the task sheet",
  plan_deadline: null,
  plan_approved_at: null,
  queued_at: null,
  queue_generation: 0,
  waiting_on: [],
  evidence: [{ id: 9, kind: "code", path: "src/queue.ts", lines: "10-20", snippet: "export function drain() {}", note: "Queue drain entry point" }],
  attempts: [],
  notes: [],
  questions: [],
  threads: [],
  decisions: [],
  grooming_citations: [],
};

let root: Root;
let host: HTMLDivElement;
let imageMetadataResponse: () => Response;

beforeEach(() => {
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    matchMedia: vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })),
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  imageMetadataResponse = () => new Response(JSON.stringify({ images: [
    { id: 7, mime_type: "image/png", caption: "Queue stalled at awaiting checks" },
    { id: 8, mime_type: "image/webp", caption: null },
  ] }));
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const path = String(input);
    if (path.endsWith("/api/p/p%2Fa/tasks/172")) return new Response(JSON.stringify(task));
    if (path.endsWith("/api/p/p%2Fa/tasks/172/images")) return imageMetadataResponse();
    return new Response("missing", { status: 404 });
  }));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  task.questions = [];
  task.state = "EXECUTING";
  task.lease_agent = "coder-a";
  task.result_summary = null;
  vi.unstubAllGlobals();
});

function renderSheet() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return act(async () => root.render(createElement(
    QueryClientProvider,
    { client },
    createElement(TaskDetailSheet, {
      project: "p/a",
      taskId: 172,
      threadId: null,
      onOpenTask: vi.fn(),
      onThread: vi.fn(),
      onClose: vi.fn(),
      returnFocus: createRef<HTMLElement>(),
    }),
  )));
}

describe("task image gallery", () => {
  it("renders the How I verified claim from a completed task's result_summary", async () => {
    task.state = "DONE";
    task.lease_agent = null;
    task.result_summary = "shipped rate limiter\n\nverification: pnpm test — server.test rate-limit cases green";
    await renderSheet();
    await act(async () => {
      await vi.waitFor(() => expect(document.querySelector(".task-sheet-body")).not.toBeNull());
    });
    const claim = document.querySelector('[aria-label="How I verified"]');
    expect(claim).not.toBeNull();
    expect(claim?.textContent).toContain("How I verified");
    expect(claim?.textContent).toContain("pnpm test — server.test rate-limit cases green");
  });

  it("surfaces the specification, evidence, metadata, and record counts through the shared primitives", async () => {
    await renderSheet();
    await act(async () => {
      await vi.waitFor(() => expect(document.querySelector(".task-sheet-body")).not.toBeNull());
    });

    expect([...document.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual([
      "Conversation0", "Specification3", "Evidence1", "Attempts0", "Questions0", "Decisions0",
    ]);
    expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Conversation0");
    expect(document.querySelector(".task-sheet-sidebar")?.textContent).toContain("abc123def456");
    expect(document.querySelector('.task-summary-status [data-actor-role="coder"]')?.textContent).toContain("coder-a");
    expect(document.querySelector(".task-sheet [data-identity-key^=\"task:\"]")).toBeNull();
    expect(document.querySelector(".task-sheet select")).toBeNull();
    expect(document.querySelector(".task-sheet pre")).toBeNull();

    await act(async () => document.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1]?.click());
    expect(document.querySelector('[role="tabpanel"]:not([hidden]) .task-body-copy')?.textContent).toContain("Show image evidence");
    expect(document.querySelector('#plan .task-code-block code')?.textContent).toContain("Render evidence");

    await act(async () => document.querySelectorAll<HTMLButtonElement>('[role="tab"]')[2]?.click());
    expect(document.querySelector('[data-evidence-id="9"]')?.textContent).toContain("Queue drain entry point");
    expect(document.querySelector('[data-evidence-id="9"] code')?.textContent).toContain("export function drain");

    await act(async () => document.querySelectorAll<HTMLButtonElement>('[role="tab"]')[5]?.click());
    expect(document.querySelector('[role="tabpanel"]:not([hidden])')?.textContent).toContain("No Frigg decisions have been recorded.");
    expect(document.querySelector('[role="tabpanel"]:not([hidden])')?.textContent).not.toContain("mediator");
  });

  it("renders lazy images from the authenticated binary route and isolates an individual load failure", async () => {
    await renderSheet();
    await act(async () => {
      await vi.waitFor(() => expect(document.querySelectorAll(".task-image-card img")).toHaveLength(2));
    });

    const images = [...document.querySelectorAll<HTMLImageElement>(".task-image-card img")];
    expect(images[0]?.src).toContain("/p/p%2Fa/images/7");
    expect(images[0]?.alt).toBe("Queue stalled at awaiting checks");
    expect(images[0]?.getAttribute("loading")).toBe("lazy");
    expect(images[0]?.getAttribute("decoding")).toBe("async");
    expect(images[1]?.alt).toBe("Attached image 2");

    await act(async () => images[0]?.dispatchEvent(new Event("error")));
    expect(document.querySelector(".task-image-card [role=\"alert\"]")?.textContent).toContain("Image unavailable");
    expect(document.querySelector(".task-sheet")?.textContent).toContain("Attach screenshots");
    expect(document.querySelectorAll(".task-image-card img")).toHaveLength(1);

    await act(async () => document.querySelector<HTMLButtonElement>(".task-image-failure button")?.click());
    expect(document.querySelector<HTMLImageElement>('.task-image-card img[src*="retry=1"]')).not.toBeNull();
  });

  it("presents a legacy steward question as Frigg while preserving the mediator role", async () => {
    task.questions = [{ question: "Which retry path?", answer: null, status: "open", asked_by: "steward" }];
    await renderSheet();
    await act(async () => {
      await vi.waitFor(() => expect(document.querySelector(".task-sheet-body")).not.toBeNull());
      document.querySelectorAll<HTMLButtonElement>('[role="tab"]')[4]?.click();
    });

    const actor = document.querySelector('[role="tabpanel"] .task-actor');
    expect(actor?.getAttribute("data-actor-role")).toBe("mediator");
    expect(actor?.querySelector("b")?.textContent).toBe("Frigg");
    expect(actor?.textContent).not.toContain("steward");
  });

  it("keeps task detail usable when image metadata fails and offers a local retry", async () => {
    imageMetadataResponse = () => new Response("unavailable", { status: 503 });
    await renderSheet();
    await act(async () => {
      await vi.waitFor(() => expect(document.querySelector(".task-images-error")).not.toBeNull());
    });

    expect(document.querySelector(".task-sheet")?.textContent).toContain("Attach screenshots");
    expect(document.querySelector(".task-images-error")?.textContent).toContain("Images unavailable");

    imageMetadataResponse = () => new Response(JSON.stringify({ images: [] }));
    await act(async () => {
      document.querySelector<HTMLButtonElement>(".task-images-error button")?.click();
    });
    await act(async () => {
      await vi.waitFor(() => expect(document.querySelector(".task-images-error")).toBeNull());
    });
    expect(document.querySelector(".task-sheet")?.textContent).toContain("Attach screenshots");
  });
});
