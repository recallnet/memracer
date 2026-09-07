// tests/dashboard-mobile.test.ts — the mobile shell's static surface: the PWA
// manifest, its icons, and the responsive markup the <768px shell needs.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { openDb } from "../src/db.js";
import { createApp } from "../src/server.js";
import { FakeDriver } from "../src/mediator/fake.js";
import type { MediatorWorker } from "../src/mediator/worker.js";

let httpServer: Server;
let baseUrl: string;
let worker: MediatorWorker;

beforeEach(async () => {
  const db = openDb(":memory:");
  const made = createApp(db, { driverFor: () => new FakeDriver() });
  worker = made.worker;
  await new Promise<void>((resolve) => {
    httpServer = made.app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterEach(async () => {
  worker.stop();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

describe("dashboard PWA + mobile shell", () => {
  it("serves a valid PWA manifest with standalone display and required icons", async () => {
    const res = await fetch(`${baseUrl}/dashboard/manifest.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("json");
    const m = (await res.json()) as {
      name: string; start_url: string; display: string; theme_color: string;
      icons: { src: string; sizes: string; purpose?: string }[];
    };
    expect(m.name).toBe("memracer");
    expect(m.start_url).toBe("/dashboard");
    expect(m.display).toBe("standalone");
    expect(m.theme_color).toBe("#08090c");
    const sizes = m.icons.map((i) => i.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
    expect(m.icons.some((i) => i.purpose === "maskable")).toBe(true);
  });

  it("serves each icon as a real PNG", async () => {
    for (const path of [
      "/dashboard/icons/icon-192.png",
      "/dashboard/icons/icon-512.png",
      "/dashboard/icons/icon-maskable-512.png",
      "/dashboard/icons/apple-touch-icon-180.png",
    ]) {
      const res = await fetch(`${baseUrl}${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type"), path).toContain("image/png");
      const sig = Buffer.from(await res.arrayBuffer()).subarray(0, 8).toString("hex");
      expect(sig, path).toBe("89504e470d0a1a0a"); // PNG magic
    }
  });

  it("the canonical shell carries the PWA head tags and React entry", async () => {
    const html = await (await fetch(`${baseUrl}/dashboard`)).text();
    // PWA head
    expect(html).toContain("viewport-fit=cover");
    expect(html).toContain('name="theme-color"');
    expect(html).toContain('rel="manifest"');
    expect(html).toContain('rel="apple-touch-icon"');
    expect(html).toContain('id="root"');
    expect(html).toContain('src="/dashboard/app.js"');
    expect(html).toContain('href="/dashboard/dashboard.css"');
    const js = await (await fetch(`${baseUrl}/dashboard/app.js`)).text();
    for (const tab of ["Activity", "Queue", "You", "Knowledge", "Team"]) expect(js).toContain(tab);
  });

  it("the Knowledge tab is wired to the real OKF browser, not a static placeholder", async () => {
    const js = await (await fetch(`${baseUrl}/dashboard/app.js`)).text();
    expect(js).toContain("knowledge-back");
    expect(js).toContain("knowledge-tree");
    expect(js).toContain("Knowledge concepts");
    for (const section of ["Recent updates", "Conventions in force", "Decisions"]) expect(js).toContain(section);
    const css = await (await fetch(`${baseUrl}/dashboard/dashboard.css`)).text();
    expect(css).toContain(".knowledge-view");
    expect(css).toContain(".knowledge-back");
  });

  it("the desktop layout stays two-column: the mobile shell is fenced behind a max-width query", async () => {
    const css = await (await fetch(`${baseUrl}/dashboard/dashboard.css`)).text();
    expect(css).toContain("@media (width<=850px)");
    expect(css).toContain(".live-work-grid");
    // Activity is full-width; Active Coders is a separate strip (not a side column).
    expect(css).toContain("grid-template-columns:minmax(0,1fr)");
    expect(css).toContain(".active-coders-strip");
    // Safe-area insets are respected.
    expect(css).toContain("env(safe-area-inset-bottom)");
  });
});

// ---- task #59: the four mobile content surfaces built inside #58's shell ----
describe("canonical mobile content surfaces", () => {
  it("Activity carries the shared session replay and pinning implementation", async () => {
    const js = await (await fetch(`${baseUrl}/dashboard/app.js`)).text();
    expect(js).toContain("feed-surface");
    expect(js).toContain("Activity");
    expect(js).toContain("data-pinned");
    const css = await (await fetch(`${baseUrl}/dashboard/dashboard.css`)).text();
    expect(css).toContain(".feed-timeline");
  });

  it("Queue renders as tappable mobile cards below 768px (desktop table untouched)", async () => {
    const css = await (await fetch(`${baseUrl}/dashboard/dashboard.css`)).text();
    expect(css).toContain(".queue-card");
    const js = await (await fetch(`${baseUrl}/dashboard/app.js`)).text();
    expect(js).toContain("queue-cards");
    expect(js).toContain("data-task-trigger");
  });

  it("the task drill-in becomes a full-width mobile sheet", async () => {
    const js = await (await fetch(`${baseUrl}/dashboard/app.js`)).text();
    expect(js).toContain("task-sheet-overlay");
    expect(js).toContain("Close task detail");
    const css = await (await fetch(`${baseUrl}/dashboard/dashboard.css`)).text();
    expect(css).toContain(".task-sheet");
    expect(css).toContain("width:100vw");
  });

  it("You surface has empty and populated project-scoped states", async () => {
    const js = await (await fetch(`${baseUrl}/dashboard/app.js`)).text();
    expect(js).toContain("you-surface");
    expect(js).toContain("Needs you");
    expect(js).toContain("No open questions, blocked tasks, conflicts, or expiring leases.");
    const css = await (await fetch(`${baseUrl}/dashboard/dashboard.css`)).text();
    expect(css).toContain(".you-surface");
  });

  it("shows factual live status, current counts, and recent transitions", async () => {
    const js = await (await fetch(`${baseUrl}/dashboard/app.js`)).text();
    expect(js).toContain("live-heartbeat");
    expect(js).toContain("Project health");
    expect(js).toContain("last 7 days");
    expect(js).toContain("Recent transitions");
    const css = await (await fetch(`${baseUrl}/dashboard/dashboard.css`)).text();
    expect(css).toContain("prefers-reduced-motion:reduce");
  });

  it("loading, error, empty, and retry states are present", async () => {
    const js = await (await fetch(`${baseUrl}/dashboard/app.js`)).text();
    expect(js).toContain("Loading queue");
    expect(js).toContain("query-notice");
    expect(js).toContain("error-panel");
    expect(js).toContain("surface-error");
    expect(js).toContain("Retry");
    expect(js).toContain("empty-copy");
    expect(js).toContain("No activity was recorded for this thread");
    expect(js).toContain("Choose a thread to view its activity");
    expect(js).not.toContain("select a session to see its timeline");
  });

  it("all new interactive targets meet the 44px touch floor and honor reduced motion", async () => {
    const css = await (await fetch(`${baseUrl}/dashboard/dashboard.css`)).text();
    expect(css).toContain(".mobile-tabs button");
    expect(css).toContain("min-height:48px");
    expect(css).toContain("@media (prefers-reduced-motion:reduce)");
  });
});
