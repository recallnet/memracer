import type { IncomingHttpHeaders } from "node:http";
import { fromNodeHeaders } from "better-auth/node";
import type { Db } from "./db.js";
import { authFor } from "./auth/instance.js";
import { roleKind } from "./roles.js";

export type Role = "human" | "coder" | "admin";

/**
 * The subset of better-auth's plugin API this seam calls. The instance is built
 * over the widened BetterAuthOptions type, which erases the apiKey/session
 * endpoint types from `auth.api`, so we assert this narrow surface at the call
 * sites (the shapes are pinned by tests/better-auth-phase2.test.ts).
 */
interface AuthApiSurface {
  getMcpSession(args: {
    headers: Headers;
  }): Promise<{
    userId?: string | null;
    scopes?: string | null;
  } | null>;
  verifyApiKey(args: {
    body: { key: string };
  }): Promise<{
    valid?: boolean;
    key?: {
      id?: string;
      name?: string;
      userId?: string;
      referenceId?: string;
      metadata?: Record<string, unknown> | null;
    } | null;
  }>;
  getSession(args: {
    headers: Headers;
  }): Promise<{
    user?: { id: string; name?: string; email?: string };
    session?: { token?: string };
  } | null>;
}

export interface Membership {
  projectId: string;
  projectName: string;
  repo: string | null;
  role: Role;
  /** The team (org) the project belongs to — the switcher groups on this. */
  orgId: string | null;
  orgName: string | null;
}

export interface Member {
  /** The credential the caller presented — a better-auth API key. */
  token: string;
  name: string;
  memberships: Membership[];
  /** The owning better-auth user id. Set for API-key/operator members. */
  userId?: string;
  /** API-key identity for lease ownership; absent for browser-session members. */
  keyId?: string;
  /** Human-readable API-key seat name, distinct from the owning user name. */
  keyName?: string;
}

/**
 * Resolve a Bearer credential to a Member. better-auth is the ONLY auth: the
 * credential is verified as a better-auth API key (the headless coder/MCP
 * credential minted in the dashboard). Human browser sessions come in through
 * resolveSession instead. Disabled backends (PGlite tests) register no handle,
 * so this returns null there.
 */
export async function resolveMember(
  db: Db,
  authorizationHeader: string | undefined,
  attribution?: { sourceIp?: string },
): Promise<Member | null> {
  if (!authorizationHeader?.startsWith("Bearer ")) return null;
  const token = authorizationHeader.slice("Bearer ".length).trim();
  const oauth = await resolveOAuthMember(db, token);
  if (oauth !== undefined) return oauth;
  return resolveApiKeyMember(db, token, attribution);
}

export const OAUTH_SEAT_SCOPE_PREFIX = "memracer_seat:";

async function resolveOAuthMember(db: Db, token: string): Promise<Member | null | undefined> {
  const handle = authFor(db);
  if (!handle) return undefined;
  await handle.ready;
  let session: Awaited<ReturnType<AuthApiSurface["getMcpSession"]>>;
  try {
    session = await (handle.auth.api as unknown as AuthApiSurface).getMcpSession({
      headers: new Headers({ authorization: `Bearer ${token}` }),
    });
  } catch {
    return undefined;
  }
  if (!session) return undefined;
  if (!session.userId) return null;
  const seatIds = (session.scopes ?? "")
    .split(/\s+/)
    .filter((scope) => scope.startsWith(OAUTH_SEAT_SCOPE_PREFIX))
    .map((scope) => scope.slice(OAUTH_SEAT_SCOPE_PREFIX.length))
    .filter(Boolean);
  if (seatIds.length !== 1) return null;
  const seat = await db.prepare(
    `SELECT id, user_id, project_id, role, name
       FROM oauth_seats
      WHERE id = ? AND revoked_at IS NULL`,
  ).get<{ id: string; user_id: string; project_id: string; role: "human" | "coder"; name: string }>(seatIds[0]);
  if (!seat || seat.user_id !== session.userId) return null;
  const membership = (await membershipsForUser(db, session.userId))
    .find((item) => item.projectId === seat.project_id);
  if (!membership) return null;
  const user = await db.prepare('SELECT name FROM "user" WHERE id = ?')
    .get<{ name: string }>(session.userId);
  await db.prepare("UPDATE oauth_seats SET last_used_at = ?, updated_at = ? WHERE id = ?")
    .run(Date.now(), Date.now(), seat.id);
  return {
    token,
    name: user?.name ?? session.userId,
    memberships: [{ ...membership, role: seat.role }],
    keyId: seat.id,
    keyName: seat.name,
  };
}

export function requestSourceIp(headers: IncomingHttpHeaders, remoteAddress?: string): string {
  const cloudflare = headers["cf-connecting-ip"];
  const cloudflareIp = (Array.isArray(cloudflare) ? cloudflare[0] : cloudflare)?.trim();
  if (cloudflareIp) return cloudflareIp;
  const forwarded = headers["x-forwarded-for"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  return first || remoteAddress || "unknown";
}

function logApiKeyFailure(token: string, sourceIp: string | undefined, reason: string): void {
  console.error(`[auth-api-key-failure] ${JSON.stringify({
    source_ip: sourceIp || "unknown",
    key_prefix: `${token.slice(0, 4)}…`,
    reason,
  })}`);
}

/** Membership rows for a better-auth user — member(userId, organizationId, role)
 *  joined to projects (organizationId ↔ projects.id, set by the backfill). */
async function membershipsForUser(db: Db, userId: string): Promise<Membership[]> {
  const rows = await db
    .prepare(
      `SELECT m."organizationId" AS project_id, p.name AS project_name, p.repo, m.role,
              o.id AS org_id, o.name AS org_name
       FROM member m JOIN projects p ON p.id = m."organizationId"
       LEFT JOIN orgs o ON o.id = p.org_id
       WHERE m."userId" = ?
         AND p.archived_at IS NULL
         AND (o.id IS NULL OR o.archived_at IS NULL)
       ORDER BY m."organizationId"`,
    )
    .all<{
      project_id: string;
      project_name: string;
      repo: string | null;
      role: Role;
      org_id: string | null;
      org_name: string | null;
    }>(userId);
  return rows.map((m) => ({
    projectId: m.project_id,
    projectName: m.project_name,
    repo: m.repo,
    role: m.role,
    orgId: m.org_id,
    orgName: m.org_name,
  }));
}

/**
 * Organization access is derived from durable ownership or membership in any
 * project inside the organization. There is deliberately no separate org
 * membership table: project memberships remain the source of roster truth.
 */
export async function isOrgMember(db: Db, userId: string, orgId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS allowed
       FROM orgs o
       WHERE o.id = ?
         AND o.archived_at IS NULL
         AND (
           o.created_by = ?
           OR EXISTS (
             SELECT 1
             FROM projects p
             JOIN "member" m ON m."organizationId" = p.id
             WHERE p.org_id = o.id AND m."userId" = ? AND p.archived_at IS NULL
           )
         )`,
    )
    .get<{ allowed: number }>(orgId, userId, userId);
  return !!row;
}

/**
 * Decode the canonical project scope from better-auth API-key metadata.
 * Historical rows may contain JSON encoded twice; an omitted scope is the
 * legacy spelling of project scope, while any explicit non-project scope is
 * reserved and must fail closed.
 */
export function apiKeyProjectId(metadata: unknown): string | null {
  let decoded = metadata;
  for (let depth = 0; depth < 2 && typeof decoded === "string"; depth++) {
    try {
      decoded = JSON.parse(decoded) as unknown;
    } catch {
      return null;
    }
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
  const record = decoded as Record<string, unknown>;
  if (record.scope !== undefined && record.scope !== "project") return null;
  if (typeof record.projectId !== "string" || !record.projectId.trim()) return null;
  return record.projectId;
}

async function resolveApiKeyMember(
  db: Db,
  token: string,
  attribution?: { sourceIp?: string },
): Promise<Member | null> {
  const handle = authFor(db);
  if (!handle) return null;
  await handle.ready;
  let userId: string | undefined;
  let keyId: string | undefined;
  let keyName: string | undefined;
  let projectId: string | null = null;
  let credentialRole: "human" | "coder" | null = null;
  try {
    const api = handle.auth.api as unknown as AuthApiSurface;
    const res = await api.verifyApiKey({ body: { key: token } });
    if (!res?.valid || !res.key) {
      logApiKeyFailure(token, attribution?.sourceIp, "invalid_key");
      return null;
    }
    keyId = res.key.id;
    keyName = res.key.name;
    userId = res.key.userId ?? res.key.referenceId;
    projectId = apiKeyProjectId(res.key.metadata);
    const metadata = decodeApiKeyMetadata(res.key.metadata);
    // The key's role SLUG (any project role — human, coder, or a custom role
    // like reviewer) resolves to a tool-surface KIND. human-kind → the human
    // tools; every worker-kind role reuses the coder surface. This is the only
    // gate that lets custom roles work without touching tools.ts. An absent
    // slug falls through to the membership role below.
    const slug = typeof metadata?.type === "string" ? metadata.type : null;
    // An identity-wide OPERATOR key (minted by `memracer login`) carries no
    // projectId — it authenticates the user across every project they belong
    // to. This is the explicit new branch the note below anticipated: it must
    // never emerge as the fallback for missing project metadata.
    if (slug === "operator") {
      if (!userId) {
        logApiKeyFailure(token, attribution?.sourceIp, "invalid_scope");
        return null;
      }
      const memberships = await membershipsForUser(db, userId);
      const operator = await db
        .prepare('SELECT name FROM "user" WHERE id = ?')
        .get<{ name: string }>(userId);
      return { token, name: operator?.name ?? userId, memberships, userId, keyId, keyName };
    }
    if (slug && projectId) {
      const kind = await roleKind(db, projectId, slug);
      credentialRole = kind === "human" ? "human" : "coder";
    }
  } catch {
    logApiKeyFailure(token, attribution?.sourceIp, "verification_error");
    return null; // malformed / unknown key — not an API key we issued
  }
  if (!userId || !projectId) {
    logApiKeyFailure(token, attribution?.sourceIp, "invalid_scope");
    return null;
  }
  // A future identity-wide key must be an explicit new branch here; it must
  // never emerge as the fallback for missing project metadata.
  const membership = (await membershipsForUser(db, userId)).find((m) => m.projectId === projectId);
  if (!membership) {
    logApiKeyFailure(token, attribution?.sourceIp, "membership_missing");
    return null;
  }
  const user = await db
    .prepare('SELECT name FROM "user" WHERE id = ?')
    .get<{ name: string }>(userId);
  return {
    token,
    name: user?.name ?? userId,
    memberships: [{ ...membership, role: credentialRole ?? membership.role }],
    userId,
    keyId,
    keyName,
  };
}

function decodeApiKeyMetadata(metadata: unknown): Record<string, unknown> | null {
  let decoded = metadata;
  for (let depth = 0; depth < 2 && typeof decoded === "string"; depth++) {
    try { decoded = JSON.parse(decoded) as unknown; } catch { return null; }
  }
  return decoded && typeof decoded === "object" && !Array.isArray(decoded)
    ? decoded as Record<string, unknown>
    : null;
}

/**
 * Resolve a human's better-auth SESSION (cookie) to a Member. The header-only
 * resolveMember signature cannot carry a cookie, so the dashboard calls this
 * sibling for browser sessions (the one delta the design doc's "no downstream
 * change" claim missed). Returns null when better-auth is disabled or no valid
 * session cookie is present.
 */
export async function resolveSession(
  db: Db,
  headers: IncomingHttpHeaders,
): Promise<Member | null> {
  const handle = authFor(db);
  if (!handle) return null;
  await handle.ready;
  const api = handle.auth.api as unknown as AuthApiSurface;
  const session = await api.getSession({ headers: fromNodeHeaders(headers) });
  if (!session?.user) return null;
  const memberships = await membershipsForUser(db, session.user.id);
  if (memberships.length === 0) return null;
  return {
    token: session.session?.token ?? session.user.id,
    name: session.user.name ?? session.user.id,
    memberships,
    userId: session.user.id,
  };
}

export interface SessionUser {
  userId: string;
  name: string;
  email: string | null;
}

/**
 * Resolve a better-auth SESSION to its user REGARDLESS of membership. Onboarding
 * needs this: a brand-new sign-up has a valid session but zero memberships, so
 * resolveSession (which requires a membership to build a Member) returns null
 * and would bounce the fresh user to the gate — the "blank shell" root cause.
 * Returns null only when better-auth is disabled or no valid session is present.
 */
export async function resolveSessionUser(
  db: Db,
  headers: IncomingHttpHeaders,
): Promise<SessionUser | null> {
  const handle = authFor(db);
  if (!handle) return null;
  await handle.ready;
  const api = handle.auth.api as unknown as AuthApiSurface;
  const session = await api.getSession({ headers: fromNodeHeaders(headers) });
  if (!session?.user) return null;
  return {
    userId: session.user.id,
    name: session.user.name ?? session.user.id,
    email: session.user.email ?? null,
  };
}
