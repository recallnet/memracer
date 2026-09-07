// GET /api/p/:project/queue-depth — the claimable-count a coder waiter blocks
// on (Fix A). Mirrors the coder claim eligibility (checkWork/availableInProject)
// as a cheap COUNT so `memracer wait` can loop off-model and wake only when
// there is claimable work. Same in-memory SQLite harness as
// tests/api-keys-operator.test.ts (real operator-token login loopback).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { openDb, type Db } from "../src/db.js";
import { authReady } from "../src/auth/instance.js";
import { createApp } from "../src/server.js";
import { FakeDriver } from "../src/mediator/fake.js";
import type { MediatorWorker } from "../src/mediator/worker.js";
import type { Queue } from "../src/queue.js";
import { magicLinkSessionCookie } from "./helpers/auth.js";

let httpServer: Server;
let baseUrl: string;
let worker: MediatorWorker;
let queue: Queue;
let dbRef: Db;

async function signInHuman(db: Db, email: string, name: string): Promise<{ userId: string; cookie: string }> {
  const cookie = await magicLinkSessionCookie(db, email, name);
  const userId = (await db.prepare('SELECT id FROM "user" WHERE email = ?').get<{ id: string }>(email))!.id;
  return { userId, cookie };
}

async function grantMembership(db: Db, userId: string, projectId: string, role: string): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO "organization" (id, name, slug, "createdAt") VALUES (?, ?, ?, ?)')
    .run(projectId, projectId, projectId, new Date().toISOString());
  await db
    .prepare('INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES (?, ?, ?, ?, ?)')
    .run(`${userId}-${projectId}`, projectId, userId, role, new Date().toISOString());
}

let cookieAdmin: string;
let userAdmin: string;

beforeEach(async () => {
  dbRef = openDb(":memory:");
  const made = createApp(dbRef, {
    driverFor: () => new FakeDriver(),
    workerOpts: { tickMs: 20, jobTimeoutMs: 2000 },
    sseKeepaliveMs: 40,
  });
  worker = made.worker;
  queue = made.queue;
  await authReady(dbRef);
  await dbRef.prepare("INSERT INTO projects (id, name, repo) VALUES (?, ?, ?)").run("memracer", "Memracer", "recallnet/memracer");
  const a = await signInHuman(dbRef, "ada@memracer.test", "Ada");
  userAdmin = a.userId;
  cookieAdmin = a.cookie;
  await grantMembership(dbRef, userAdmin, "memracer", "admin");
  await new Promise<void>((resolve) => {
    httpServer = made.app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterEach(async () => {
  worker.stop();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

/** Drive the login loopback: authorize (session) → code → operator token. */
async function login(cookie = cookieAdmin): Promise<string> {
  const redirectUri = "http://127.0.0.1:56789/cb";
  const authorize = await fetch(
    `${baseUrl}/api/cli/authorize?redirect_uri=${encodeURIComponent(redirectUri)}&state=xyz`,
    { headers: { Cookie: cookie }, redirect: "manual" },
  );
  const code = new URL(authorize.headers.get("location")!).searchParams.get("code")!;
  const token = await fetch(`${baseUrl}/api/cli/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  return (await token.json()).token as string;
}

/** Mint a coder seat key (Bearer) via the browser session. */
async function createCoderSeat(): Promise<string> {
  const res = await fetch(`${baseUrl}/api/p/memracer/api-keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieAdmin },
    body: JSON.stringify({ name: "fleet", type: "coder" }),
  });
  return (await res.json()).key as string;
}

async function depth(token: string, role = "coder"): Promise<{ status: number; available?: number }> {
  const res = await fetch(`${baseUrl}/api/p/memracer/queue-depth?role=${role}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const body = (await res.json().catch(() => ({}))) as { available?: number };
  return { status: res.status, available: body.available };
}

describe("GET /api/p/:project/queue-depth", () => {
  it("counts a claimable coder task for an operator token (available >= 1)", async () => {
    await queue.submit("memracer", userAdmin, { title: "do a thing", body: "please", evidence: [] });
    const operatorToken = await login();
    const { status, available } = await depth(operatorToken);
    expect(status).toBe(200);
    expect(available).toBeGreaterThanOrEqual(1);
  });

  it("returns 0 when there is no claimable work", async () => {
    const operatorToken = await login();
    const { status, available } = await depth(operatorToken);
    expect(status).toBe(200);
    expect(available).toBe(0);
  });

  it("accepts a coder seat Bearer token", async () => {
    await queue.submit("memracer", userAdmin, { title: "seat-visible", body: "x", evidence: [] });
    const seatKey = await createCoderSeat();
    const { status, available } = await depth(seatKey);
    expect(status).toBe(200);
    expect(available).toBeGreaterThanOrEqual(1);
  });

  it("401 without any token", async () => {
    await queue.submit("memracer", userAdmin, { title: "t", body: "x", evidence: [] });
    const { status } = await depth("");
    expect(status).toBe(401);
  });
});

/** Read the events stream until a `queue` frame arrives (or time out → null). */
async function firstQueueFrame(
  token: string,
  role = "coder",
  timeoutMs = 2000,
): Promise<{ role: string; available: number } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/api/p/memracer/events?role=${role}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return null;
      buf += decoder.decode(value, { stream: true });
      const idx = buf.indexOf("event: queue\n");
      if (idx >= 0) {
        const dataLine = buf.slice(idx).split("\n").find((l) => l.startsWith("data:"));
        if (dataLine) {
          controller.abort();
          return JSON.parse(dataLine.slice("data:".length).trim());
        }
      }
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

describe("GET /api/p/:project/events — in-band claimable count (Fix: no follow-up request)", () => {
  it("pushes the claimable count on connect for a role-scoped subscriber", async () => {
    await queue.submit("memracer", userAdmin, { title: "t", body: "x", evidence: [] });
    const seatKey = await createCoderSeat();
    const frame = await firstQueueFrame(seatKey);
    expect(frame).toMatchObject({ role: "coder" });
    expect(frame!.available).toBeGreaterThanOrEqual(1);
  });

  it("reports zero claimable on connect when the queue is empty", async () => {
    const operatorToken = await login();
    const frame = await firstQueueFrame(operatorToken);
    expect(frame).toEqual({ role: "coder", available: 0 });
  });

  it("omits the queue frame when no role is requested (dashboards pay nothing)", async () => {
    await queue.submit("memracer", userAdmin, { title: "t", body: "x", evidence: [] });
    const operatorToken = await login();
    const frame = await firstQueueFrame(operatorToken, "");
    expect(frame).toBeNull();
  });
});
