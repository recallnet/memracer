// tests/dashboard-static.test.ts
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
let responses: Response[];

async function trackedFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  responses.push(response);
  return response;
}

beforeEach(async () => {
  responses = [];
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
  await Promise.all(responses.map(async (response) => {
    if (!response.bodyUsed) await response.body?.cancel();
  }));
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

describe("dashboard static front-end", () => {
  it("GET / serves the signed-out marketing homepage", async () => {
    const res = await trackedFetch(`${baseUrl}/`, { redirect: "manual" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain('id="root"');
    expect(html).toContain('src="/dashboard/marketing.js"');
    expect(html).toContain('href="/dashboard/dashboard.css"');
    expect(html.toLowerCase()).toContain("memracer");
  });

  it("GET /dashboard serves the app shell without auth", async () => {
    const res = await trackedFetch(`${baseUrl}/dashboard`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain('id="root"');
    expect(html).toContain('src="/dashboard/app.js"');
    expect(html).toContain('href="/dashboard/manifest.json"');
  });

  it("serves the canonical bundle and retained PWA/auth support assets without auth", async () => {
    const js = await trackedFetch(`${baseUrl}/dashboard/app.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("javascript");
    const dashboardCss = await trackedFetch(`${baseUrl}/dashboard/dashboard.css`);
    expect(dashboardCss.status).toBe(200);
    expect(dashboardCss.headers.get("content-type")).toContain("css");
    const css = await trackedFetch(`${baseUrl}/dashboard/styles.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("css");
    for (const path of ["manifest.json", "icons/icon-192.png", "role-contracts.js"]) {
      expect((await trackedFetch(`${baseUrl}/dashboard/${path}`)).status, path).toBe(200);
    }
    expect((await trackedFetch(`${baseUrl}/signin`)).status).toBe(200);
    expect((await trackedFetch(`${baseUrl}/join?token=test`)).status).toBe(200);
  });

  it("keeps staging and removed controller assets unavailable", async () => {
    expect((await trackedFetch(`${baseUrl}/dashboard/next`, { redirect: "manual" })).status).toBe(404);
    expect((await trackedFetch(`${baseUrl}/dashboard/next/`)).status).toBe(404);
    expect((await trackedFetch(`${baseUrl}/dashboard/url-state.js`)).status).toBe(404);
    expect((await trackedFetch(`${baseUrl}/dashboard/island.js`)).status).toBe(404);
  });

  it("API auth stays intact next to the static mount", async () => {
    const res = await trackedFetch(`${baseUrl}/api/projects`);
    expect(res.status).toBe(401);
  });
});
