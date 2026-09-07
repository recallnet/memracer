import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, type Db } from "../src/db.js";
import { authReady } from "../src/auth/instance.js";
import { createApp } from "../src/server.js";
import type { MediatorWorker } from "../src/mediator/worker.js";
import { FakeDriver } from "../src/mediator/fake.js";
import { createInstallState, GitHubAppError, readInstallState } from "../src/github-app.js";
import { magicLinkSessionCookie } from "./helpers/auth.js";

const nativeFetch = globalThis.fetch;
let db: Db;
let server: Server;
let worker: MediatorWorker;
let baseUrl: string;
let repositorySelection: "all" | "selected";
let installationId: number;

async function signUp(email: string): Promise<{ cookie: string; userId: string }> {
  const cookie = await magicLinkSessionCookie(db, email, email);
  const session = await nativeFetch(`${baseUrl}/api/session`, { headers: { cookie } });
  return { cookie, userId: ((await session.json()) as { userId: string }).userId };
}

function request(path: string, cookie: string, body?: unknown, method = "POST"): Promise<Response> {
  return nativeFetch(`${baseUrl}${path}`, {
    method,
    redirect: "manual",
    headers: { cookie, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function createOrg(cookie: string, name = "Acme"): Promise<string> {
  const response = await request("/api/orgs", cookie, { name });
  return ((await response.json()) as { id: string }).id;
}

async function linkGitHub(
  userId: string,
  opts: {
    accessToken?: string;
    refreshToken?: string | null;
    /** ISO timestamp; omit for no expiry column (legacy). Pass a past date to force refresh. */
    accessTokenExpiresAt?: string | null;
  } = {},
): Promise<void> {
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO "account"
       (id, "accountId", "providerId", "userId", "accessToken", "refreshToken",
        "accessTokenExpiresAt", "createdAt", "updatedAt")
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    "github-user-42",
    "github",
    userId,
    opts.accessToken ?? "ghu_test",
    opts.refreshToken === undefined ? "ghr_test" : opts.refreshToken,
    opts.accessTokenExpiresAt === undefined ? null : opts.accessTokenExpiresAt,
    now,
    now,
  );
}

function githubResponse(input: string | URL | Request): Response | undefined {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith("https://api.github.com/")) return undefined;
  if (url.includes("/user/installations/77/repositories")) {
    return Response.json({
      total_count: 2,
      repositories: [
        { id: 501, name: "one", full_name: "acme/one", private: true },
        { id: 502, name: "two", full_name: "acme/two", private: false },
      ],
    });
  }
  if (url.includes("/user/installations")) {
    return Response.json({
      installations: [{
        id: installationId,
        repository_selection: repositorySelection,
        account: { id: 9, login: "acme" },
      }],
    });
  }
  return Response.json({ message: "not found" }, { status: 404 });
}

beforeEach(async () => {
  vi.stubEnv("MEMRACER_GITHUB_APP_SLUG", "memracer-test");
  vi.stubEnv("MEMRACER_GITHUB_APP_CLIENT_ID", "client-id");
  vi.stubEnv("MEMRACER_GITHUB_APP_CLIENT_SECRET", "client-secret");
  vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-that-is-long-enough-for-better-auth");
  repositorySelection = "selected";
  installationId = 77;
  db = openDb(":memory:");
  const made = createApp(db, {
    driverFor: () => new FakeDriver(),
    workerOpts: { tickMs: 20, jobTimeoutMs: 2_000 },
  });
  worker = made.worker;
  await authReady(db);
  await new Promise<void>((resolve) => {
    server = made.app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) =>
    githubResponse(input) ?? nativeFetch(input, init));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await worker.stopAndWait(2_000);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.close();
});

describe("GitHub installation state", () => {
  const config = { slug: "memracer-test", stateSecret: "state-secret" };

  it("expires signed state and normalizes external return URLs", () => {
    const createdAt = Date.UTC(2026, 6, 18);
    const state = createInstallState(config, "org-1", "user-1", "https://evil.test", createdAt);

    expect(readInstallState(config, state, createdAt)).toMatchObject({ returnTo: "/dashboard" });
    expect(() => readInstallState(config, state, createdAt + 15 * 60 * 1000 + 1))
      .toThrowError(GitHubAppError);
  });
});

describe("GitHub App Project enrollment", () => {
  it("verifies selected installation ownership and creates a repo-bound Project with creator admin", async () => {
    const owner = await signUp("owner@acme.test");
    const orgId = await createOrg(owner.cookie);
    await linkGitHub(owner.userId);

    const start = await request(`/api/orgs/${orgId}/github/install`, owner.cookie, {});
    expect(start.status).toBe(200);
    const installUrl = new URL(((await start.json()) as { installUrl: string }).installUrl);
    expect(installUrl.origin + installUrl.pathname).toBe("https://github.com/apps/memracer-test/installations/new");

    const callback = await request(
      `/api/github/install/callback?installation_id=77&state=${encodeURIComponent(installUrl.searchParams.get("state")!)}`,
      owner.cookie,
      undefined,
      "GET",
    );
    expect(callback.status).toBe(302);

    const status = await request(`/api/orgs/${orgId}/github`, owner.cookie, undefined, "GET");
    expect(await status.json()).toMatchObject({
      configured: true,
      linked: true,
      installation: { id: "77", accountLogin: "acme", repositorySelection: "selected" },
      repositories: [{ id: "501", fullName: "acme/one" }, { id: "502", fullName: "acme/two" }],
    });
    repositorySelection = "all";
    const refreshed = await request(`/api/orgs/${orgId}/github`, owner.cookie, undefined, "GET");
    expect(await refreshed.json()).toMatchObject({
      installation: { id: "77", accountLogin: "acme", repositorySelection: "all" },
    });
    expect(await db.prepare(
      "SELECT repository_selection FROM github_installations WHERE org_id = ?",
    ).get(orgId)).toEqual({ repository_selection: "all" });
    repositorySelection = "selected";

    const created = await request(`/api/orgs/${orgId}/github/projects`, owner.cookie, {
      name: "One Project",
      repositoryId: "501",
    });
    expect(created.status).toBe(200);
    const project = (await created.json()) as { id: string; repo: string };
    expect(project.repo).toBe("acme/one");
    expect(await db.prepare("SELECT created_by FROM projects WHERE id = ?").get(project.id))
      .toEqual({ created_by: owner.userId });
    expect(await db.prepare(
      'SELECT role FROM "member" WHERE "organizationId" = ? AND "userId" = ?',
    ).get(project.id, owner.userId)).toEqual({ role: "admin" });
    expect(await db.prepare(
      "SELECT installation_id, repository_id, full_name FROM github_project_repos WHERE project_id = ?",
    ).get(project.id)).toEqual({ installation_id: "77", repository_id: "501", full_name: "acme/one" });
    expect(await db.prepare(
      "SELECT repository_selection FROM github_installations WHERE org_id = ?",
    ).get(orgId)).toEqual({ repository_selection: "all" });

    installationId = 88;
    const replacementStart = await request(`/api/orgs/${orgId}/github/install`, owner.cookie, {});
    const replacementState = new URL(
      ((await replacementStart.json()) as { installUrl: string }).installUrl,
    ).searchParams.get("state")!;
    expect((await request(
      `/api/github/install/callback?installation_id=88&state=${encodeURIComponent(replacementState)}`,
      owner.cookie,
      undefined,
      "GET",
    )).status).toBe(409);
  });

  it("accepts blanket installation access while rejecting tampered state, foreign Orgs, and unselected repositories", async () => {
    const owner = await signUp("owner2@acme.test");
    const outsider = await signUp("outsider@acme.test");
    const orgId = await createOrg(owner.cookie, "Secure Org");
    await linkGitHub(owner.userId);
    await linkGitHub(outsider.userId);

    expect((await request(`/api/orgs/${orgId}/github/install`, outsider.cookie, {})).status).toBe(403);
    const start = await request(`/api/orgs/${orgId}/github/install`, owner.cookie, {});
    const state = new URL(((await start.json()) as { installUrl: string }).installUrl).searchParams.get("state")!;
    expect((await request(
      `/api/github/install/callback?installation_id=77&state=${encodeURIComponent(`${state}x`)}`,
      owner.cookie,
      undefined,
      "GET",
    )).status).toBe(400);

    repositorySelection = "all";
    expect((await request(
      `/api/github/install/callback?installation_id=77&state=${encodeURIComponent(state)}`,
      owner.cookie,
      undefined,
      "GET",
    )).status).toBe(302);
    expect(await db.prepare(
      "SELECT repository_selection FROM github_installations WHERE org_id = ?",
    ).get(orgId)).toEqual({ repository_selection: "all" });
    repositorySelection = "selected";
    expect((await request(
      `/api/github/install/callback?installation_id=77&state=${encodeURIComponent(state)}`,
      owner.cookie,
      undefined,
      "GET",
    )).status).toBe(302);
    expect((await request(`/api/orgs/${orgId}/github/projects`, owner.cookie, {
      name: "Not selected",
      repositoryId: "999",
    })).status).toBe(403);
  });

  it("keeps callback and manual creation idempotent/additive", async () => {
    const owner = await signUp("owner3@acme.test");
    const orgId = await createOrg(owner.cookie, "Legacy Org");
    await linkGitHub(owner.userId);
    const start = await request(`/api/orgs/${orgId}/github/install`, owner.cookie, {});
    const state = new URL(((await start.json()) as { installUrl: string }).installUrl).searchParams.get("state")!;
    const callbackPath = `/api/github/install/callback?installation_id=77&state=${encodeURIComponent(state)}`;
    expect((await request(callbackPath, owner.cookie, undefined, "GET")).status).toBe(302);
    expect((await request(callbackPath, owner.cookie, undefined, "GET")).status).toBe(302);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM github_installations WHERE org_id = ?").get(orgId))
      .toEqual({ n: 1 });

    const manual = await request(`/api/orgs/${orgId}/projects`, owner.cookie, {
      name: "Manual Project",
      repo: "manual/repo",
    });
    expect(manual.status).toBe(200);
    const project = (await manual.json()) as { id: string; repo: string };
    expect(project.repo).toBe("manual/repo");
    expect(await db.prepare("SELECT * FROM github_project_repos WHERE project_id = ?").get(project.id))
      .toBeUndefined();
  });

  it("returns structured JSON (not a proxy 502) when GitHub path throws a non-GitHubAppError", async () => {
    const owner = await signUp("boom@acme.test");
    const orgId = await createOrg(owner.cookie);
    await linkGitHub(owner.userId);
    const start = await request(`/api/orgs/${orgId}/github/install`, owner.cookie, {});
    const state = new URL(((await start.json()) as { installUrl: string }).installUrl).searchParams.get("state")!;
    expect((await request(
      `/api/github/install/callback?installation_id=77&state=${encodeURIComponent(state)}`,
      owner.cookie,
      undefined,
      "GET",
    )).status).toBe(302);

    // Force a free-floating Error from the live GitHub call path (e.g. network TypeError).
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://api.github.com/")) {
        throw new TypeError("forced network failure for regression");
      }
      return nativeFetch(input, init);
    });

    const status = await request(`/api/orgs/${orgId}/github`, owner.cookie, undefined, "GET");
    expect(status.status).not.toBe(502);
    expect(status.status).toBeGreaterThanOrEqual(400);
    expect(status.status).toBeLessThan(600);
    const body = (await status.json()) as { error?: string; message?: string };
    expect(typeof body.error).toBe("string");
    expect(body.error!.length).toBeGreaterThan(0);
    expect(String(body.message ?? body.error)).toMatch(/GitHub|forced network failure/i);
  });

  it("returns malformed GitHub payloads as structured JSON errors (not unhandled rejections)", async () => {
    const owner = await signUp("shape@acme.test");
    const orgId = await createOrg(owner.cookie);
    await linkGitHub(owner.userId);
    const start = await request(`/api/orgs/${orgId}/github/install`, owner.cookie, {});
    const state = new URL(((await start.json()) as { installUrl: string }).installUrl).searchParams.get("state")!;
    expect((await request(
      `/api/github/install/callback?installation_id=77&state=${encodeURIComponent(state)}`,
      owner.cookie,
      undefined,
      "GET",
    )).status).toBe(302);

    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/user/installations") && !url.includes("/repositories")) {
        // Missing installations array — previously threw TypeError → proxy 502.
        return Response.json({ total_count: 0 });
      }
      return githubResponse(input) ?? nativeFetch(input, init);
    });

    const status = await request(`/api/orgs/${orgId}/github`, owner.cookie, undefined, "GET");
    expect(status.status).not.toBe(502);
    expect(status.status).toBeGreaterThanOrEqual(400);
    const body = (await status.json()) as { error?: string; message?: string };
    expect(typeof body.error).toBe("string");
    expect(String(body.message ?? body.error)).toMatch(/installations/i);
  });

  it("refreshes an expired user OAuth token before calling GitHub (no Bad credentials)", async () => {
    const owner = await signUp("expired@acme.test");
    const orgId = await createOrg(owner.cookie);
    const past = new Date(Date.now() - 2 * 24 * 3600_000).toISOString();
    await linkGitHub(owner.userId, {
      accessToken: "ghu_expired",
      refreshToken: "ghr_valid",
      accessTokenExpiresAt: past,
    });

    repositorySelection = "all";
    // Install row present so the route reaches the token-using path.
    await db.prepare(
      `INSERT INTO github_installations
         (installation_id, org_id, account_id, account_login, connected_by, repository_selection, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("77", orgId, "9", "acme", owner.userId, "all", Date.now(), Date.now());

    let sawRefresh = false;
    let sawApiWithNewToken = false;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === "https://github.com/login/oauth/access_token") {
        sawRefresh = true;
        const body = String(init?.body ?? "");
        expect(body).toContain("refresh_token=ghr_valid");
        return Response.json({
          access_token: "ghu_refreshed",
          refresh_token: "ghr_rotated",
          expires_in: 28_800,
          refresh_token_expires_in: 15_552_000,
        });
      }
      if (url.startsWith("https://api.github.com/")) {
        const headerAuth = (() => {
          if (!init?.headers) return "";
          if (init.headers instanceof Headers) return init.headers.get("Authorization") ?? "";
          if (Array.isArray(init.headers)) {
            const hit = init.headers.find(([k]) => k.toLowerCase() === "authorization");
            return hit?.[1] ?? "";
          }
          const rec = init.headers as Record<string, string>;
          return rec.Authorization ?? rec.authorization ?? "";
        })();
        expect(headerAuth).toBe("Bearer ghu_refreshed");
        expect(headerAuth).not.toContain("ghu_expired");
        sawApiWithNewToken = true;
        return githubResponse(input) ?? Response.json({ message: "not found" }, { status: 404 });
      }
      return nativeFetch(input, init);
    });

    const status = await request(`/api/orgs/${orgId}/github`, owner.cookie, undefined, "GET");
    expect(status.status).toBe(200);
    expect(sawRefresh).toBe(true);
    expect(sawApiWithNewToken).toBe(true);
    expect(await status.json()).toMatchObject({
      configured: true,
      linked: true,
      installation: { id: "77", accountLogin: "acme", repositorySelection: "all" },
    });
    const row = await db.prepare(
      `SELECT "accessToken", "refreshToken", "accessTokenExpiresAt" FROM "account" WHERE "userId" = ? AND "providerId" = ?`,
    ).get<{ accessToken: string; refreshToken: string; accessTokenExpiresAt: string }>(owner.userId, "github");
    expect(row?.accessToken).toBe("ghu_refreshed");
    expect(row?.refreshToken).toBe("ghr_rotated");
    expect(new Date(row!.accessTokenExpiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("returns reauth shape (not 401) when refresh fails and shows linked=false", async () => {
    const owner = await signUp("reauth@acme.test");
    const orgId = await createOrg(owner.cookie);
    const past = new Date(Date.now() - 3600_000).toISOString();
    await linkGitHub(owner.userId, {
      accessToken: "ghu_dead",
      refreshToken: "ghr_dead",
      accessTokenExpiresAt: past,
    });
    await db.prepare(
      `INSERT INTO github_installations
         (installation_id, org_id, account_id, account_login, connected_by, repository_selection, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("77", orgId, "9", "acme", owner.userId, "selected", Date.now(), Date.now());

    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === "https://github.com/login/oauth/access_token") {
        return Response.json({ error: "bad_refresh_token" });
      }
      if (url.startsWith("https://api.github.com/")) {
        return Response.json({ message: "Bad credentials" }, { status: 401 });
      }
      return nativeFetch(input, init);
    });

    const status = await request(`/api/orgs/${orgId}/github`, owner.cookie, undefined, "GET");
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      configured: true,
      linked: false,
      reauthRequired: true,
      installation: { id: "77", accountLogin: "acme", repositorySelection: "selected" },
      repositories: [],
    });
  });

  it("retries once after a GitHub 401 by force-refreshing the user token", async () => {
    const owner = await signUp("retry401@acme.test");
    const orgId = await createOrg(owner.cookie);
    // Not expired yet — first call uses stored token; GitHub 401 triggers force refresh.
    await linkGitHub(owner.userId, {
      accessToken: "ghu_stale",
      refreshToken: "ghr_ok",
      accessTokenExpiresAt: new Date(Date.now() + 4 * 3600_000).toISOString(),
    });
    await db.prepare(
      `INSERT INTO github_installations
         (installation_id, org_id, account_id, account_login, connected_by, repository_selection, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("77", orgId, "9", "acme", owner.userId, "selected", Date.now(), Date.now());

    let apiHits = 0;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === "https://github.com/login/oauth/access_token") {
        return Response.json({
          access_token: "ghu_after_401",
          refresh_token: "ghr_after_401",
          expires_in: 28_800,
        });
      }
      if (url.startsWith("https://api.github.com/")) {
        apiHits += 1;
        const headerAuth = (() => {
          if (!init?.headers) return "";
          if (init.headers instanceof Headers) return init.headers.get("Authorization") ?? "";
          const rec = init.headers as Record<string, string>;
          return rec.Authorization ?? rec.authorization ?? "";
        })();
        if (headerAuth.includes("ghu_stale")) {
          return Response.json({ message: "Bad credentials" }, { status: 401 });
        }
        if (headerAuth.includes("ghu_after_401")) {
          return githubResponse(input) ?? Response.json({ message: "not found" }, { status: 404 });
        }
        return Response.json({ message: "unexpected token" }, { status: 401 });
      }
      return nativeFetch(input, init);
    });

    const status = await request(`/api/orgs/${orgId}/github`, owner.cookie, undefined, "GET");
    expect(status.status).toBe(200);
    expect(apiHits).toBeGreaterThanOrEqual(2);
    expect(await status.json()).toMatchObject({
      configured: true,
      linked: true,
      installation: { id: "77", accountLogin: "acme" },
    });
  });
});
