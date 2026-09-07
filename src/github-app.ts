import { createHmac, createSign, timingSafeEqual } from "node:crypto";
import type { Db } from "./db.js";

const GITHUB_API = "https://api.github.com";
const STATE_TTL_MS = 15 * 60 * 1000;
/** Installation tokens last ~1h; refresh 2 minutes early. */
const INSTALL_TOKEN_SKEW_MS = 2 * 60_000;

export interface GitHubAppConfig {
  slug: string;
  stateSecret: string;
}

export interface GitHubInstallation {
  id: string;
  accountId: string;
  accountLogin: string;
  repositorySelection: "selected" | "all";
}

export interface GitHubRepository {
  id: string;
  name: string;
  fullName: string;
  private: boolean;
}

interface InstallState {
  orgId: string;
  userId: string;
  expiresAt: number;
  returnTo: string;
}

export class GitHubAppError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "GitHubAppError";
  }
}

export function githubAppConfig(env: NodeJS.ProcessEnv = process.env): GitHubAppConfig | null {
  const slug = env.MEMRACER_GITHUB_APP_SLUG?.trim();
  const clientId = env.MEMRACER_GITHUB_APP_CLIENT_ID?.trim();
  const clientSecret = env.MEMRACER_GITHUB_APP_CLIENT_SECRET?.trim();
  if (!slug || !clientId || !clientSecret) return null;
  return {
    slug,
    stateSecret: env.BETTER_AUTH_SECRET || "memracer-dev-better-auth-secret-0123456789-abcdef",
  };
}

function signature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createInstallState(
  config: GitHubAppConfig,
  orgId: string,
  userId: string,
  returnTo = "/dashboard",
  now = Date.now(),
): string {
  const safeReturnTo = returnTo.startsWith("/dashboard") && !returnTo.startsWith("//")
    ? returnTo
    : "/dashboard";
  const payload = Buffer.from(JSON.stringify({
    orgId,
    userId,
    returnTo: safeReturnTo,
    expiresAt: now + STATE_TTL_MS,
  })).toString("base64url");
  return `${payload}.${signature(payload, config.stateSecret)}`;
}

export function readInstallState(config: GitHubAppConfig, value: string, now = Date.now()): InstallState {
  const [payload, supplied, extra] = value.split(".");
  if (!payload || !supplied || extra) throw new GitHubAppError(400, "invalid GitHub installation state");
  const expected = signature(payload, config.stateSecret);
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  if (suppliedBytes.length !== expectedBytes.length || !timingSafeEqual(suppliedBytes, expectedBytes)) {
    throw new GitHubAppError(400, "invalid GitHub installation state");
  }
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<InstallState>;
    if (
      typeof parsed.orgId !== "string" || !parsed.orgId ||
      typeof parsed.userId !== "string" || !parsed.userId ||
      typeof parsed.returnTo !== "string" || !parsed.returnTo.startsWith("/dashboard") || parsed.returnTo.startsWith("//") ||
      typeof parsed.expiresAt !== "number" || parsed.expiresAt < now
    ) {
      throw new Error("invalid state fields");
    }
    return parsed as InstallState;
  } catch {
    throw new GitHubAppError(400, "invalid or expired GitHub installation state");
  }
}

export function installationUrl(config: GitHubAppConfig, state: string): string {
  return `https://github.com/apps/${encodeURIComponent(config.slug)}/installations/new?state=${encodeURIComponent(state)}`;
}

/** User-OAuth GitHub calls share the stable API version used by installation-token mint. */
const GITHUB_API_VERSION = "2022-11-28";

async function githubJson<T>(token: string, path: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${GITHUB_API}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        "User-Agent": "memracer",
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new GitHubAppError(503, `GitHub API unreachable: ${detail.slice(0, 200)}`);
  }
  if (!response.ok) {
    let detail = "";
    try {
      detail = await response.text();
    } catch {
      detail = "";
    }
    // Map upstream 4xx/5xx; avoid free-floating TypeError from body parse.
    const status = response.status >= 400 && response.status < 600 ? response.status : 502;
    throw new GitHubAppError(
      status === 502 ? 503 : status,
      `GitHub API ${response.status}: ${detail.slice(0, 200) || "request failed"}`,
    );
  }
  try {
    return (await response.json()) as T;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new GitHubAppError(503, `GitHub API returned invalid JSON: ${detail.slice(0, 200)}`);
  }
}

export async function verifyInstallation(token: string, installationId: string): Promise<GitHubInstallation> {
  if (!/^\d+$/.test(installationId)) throw new GitHubAppError(400, "invalid GitHub installation id");
  type InstallationRow = {
    id: number;
    repository_selection: "all" | "selected";
    account: { id: number; login: string } | null;
  };
  for (let page = 1; ; page += 1) {
    const rows = await githubJson<{ installations?: InstallationRow[] | null }>(
      token,
      `/user/installations?per_page=100&page=${page}`,
    );
    const installations = Array.isArray(rows.installations) ? rows.installations : null;
    if (!installations) {
      throw new GitHubAppError(503, "GitHub installations response missing installations array");
    }
    const found = installations.find((row) => String(row.id) === installationId);
    if (found) {
      if (found.repository_selection !== "selected" && found.repository_selection !== "all") {
        throw new GitHubAppError(503, "GitHub installation has an unsupported repository selection");
      }
      if (!found.account || !found.account.login) {
        throw new GitHubAppError(503, "GitHub installation has no account");
      }
      return {
        id: String(found.id),
        accountId: String(found.account.id),
        accountLogin: found.account.login,
        repositorySelection: found.repository_selection,
      };
    }
    if (installations.length < 100) break;
  }
  throw new GitHubAppError(403, "GitHub installation is not accessible to this user");
}

/**
 * Refresh a GitHub App user-to-server OAuth token.
 *
 * better-auth's getAccessToken path can return a stale access token when the
 * refresh response lacks a usable access_token (updatedAt bumps, expiresAt
 * stays put). Call this explicitly, require access_token, and always write a
 * concrete accessTokenExpiresAt (default 8h when GitHub omits expires_in).
 *
 * Returns null on network/OAuth failure — never a half-applied token.
 */
export async function refreshGitHubUserAccessToken(
  refreshToken: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt: Date | null;
} | null> {
  const clientId = env.MEMRACER_GITHUB_APP_CLIENT_ID?.trim();
  const clientSecret = env.MEMRACER_GITHUB_APP_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret || !refreshToken.trim()) return null;

  let response: Response;
  try {
    response = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "memracer",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;

  let data: {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    refresh_token_expires_in?: unknown;
    error?: unknown;
  };
  try {
    data = (await response.json()) as typeof data;
  } catch {
    return null;
  }
  if (data.error || typeof data.access_token !== "string" || !data.access_token) return null;

  const now = Date.now();
  // GitHub App user access tokens last 8 hours when expires_in is present.
  const expiresInSec =
    typeof data.expires_in === "number" && data.expires_in > 0 ? data.expires_in : 8 * 3600;
  const refreshExpiresInSec =
    typeof data.refresh_token_expires_in === "number" && data.refresh_token_expires_in > 0
      ? data.refresh_token_expires_in
      : null;
  return {
    accessToken: data.access_token,
    refreshToken:
      typeof data.refresh_token === "string" && data.refresh_token
        ? data.refresh_token
        : refreshToken,
    accessTokenExpiresAt: new Date(now + expiresInSec * 1000),
    refreshTokenExpiresAt:
      refreshExpiresInSec == null ? null : new Date(now + refreshExpiresInSec * 1000),
  };
}

export async function listInstallationRepositories(
  token: string,
  installationId: string,
): Promise<GitHubRepository[]> {
  type RepositoryRow = { id: number; name: string; full_name: string; private: boolean };
  const repositories: GitHubRepository[] = [];
  for (let page = 1; ; page += 1) {
    const result = await githubJson<{ total_count?: number; repositories?: RepositoryRow[] | null }>(
      token,
      `/user/installations/${installationId}/repositories?per_page=100&page=${page}`,
    );
    const pageRepos = Array.isArray(result.repositories) ? result.repositories : null;
    if (!pageRepos) {
      throw new GitHubAppError(503, "GitHub repositories response missing repositories array");
    }
    repositories.push(...pageRepos.map((repository) => ({
      id: String(repository.id),
      name: repository.name,
      fullName: repository.full_name,
      private: repository.private,
    })));
    const total = typeof result.total_count === "number" ? result.total_count : repositories.length;
    if (repositories.length >= total || pageRepos.length < 100) break;
  }
  return repositories.sort((a, b) => a.fullName.localeCompare(b.fullName));
}

// ── App JWT + installation access tokens (server-to-server PR verification) ──

export interface GitHubAppAuthConfig {
  appId: string;
  privateKeyPem: string;
}

/** App ID + private key for minting installation tokens (PR verify). Separate from OAuth client credentials. */
export function githubAppAuthConfig(env: NodeJS.ProcessEnv = process.env): GitHubAppAuthConfig | null {
  const appId = env.MEMRACER_GITHUB_APP_ID?.trim();
  const rawKey = env.MEMRACER_GITHUB_APP_PRIVATE_KEY?.trim();
  if (!appId || !rawKey) return null;
  const privateKeyPem = rawKey.includes("\\n") ? rawKey.replace(/\\n/g, "\n") : rawKey;
  return { appId, privateKeyPem };
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** GitHub App JWT (RS256), valid ~9 minutes. `iss` is the numeric App ID. */
export function mintAppJwt(config: GitHubAppAuthConfig, nowSec = Math.floor(Date.now() / 1000)): string {
  const header = base64urlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64urlJson({
    iat: nowSec - 60,
    exp: nowSec + 9 * 60,
    iss: config.appId,
  });
  const data = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(data);
  signer.end();
  const signature = signer.sign(config.privateKeyPem, "base64url");
  return `${data}.${signature}`;
}

export type InstallationTokenFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<{ status: number; json(): Promise<unknown>; text(): Promise<string> }>;

/**
 * Mint a short-lived installation access token.
 * POST /app/installations/{id}/access_tokens with an App JWT.
 */
export async function mintInstallationAccessToken(
  config: GitHubAppAuthConfig,
  installationId: string,
  fetchImpl: InstallationTokenFetch = fetch as unknown as InstallationTokenFetch,
): Promise<{ token: string; expiresAt: number }> {
  if (!/^\d+$/.test(installationId)) {
    throw new GitHubAppError(400, "invalid GitHub installation id");
  }
  const jwt = mintAppJwt(config);
  const response = await fetchImpl(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${jwt}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "memracer",
    },
  });
  if (response.status !== 201 && response.status !== 200) {
    const detail = await response.text();
    throw new GitHubAppError(
      502,
      `GitHub installation token ${response.status}: ${detail.slice(0, 200) || "request failed"}`,
    );
  }
  const body = (await response.json()) as { token?: string; expires_at?: string };
  if (!body.token) throw new GitHubAppError(502, "GitHub installation token response missing token");
  const expiresAt = body.expires_at ? Date.parse(body.expires_at) : Date.now() + 55 * 60_000;
  return { token: body.token, expiresAt };
}

/** Resolve which App installation covers an owner/repo (enrolled project repos). */
export async function lookupInstallationIdForRepo(db: Db, ownerRepo: string): Promise<string | null> {
  const fullName = ownerRepo.trim();
  if (!fullName) return null;
  const row = await db
    .prepare(
      `SELECT installation_id FROM github_project_repos
        WHERE lower(full_name) = lower(?)
        LIMIT 1`,
    )
    .get<{ installation_id: string }>(fullName);
  return row?.installation_id ?? null;
}

/**
 * Caches installation tokens by installation id and resolves them for a repo.
 * Used by GhTokenSource ahead of PAT/gh fallback.
 */
export class InstallationTokenProvider {
  private readonly cache = new Map<string, { token: string; expiresAt: number }>();

  constructor(
    private readonly config: GitHubAppAuthConfig,
    private readonly lookupInstallation: (repo: string) => Promise<string | null>,
    private readonly fetchImpl: InstallationTokenFetch = fetch as unknown as InstallationTokenFetch,
  ) {}

  async tokenForRepo(repo: string): Promise<string | null> {
    const installationId = await this.lookupInstallation(repo);
    if (!installationId) return null;
    const cached = this.cache.get(installationId);
    if (cached && cached.expiresAt - INSTALL_TOKEN_SKEW_MS > Date.now()) {
      return cached.token;
    }
    const minted = await mintInstallationAccessToken(this.config, installationId, this.fetchImpl);
    this.cache.set(installationId, minted);
    return minted.token;
  }

  invalidate(): void {
    this.cache.clear();
  }
}
