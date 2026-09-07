import { createHash, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db.js";
import { resolveMember } from "../src/auth.js";
import { authReady } from "../src/auth/instance.js";
import { createApp } from "../src/server.js";
import { FakeDriver } from "../src/mediator/fake.js";
import type { MediatorWorker } from "../src/mediator/worker.js";
import { grantMembership, magicLinkSessionCookie, latestMagicLink } from "./helpers/auth.js";

const publicUrl = "http://localhost:3000";
const resource = `${publicUrl}/mcp`;
let db: Db;
let server: Server;
let worker: MediatorWorker;
let baseUrl: string;
let cookie: string;
let userId: string;

beforeEach(async () => {
  process.env.MEMRACER_PUBLIC_URL = publicUrl;
  db = openDb(":memory:");
  const made = createApp(db, {
    driverFor: () => new FakeDriver(),
    workerOpts: { tickMs: 20, jobTimeoutMs: 2_000 },
  });
  worker = made.worker;
  await authReady(db);
  await db.prepare("INSERT INTO projects (id, name, repo) VALUES (?, ?, ?)")
    .run("alpha", "Alpha", "recallnet/alpha");
  cookie = await magicLinkSessionCookie(db, "oauth@test.local", "OAuth User");
  userId = (await db.prepare('SELECT id FROM "user" WHERE email = ?').get<{ id: string }>("oauth@test.local"))!.id;
  await grantMembership(db, userId, { projectId: "alpha", projectName: "Alpha", role: "admin" });
  await new Promise<void>((resolve) => { server = made.app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  worker.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.close();
  delete process.env.MEMRACER_PUBLIC_URL;
});

async function oauthToken(role: "human" | "coder", name: string): Promise<{ accessToken: string; refreshToken: string; seatId: string; clientId: string }> {
  const redirectUri = `http://127.0.0.1/callback/${randomUUID()}`;
  const registered = await fetch(`${baseUrl}/api/auth/mcp/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "test client",
    }),
  });
  expect(registered.status).toBe(201);
  const client = await registered.json() as { client_id: string };
  const verifier = "a".repeat(64);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorize = new URL(`${baseUrl}/api/auth/mcp/authorize`);
  authorize.search = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid profile email offline_access",
    state: "state-1",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource,
  }).toString();
  const authorization = await fetch(authorize, { headers: { cookie }, redirect: "manual" });
  expect(authorization.status).toBe(302);
  const consentUrl = new URL(authorization.headers.get("location")!, publicUrl);
  expect(consentUrl.pathname).toBe("/oauth/consent");
  const consentCode = consentUrl.searchParams.get("consent_code")!;
  const context = await fetch(`${baseUrl}/api/oauth/consent?consent_code=${consentCode}`, { headers: { cookie } });
  expect(await context.json()).toMatchObject({ projects: [{ id: "alpha", name: "Alpha" }] });
  const consent = await fetch(`${baseUrl}/api/oauth/consent`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ accept: true, consentCode, projectId: "alpha", role, name }),
  });
  expect(consent.status).toBe(200);
  const callback = new URL((await consent.json() as { redirectURI: string }).redirectURI);
  const code = callback.searchParams.get("code")!;
  const exchanged = await fetch(`${baseUrl}/api/auth/mcp/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code,
      code_verifier: verifier,
      resource,
    }),
  });
  expect(exchanged.status).toBe(200);
  const tokens = await exchanged.json() as { access_token: string; refresh_token: string };
  const seat = await db.prepare("SELECT id FROM oauth_seats WHERE consent_code = ?")
    .get<{ id: string }>(consentCode);
  return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, seatId: seat!.id, clientId: client.client_id };
}

describe("MCP OAuth seats", () => {
  it("publishes discovery and challenges unauthenticated MCP requests", async () => {
    const metadata = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`);
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({ resource });
    const authorization = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    expect(await authorization.json()).toMatchObject({
      issuer: publicUrl,
      authorization_endpoint: `${publicUrl}/api/auth/mcp/authorize`,
      token_endpoint: `${publicUrl}/api/auth/mcp/token`,
      code_challenge_methods_supported: ["S256"],
    });
    const denied = await fetch(`${baseUrl}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toContain(`resource_metadata="${publicUrl}/.well-known/oauth-protected-resource/mcp"`);
  });

  it("resumes an unauthenticated authorization request after email sign-in", async () => {
    const redirectUri = `http://127.0.0.1/callback/${randomUUID()}`;
    const registered = await fetch(`${baseUrl}/api/auth/mcp/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [redirectUri], token_endpoint_auth_method: "none", client_name: "resume test" }),
    });
    const client = await registered.json() as { client_id: string };
    const authorize = new URL(`${baseUrl}/api/auth/mcp/authorize`);
    authorize.search = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid offline_access",
      code_challenge: createHash("sha256").update("b".repeat(64)).digest("base64url"),
      code_challenge_method: "S256",
      resource,
    }).toString();
    const prompted = await fetch(authorize, { redirect: "manual" });
    expect(prompted.status).toBe(302);
    expect(new URL(prompted.headers.get("location")!, publicUrl).pathname).toBe("/signin");
    const promptCookie = (prompted.headers.getSetCookie?.() ?? [prompted.headers.get("set-cookie") ?? ""])
      .map((value) => value.split(";")[0]).filter(Boolean).join("; ");
    const next = new URL(prompted.headers.get("location")!, publicUrl).searchParams.get("next") || "/oauth/consent";
    const requested = await fetch(`${baseUrl}/api/auth/sign-in/magic-link`, {
      method: "POST",
      headers: { cookie: promptCookie, "content-type": "application/json" },
      body: JSON.stringify({ email: "oauth@test.local", callbackURL: next, newUserCallbackURL: next }),
    });
    expect(requested.status).toBe(200);
    const magic = new URL(latestMagicLink("oauth@test.local"));
    magic.host = new URL(baseUrl).host;
    const signedIn = await fetch(magic, { headers: { cookie: promptCookie }, redirect: "manual" });
    expect(signedIn.status).toBe(302);
    expect(new URL(signedIn.headers.get("location")!, publicUrl).pathname).toBe("/oauth/consent");
  });

  it("runs DCR + S256 consent and resolves one project-pinned named coder seat", async () => {
    const token = await oauthToken("coder", "Build laptop");
    const member = await resolveMember(db, `Bearer ${token.accessToken}`);
    expect(member).toMatchObject({
      name: "OAuth User",
      keyId: token.seatId,
      keyName: "Build laptop",
      memberships: [{ projectId: "alpha", role: "coder" }],
    });
  });

  it("preserves seat identity across refresh and isolates two seats for the same user", async () => {
    const first = await oauthToken("coder", "Terminal A");
    const second = await oauthToken("coder", "Terminal B");
    expect(first.seatId).not.toBe(second.seatId);
    const initialized = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${first.accessToken}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "isolation-test", version: "1" } } }),
    });
    expect(initialized.status).toBe(200);
    const sessionId = initialized.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    const crossed = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${second.accessToken}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-session-id": sessionId!,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(crossed.status).toBe(404);
    const refreshed = await fetch(`${baseUrl}/api/auth/mcp/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: first.clientId,
        refresh_token: first.refreshToken,
        resource,
      }),
    });
    expect(refreshed.status).toBe(200);
    const body = await refreshed.json() as { access_token: string };
    expect(await resolveMember(db, `Bearer ${body.access_token}`)).toMatchObject({ keyId: first.seatId, keyName: "Terminal A" });
    expect(await resolveMember(db, `Bearer ${second.accessToken}`)).toMatchObject({ keyId: second.seatId, keyName: "Terminal B" });
  });

  it("lists, renames, and revokes OAuth seats and then fails closed", async () => {
    const token = await oauthToken("human", "Desktop");
    const listed = await fetch(`${baseUrl}/api/p/alpha/api-keys`, { headers: { cookie } });
    expect(await listed.json()).toMatchObject({ keys: [{ id: token.seatId, name: "Desktop", type: "human", authMethod: "oauth" }] });
    const renamed = await fetch(`${baseUrl}/api/p/alpha/api-keys/${token.seatId}`, {
      method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Desktop 2" }),
    });
    expect(await renamed.json()).toMatchObject({ name: "Desktop 2" });
    expect(await resolveMember(db, `Bearer ${token.accessToken}`)).toMatchObject({ keyName: "Desktop 2" });
    const revoked = await fetch(`${baseUrl}/api/p/alpha/api-keys/${token.seatId}`, { method: "DELETE", headers: { cookie } });
    expect(revoked.status).toBe(200);
    expect(await resolveMember(db, `Bearer ${token.accessToken}`)).toBeNull();
  });

  it("fails closed when an OAuth access token lacks exactly one active seat scope", async () => {
    const token = await oauthToken("coder", "Scoped");
    await db.prepare('UPDATE "oauthAccessToken" SET scopes = ? WHERE "accessToken" = ?')
      .run("openid profile", token.accessToken);
    expect(await resolveMember(db, `Bearer ${token.accessToken}`)).toBeNull();
  });

  it("requires exact resource binding on authorization and token requests", async () => {
    const authorize = await fetch(`${baseUrl}/api/auth/mcp/authorize?resource=${encodeURIComponent(`${publicUrl}/wrong`)}`, { redirect: "manual" });
    expect(authorize.status).toBe(400);
    expect(await authorize.json()).toMatchObject({ error: "invalid_target" });
    const token = await fetch(`${baseUrl}/api/auth/mcp/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", resource: `${publicUrl}/wrong` }),
    });
    expect(token.status).toBe(400);
    expect(await token.json()).toMatchObject({ error: "invalid_target" });
  });
});
