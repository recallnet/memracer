// Passwordless invitation and configuration coverage. Better Auth's magic-link
// verifier owns account creation and the session cookie; the invitation token
// only grants the project membership after that session is established.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { openDb, type Db } from "../src/db.js";
import { createApp } from "../src/server.js";
import { authReady } from "../src/auth/instance.js";
import { FakeDriver } from "../src/mediator/fake.js";
import type { MediatorWorker } from "../src/mediator/worker.js";
import { magicLinkSessionCookie } from "./helpers/auth.js";

let httpServer: Server;
let baseUrl: string;
let worker: MediatorWorker;
let dbRef: Db;

beforeEach(async () => {
  dbRef = openDb(":memory:");
  await authReady(dbRef);
  const made = createApp(dbRef, {
    driverFor: () => new FakeDriver(),
    workerOpts: { tickMs: 20, jobTimeoutMs: 2000 },
    sseKeepaliveMs: 40,
  });
  worker = made.worker;
  await new Promise<void>((resolve) => { httpServer = made.app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterEach(async () => {
  worker.stop();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await dbRef.close();
});

function req(path: string, cookie: string | null, body?: unknown, method = "POST"): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function onboard(email: string, name: string): Promise<{ cookie: string; projectId: string }> {
  const cookie = await magicLinkSessionCookie(dbRef, email, name);
  const org = (await (await req("/api/orgs", cookie, { name: "Acme" })).json()) as { id: string };
  // Invites require an active paid plan (no free multi-seat tier).
  await dbRef
    .prepare("UPDATE orgs SET plan = ?, seat_quantity = ?, billing_status = ? WHERE id = ?")
    .run("team", 50, "active", org.id);
  const project = (await (await req(`/api/orgs/${org.id}/projects`, cookie, { name: "Widgets", repo: "acme/thing" })).json()) as { id: string };
  return { cookie, projectId: project.id };
}

function tokenOf(inviteUrl: string): string {
  return new URL(inviteUrl).searchParams.get("token")!;
}

describe("passwordless invitation minting", () => {
  it("sends a magic link, keeps the invitation pending, and does not provision the user", async () => {
    const { cookie, projectId } = await onboard("boss@acme.test", "Boss");
    const response = await req(`/api/p/${projectId}/invite`, cookie, { email: "new@acme.test" });
    expect(response.status).toBe(200);
    const body = await response.json() as { inviteUrl: string; email: string; role: string; expiresAt: number; emailSent: boolean };
    expect(body).toMatchObject({ email: "new@acme.test", role: "human", emailSent: true });
    expect(body.inviteUrl).toContain("/join?token=");
    expect(body.expiresAt).toBeGreaterThan(Date.now());
    expect(await dbRef.prepare('SELECT id FROM "user" WHERE email = ?').get("new@acme.test")).toBeUndefined();
    expect(await dbRef.prepare('SELECT status, token FROM "invitation" WHERE email = ?').get("new@acme.test")).toEqual({ status: "pending", token: tokenOf(body.inviteUrl) });
    expect(await dbRef.prepare('SELECT COUNT(*) AS n FROM "verification"').get<{ n: number }>()).toMatchObject({ n: 1 });
  });

  it("rejects invalid roles and non-admin senders", async () => {
    const { cookie, projectId } = await onboard("admin@acme.test", "Admin");
    const ok = await req(`/api/p/${projectId}/invite`, cookie, { email: "coder@acme.test", role: "coder" });
    expect((await ok.json()).role).toBe("coder");
    expect((await req(`/api/p/${projectId}/invite`, cookie, { email: "bad@acme.test", role: "root" })).status).toBe(400);

    const invite = await req(`/api/p/${projectId}/invite`, cookie, { email: "human@acme.test" });
    const humanCookie = await magicLinkSessionCookie(dbRef, "human@acme.test", "Human");
    expect((await req(`/api/invite/${tokenOf((await invite.json()).inviteUrl)}/accept`, humanCookie, {})).status).toBe(200);
    expect((await req(`/api/p/${projectId}/invite`, humanCookie, { email: "blocked@acme.test" })).status).toBe(403);
  });
});

describe("passwordless invitation acceptance", () => {
  it("requires the invited email's magic-link session and consumes the invitation once", async () => {
    const { cookie, projectId } = await onboard("owner@acme.test", "Owner");
    const invite = await req(`/api/p/${projectId}/invite`, cookie, { email: "fresh@acme.test", role: "coder" });
    const inviteBody = await invite.json() as { inviteUrl: string };
    const token = tokenOf(inviteBody.inviteUrl);
    expect((await fetch(`${baseUrl}/api/invite/${token}`)).status).toBe(200);

    const wrongCookie = await magicLinkSessionCookie(dbRef, "other@acme.test", "Other");
    expect((await req(`/api/invite/${token}/accept`, wrongCookie, {})).status).toBe(400);
    const inviteeCookie = await magicLinkSessionCookie(dbRef, "fresh@acme.test", "Fresh");
    const accepted = await req(`/api/invite/${token}/accept`, inviteeCookie, {});
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ ok: true, signedIn: true });
    const userId = (await dbRef.prepare('SELECT id FROM "user" WHERE email = ?').get<{ id: string }>("fresh@acme.test"))!.id;
    expect(await dbRef.prepare('SELECT role FROM "member" WHERE "userId" = ? AND "organizationId" = ?').get(userId, projectId)).toEqual({ role: "coder" });
    expect(await dbRef.prepare('SELECT status FROM "invitation" WHERE token = ?').get(token)).toEqual({ status: "accepted" });
    expect((await req(`/api/invite/${token}/accept`, inviteeCookie, {})).status).toBe(410);
    expect((await fetch(`${baseUrl}/api/invite/${token}`)).status).toBe(404);
  });

  it("rejects an expired invitation", async () => {
    const { cookie, projectId } = await onboard("owner-expiry@acme.test", "Owner");
    const body = await (await req(`/api/p/${projectId}/invite`, cookie, { email: "late@acme.test" })).json() as { inviteUrl: string };
    const token = tokenOf(body.inviteUrl);
    await dbRef.prepare('UPDATE "invitation" SET "expiresAt" = ? WHERE token = ?').run(new Date(Date.now() - 1000).toISOString(), token);
    expect((await fetch(`${baseUrl}/api/invite/${token}`)).status).toBe(404);
    expect((await req(`/api/invite/${token}/accept`, null, {})).status).toBe(410);
  });
});

describe("GET /api/config — no CF Access credentials", () => {
  it("never returns CF Access fields", async () => {
    expect((await req("/api/config", null, undefined, "GET")).status).toBe(401);
    process.env.MEMRACER_CF_ACCESS_CLIENT_SECRET = "secret-must-not-leak";
    try {
      const { cookie } = await onboard("config2@acme.test", "Config2");
      const body = await (await req("/api/config", cookie, undefined, "GET")).json() as Record<string, unknown>;
      expect(body).not.toHaveProperty("cfAccessClientId");
      expect(body).not.toHaveProperty("cfAccessClientSecret");
      expect(JSON.stringify(body)).not.toContain("secret-must-not-leak");
    } finally {
      delete process.env.MEMRACER_CF_ACCESS_CLIENT_SECRET;
    }
  });
});
