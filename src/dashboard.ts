import express from "express";
import type { Request, Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import { registerSeatEnrollment } from "./seat-enrollment.js";
import { registerCliAuth } from "./cli-auth.js";
import { seedDefaultRoles, roleKind, listRoles } from "./roles.js";
import { resolvePublicUrl } from "./public-hosts.js";
import {
  resolveMember,
  requestSourceIp,
  resolveSession,
  resolveSessionUser,
  isOrgMember,
  type Member,
  type Membership,
  type Role,
} from "./auth.js";
import { authFor } from "./auth/instance.js";
import type { Queue } from "./queue.js";
import type { MediatorWorker } from "./mediator/worker.js";
import { ProjectKnowledgeState, type ProjectKnowledgeDomain } from "./mediator/project-knowledge.js";
import { ConversationStore } from "./conversations.js";
import { AttentionAlertService } from "./attention-alerts.js";
import { listHumanAttention, publicAttemptNote } from "./human-attention.js";
import {
  pushStatusForUser,
  revokePushSubscription,
  upsertPushSubscription,
  vapidConfigured,
  vapidPublicKey,
} from "./web-push.js";
import { resolveLinks, resolveMarkdownLinkTargets, type LinkableDoc } from "./mediator/okf-links.js";
import {
  restoreOrg,
  restoreProject,
  softArchiveOrg,
  softArchiveProject,
} from "./project-archive.js";
import { allocateSlug } from "./slug.js";
import { referenceSchema, type Reference } from "./mediator/schemas.js";
import { presentTaskBriefActors, projectActorLabel, projectActorLabels } from "./present-task-brief.js";
import { IMAGE_MIME_TYPES, type ImageAttachmentService } from "./image-attachments.js";
import { groupReplayCrossings, projectReplayCrossings } from "./dashboard/replay-crossings.js";
import { loadProjectAnalytics, type AnalyticsPeriod } from "./dashboard/analytics.js";
import {
  GitHubAppError,
  createInstallState,
  githubAppConfig,
  installationUrl,
  listInstallationRepositories,
  readInstallState,
  refreshGitHubUserAccessToken,
  verifyInstallation,
  type GitHubRepository,
} from "./github-app.js";
import { WAITLIST_LIMITER } from "./rate-limit.js";
import {
  PROVIDER_CATALOG,
  PROVIDER_IDS,
  isProviderId,
  resolveModels,
  type ModelMode,
  type ProviderId,
} from "./provider-catalog.js";
import { encryptSecret } from "./secrets.js";

export const DEFAULT_SSE_KEEPALIVE_MS = 25_000;

/** Join links live for a week — long enough to reach a teammate, short enough to expire. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const OVERVIEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 200;

type CursorValues = Record<string, string | number>;

function pageLimit(req: Request): number {
  if (typeof req.query.limit !== "string") return DEFAULT_PAGE_LIMIT;
  const parsed = Number(req.query.limit);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return DEFAULT_PAGE_LIMIT;
  return Math.min(parsed, MAX_PAGE_LIMIT);
}

function pageOffset(req: Request): number {
  if (typeof req.query.offset !== "string") return 0;
  const parsed = Number(req.query.offset);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function literalLikePattern(value: string): string {
  return `%${value.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`;
}

export async function completedTasksPage(
  db: Db,
  projectId: string,
  query: string,
  limit: number,
  offset: number,
): Promise<{ tasks: Record<string, unknown>[]; offset: number; limit: number; next_offset: number | null }> {
  const textPattern = literalLikePattern(query);
  const idQuery = /^#\d+$/.test(query) ? query.slice(1) : query;
  const idPattern = literalLikePattern(idQuery);
  const rows = await db.prepare(
    `SELECT t.id, t.title, t.state, t.submitted_by, t.updated_at,
            t.result_pr_url, t.result_pr_number, t.pr_verification
       FROM tasks t
      WHERE t.project_id = ? AND t.state = 'DONE'
        AND (? = '' OR LOWER(t.title) LIKE ? ESCAPE '\\'
                     OR CAST(t.id AS TEXT) LIKE ? ESCAPE '\\'
                     OR LOWER(t.submitted_by) LIKE ? ESCAPE '\\')
      ORDER BY t.updated_at DESC, t.id DESC
      LIMIT ? OFFSET ?`,
  ).all<Record<string, unknown>>(
    projectId,
    query,
    textPattern,
    idPattern,
    textPattern,
    limit + 1,
    offset,
  );
  const { rows: tasks, hasMore } = pageRows(rows, limit);
  return { tasks, offset, limit, next_offset: hasMore ? offset + limit : null };
}

function encodeCursor(kind: string, values: CursorValues): string {
  return Buffer.from(JSON.stringify({ v: 1, kind, ...values })).toString("base64url");
}

function decodeCursor(req: Request, kind: string): CursorValues | null {
  if (typeof req.query.cursor !== "string" || req.query.cursor === "") return null;
  try {
    const parsed = JSON.parse(Buffer.from(req.query.cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    if (parsed.v !== 1 || parsed.kind !== kind) return null;
    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => typeof value === "string" || typeof value === "number"),
    ) as CursorValues;
  } catch {
    return null;
  }
}

function numericCursorValue(cursor: CursorValues | null, key: string): number | null {
  const value = cursor?.[key];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function pageRows<T>(rows: T[], limit: number): { rows: T[]; hasMore: boolean } {
  return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
}

type OverviewCategory = "open" | "active" | "ready" | "done";
const OVERVIEW_CATEGORIES: OverviewCategory[] = ["open", "active", "ready", "done"];

/** Legacy and malformed citation payloads are read as empty, never fatal. */
export function parseDecisionCitations(raw: unknown): Reference[] {
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((value) => {
      const checked = referenceSchema.safeParse(value);
      return checked.success ? [checked.data] : [];
    });
  } catch {
    return [];
  }
}

export function parseStringArray(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

type KnowledgeDocRow = {
  path: string;
  type: string;
  title: string;
  description: string;
  updated_at: number;
};

type KnowledgeDecisionRow = {
  id: number;
  task_id: number | null;
  task_title: string | null;
  kind: string;
  summary: string;
  rationale: string;
  created_at: number;
};

type KnowledgeLogRow = {
  id: number;
  task_id: number | null;
  task_title: string | null;
  entry: string;
  created_at: number;
};

const KNOWLEDGE_DECISION_WINDOW_MS = 30 * 60 * 1000;

function mentionsConcept(text: string, doc: KnowledgeDocRow): boolean {
  const haystack = text.toLowerCase();
  return haystack.includes(doc.path.toLowerCase()) ||
    (doc.title.length >= 5 && haystack.includes(doc.title.toLowerCase()));
}

function knowledgeLogDetails(entry: string): { action: "wrote" | "updated" | "curated"; path: string | null; decisionId: number | null } | null {
  const current = /^(Wrote|Updated) knowledge: (.+)$/.exec(entry);
  if (current) {
    return {
      action: current[1] === "Wrote" ? "wrote" : "updated",
      path: current[2].trim(),
      decisionId: null,
    };
  }
  const legacy = /^curated@(\d+):\s*(.*)$/i.exec(entry);
  if (legacy) return { action: "curated", path: null, decisionId: Number(legacy[1]) };
  return null;
}

function nearestKnowledgeDecision(log: KnowledgeLogRow, decisions: KnowledgeDecisionRow[]): KnowledgeDecisionRow | null {
  if (log.task_id === null) return null;
  const candidates = decisions
    .filter((decision) => decision.task_id === log.task_id)
    .map((decision) => ({ decision, distance: Math.abs(decision.created_at - log.created_at) }))
    .filter(({ distance }) => distance <= KNOWLEDGE_DECISION_WINDOW_MS)
    .sort((left, right) => {
      const leftAfter = left.decision.created_at >= log.created_at ? 0 : 1;
      const rightAfter = right.decision.created_at >= log.created_at ? 0 : 1;
      return left.distance - right.distance || leftAfter - rightAfter;
    });
  return candidates[0]?.decision ?? null;
}

async function activeKnowledgeForProject(db: Db, projectId: string) {
  const [docs, logs, decisions] = await Promise.all([
    db.prepare(
      "SELECT path, type, title, description, updated_at FROM memory_docs WHERE project_id = ? ORDER BY path",
    ).all<KnowledgeDocRow>(projectId),
    db.prepare(
      `SELECT ml.id, t.id AS task_id, t.title AS task_title, ml.entry, ml.created_at
       FROM memory_log ml LEFT JOIN tasks t ON t.id = ml.task_id AND t.project_id = ml.project_id
       WHERE ml.project_id = ? ORDER BY ml.id DESC LIMIT 100`,
    ).all<KnowledgeLogRow>(projectId),
    db.prepare(
      `SELECT dl.id, t.id AS task_id, t.title AS task_title, dl.kind, dl.summary, dl.rationale, dl.created_at
       FROM decision_log dl LEFT JOIN tasks t ON t.id = dl.task_id AND t.project_id = dl.project_id
       WHERE dl.project_id = ? ORDER BY dl.id DESC LIMIT 100`,
    ).all<KnowledgeDecisionRow>(projectId),
  ]);
  const docsByPath = new Map(docs.map((doc) => [doc.path, doc]));
  const decisionsById = new Map(decisions.map((decision) => [decision.id, decision]));
  const conceptDecisions = new Map<string, Map<number, KnowledgeDecisionRow>>();

  const rememberDecision = (path: string, decision: KnowledgeDecisionRow | null) => {
    if (!decision) return;
    const linked = conceptDecisions.get(path) ?? new Map<number, KnowledgeDecisionRow>();
    linked.set(decision.id, decision);
    conceptDecisions.set(path, linked);
  };

  const updates = logs.flatMap((log) => {
    const details = knowledgeLogDetails(log.entry);
    if (!details) return [];
    const explicitDecision = details.decisionId === null ? null : decisionsById.get(details.decisionId) ?? null;
    const decision = explicitDecision ?? nearestKnowledgeDecision(log, decisions);
    const doc = details.path ? docsByPath.get(details.path) : docs.find((candidate) =>
      mentionsConcept(log.entry, candidate) || (decision ? mentionsConcept(`${decision.summary}\n${decision.rationale}`, candidate) : false),
    );
    if (!doc) return [];
    rememberDecision(doc.path, decision);
    return [{
      id: log.id,
      action: details.action,
      path: doc.path,
      title: doc.title,
      type: doc.type,
      created_at: log.created_at,
      task: log.task_id === null ? null : { id: log.task_id, title: log.task_title ?? `Task ${log.task_id}` },
      decision: decision ? { id: decision.id, kind: decision.kind, summary: decision.summary } : null,
    }];
  });

  for (const decision of decisions) {
    const text = `${decision.summary}\n${decision.rationale}`;
    for (const doc of docs) {
      if (mentionsConcept(text, doc)) rememberDecision(doc.path, decision);
    }
  }

  const decisionItems = decisions.flatMap((decision) => {
    const concepts = docs.filter((doc) => conceptDecisions.get(doc.path)?.has(decision.id));
    if (concepts.length === 0) return [];
    return [{
      id: decision.id,
      kind: decision.kind,
      summary: decision.summary,
      created_at: decision.created_at,
      task: decision.task_id === null ? null : { id: decision.task_id, title: decision.task_title ?? `Task ${decision.task_id}` },
      concepts: concepts.map((doc) => ({ path: doc.path, title: doc.title })),
    }];
  });

  const conventions = docs
    .filter((doc) => doc.type.toLowerCase() === "convention")
    .map((doc) => {
      const enforcement = [...(conceptDecisions.get(doc.path)?.values() ?? [])]
        .filter((decision) => decision.kind === "hold" || decision.kind === "revise")
        .sort((left, right) => right.created_at - left.created_at)[0] ?? null;
      return {
        path: doc.path,
        title: doc.title,
        description: doc.description,
        updated_at: doc.updated_at,
        enforcement: enforcement ? {
          id: enforcement.id,
          kind: enforcement.kind,
          summary: enforcement.summary,
          created_at: enforcement.created_at,
          task: enforcement.task_id === null ? null : {
            id: enforcement.task_id,
            title: enforcement.task_title ?? `Task ${enforcement.task_id}`,
          },
        } : null,
      };
    });

  return { updates, decisions: decisionItems, conventions, conceptDecisions };
}

async function knowledgeProvenanceForDoc(
  db: Db,
  projectId: string,
  doc: Pick<KnowledgeDocRow, "path" | "title">,
): Promise<KnowledgeDecisionRow[]> {
  const likePattern = (value: string) => `%${value.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`;
  const pathPattern = likePattern(doc.path);
  const titlePattern = doc.title.length >= 5 ? likePattern(doc.title) : pathPattern;
  const [mentioned, logLinked, legacyLogs] = await Promise.all([
    db.prepare(
      `SELECT dl.id, t.id AS task_id, t.title AS task_title, dl.kind, dl.summary, dl.rationale, dl.created_at
         FROM decision_log dl LEFT JOIN tasks t ON t.id = dl.task_id AND t.project_id = dl.project_id
        WHERE dl.project_id = ? AND (
          LOWER(dl.summary) LIKE ? ESCAPE '\\' OR LOWER(dl.rationale) LIKE ? ESCAPE '\\' OR
          LOWER(dl.summary) LIKE ? ESCAPE '\\' OR LOWER(dl.rationale) LIKE ? ESCAPE '\\'
        )
        ORDER BY dl.id DESC LIMIT 100`,
    ).all<KnowledgeDecisionRow>(projectId, pathPattern, pathPattern, titlePattern, titlePattern),
    db.prepare(
      `WITH ranked AS (
         SELECT dl.id, t.id AS task_id, t.title AS task_title, dl.kind, dl.summary, dl.rationale,
                dl.created_at, ROW_NUMBER() OVER (
                  PARTITION BY ml.id
                  ORDER BY ABS(dl.created_at - ml.created_at),
                           CASE WHEN dl.created_at >= ml.created_at THEN 0 ELSE 1 END,
                           dl.id DESC
                ) AS rank
           FROM memory_log ml
           JOIN decision_log dl
             ON dl.project_id = ml.project_id AND dl.task_id = ml.task_id
            AND dl.created_at BETWEEN ml.created_at - ? AND ml.created_at + ?
           LEFT JOIN tasks t ON t.id = dl.task_id AND t.project_id = dl.project_id
          WHERE ml.project_id = ? AND (ml.entry = ? OR ml.entry = ?)
       )
       SELECT id, task_id, task_title, kind, summary, rationale, created_at
         FROM ranked WHERE rank = 1 ORDER BY id DESC`,
    ).all<KnowledgeDecisionRow>(
      KNOWLEDGE_DECISION_WINDOW_MS,
      KNOWLEDGE_DECISION_WINDOW_MS,
      projectId,
      `Wrote knowledge: ${doc.path}`,
      `Updated knowledge: ${doc.path}`,
    ),
    db.prepare(
      `SELECT entry FROM memory_log
        WHERE project_id = ? AND LOWER(entry) LIKE ? ESCAPE '\\'
        ORDER BY id DESC LIMIT 100`,
    ).all<{ entry: string }>(projectId, likePattern(`: ${doc.path}`)),
  ]);
  const legacyIds = legacyLogs.flatMap((log) => {
    const details = knowledgeLogDetails(log.entry);
    return details?.decisionId == null ? [] : [details.decisionId];
  });
  const legacyDecisions = legacyIds.length === 0
    ? []
    : await db.prepare(
        `SELECT dl.id, t.id AS task_id, t.title AS task_title, dl.kind, dl.summary, dl.rationale, dl.created_at
           FROM decision_log dl LEFT JOIN tasks t ON t.id = dl.task_id AND t.project_id = dl.project_id
          WHERE dl.project_id = ? AND dl.id IN (${legacyIds.map(() => "?").join(",")})`,
      ).all<KnowledgeDecisionRow>(projectId, ...legacyIds);
  return [...new Map([...mentioned, ...logLinked, ...legacyDecisions].map((decision) => [decision.id, decision])).values()]
    .sort((left, right) => right.created_at - left.created_at || right.id - left.id);
}

/** Row lock suffix used only inside the atomic project-delete transaction. */
export function projectDeleteRowLockSql(dialect: Db["dialect"], sql: string): string {
  return sql + (dialect === "postgres" ? " FOR UPDATE" : "");
}

/**
 * The public join URL for a token. Prefers MEMRACER_PUBLIC_URL (the deployed
 * origin); falls back to the request's own origin so a link works in dev and in
 * tests without the env set. The token is the only secret — the path is public.
 */
function joinUrl(req: Request, token: string): string {
  const base = (process.env.MEMRACER_PUBLIC_URL || `${req.protocol}://${req.get("host")}`).replace(
    /\/+$/,
    "",
  );
  return `${base}/join?token=${encodeURIComponent(token)}`;
}

/** The `type` tag a minted token carries in its better-auth apikey metadata. */
export type TokenType = "human" | "coder";
export type ClarificationMode = "text";

/** apikey.metadata is a JSON string ({ projectId, type, ... }); parse defensively. */
function parseKeyMetadata(raw: string | null): {
  projectId?: string;
  type?: TokenType;
  clarificationMode?: ClarificationMode;
} {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as {
      projectId?: string;
      type?: TokenType;
      clarificationMode?: ClarificationMode;
    };
  } catch {
    return {};
  }
}

/** Coerce an ISO string, Date, or existing epoch-ms timestamp, or null when unparseable. */
function toEpochMs(v: string | number | Date | null | undefined): number | null {
  if (v == null) return null;
  const t = typeof v === "number"
    ? v
    : v instanceof Date
      ? v.getTime()
      : Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/**
 * Release identity for the version-announce SSE event. A deployment that runs
 * each release from a directory named after its sha gets that sha; in dev it
 * is the repo directory name. Any change triggers the client reload, which is
 * all that matters.
 */
export function serverVersion(): string {
  return path.basename(process.cwd());
}

const PREVIEW_CHARS = 120;

function preview(content: string | null): string | null {
  if (content === null) return null;
  return content.length > PREVIEW_CHARS ? `${content.slice(0, PREVIEW_CHARS)}…` : content;
}

/**
 * Resolve the caller for a dashboard route. Normally the Bearer header;
 * the SSE route also accepts `?token=` because the browser EventSource API
 * cannot set request headers.
 */
async function memberFor(db: Db, req: Request, allowQueryToken: boolean): Promise<Member | null> {
  const attribution = { sourceIp: requestSourceIp(req.headers, req.socket.remoteAddress) };
  const fromHeader = await resolveMember(db, req.header("authorization"), attribution);
  if (fromHeader) return fromHeader;
  // A signed-in human carries a better-auth session cookie, not a Bearer token.
  const fromSession = await resolveSession(db, req.headers);
  if (fromSession) return fromSession;
  if (!allowQueryToken) return null;
  const token = req.query.token;
  if (typeof token !== "string" || token === "") return null;
  return resolveMember(db, `Bearer ${token}`, attribution);
}

/**
 * Static front-end for the dashboard. No auth: the assets are public; every
 * data road goes through the scoped /api routes. The generated React bundle
 * and retained support files sit next to this module in dev and in builds, so
 * import.meta.url resolves both locations without a cwd dependency.
 */
export function registerDashboardStatic(app: express.Express): void {
  const webDir = fileURLToPath(new URL("./dashboard/web-dist/", import.meta.url));
  const publicDir = fileURLToPath(new URL("./dashboard/public/", import.meta.url));
  // Express 5 / send@1 require { root } + a relative path; absolute sendFile paths 404.
  const sendFrom =
    (root: string, file: string) =>
    (_req: express.Request, res: express.Response): void => {
      res.sendFile(file, { root });
    };
  // Signed-out marketing homepage (task #509). Dashboard remains at /dashboard.
  app.get("/", sendFrom(webDir, "marketing.html"));
  // FAQ-only teaching surface (onboarding #563) — same marketing bundle, client pathname switch.
  app.get("/faq", sendFrom(webDir, "marketing.html"));
  app.get("/dashboard", sendFrom(webDir, "index.html"));
  app.use("/dashboard/next", (_req, res) => res.sendStatus(404));
  app.get("/signin", sendFrom(publicDir, "signin.html"));
  app.get("/oauth/consent", sendFrom(publicDir, "oauth-consent.html"));
  // The invite join page: reads ?token=, calls /api/invite/:token, completes
  // the magic-link session, and lands signed in.
  app.get("/join", sendFrom(publicDir, "join.html"));
  app.use("/dashboard", express.static(webDir));
  // The React bundle shares these auth/PWA/setup support files.
  app.get("/dashboard/styles.css", sendFrom(publicDir, "styles.css"));
  app.get("/dashboard/manifest.json", sendFrom(publicDir, "manifest.json"));
  app.get("/dashboard/role-contracts.js", sendFrom(publicDir, "role-contracts.js"));
  app.use("/dashboard/icons", express.static(path.join(publicDir, "icons")));
  // Marketing product shots (task #535) — regenerate via `pnpm marketing:shots`.
  app.use("/dashboard/marketing", express.static(path.join(publicDir, "marketing")));
}


/** Normalize + validate a waitlist email; null when unusable. */
export function normalizeWaitlistEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  // Require local@domain.tld with at least one dot in the domain.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  if (email.length > 320) return null;
  return email;
}

/**
 * Read-only dashboard API. Any role may view; project membership is the
 * visibility boundary — a project the caller is not a member of is
 * indistinguishable from one that does not exist (404).
 */
export function registerDashboard(
  app: express.Express,
  db: Db,
  queue: Queue,
  options?: {
    sseKeepaliveMs?: number;
    worker?: MediatorWorker;
    imageAttachments?: ImageAttachmentService;
  },
): void {
  const keepaliveMs = options?.sseKeepaliveMs ?? DEFAULT_SSE_KEEPALIVE_MS;
  const worker = options?.worker;
  const imageAttachments = options?.imageAttachments;
  const conversations = new ConversationStore(db, queue);
  const attentionAlerts = new AttentionAlertService(db, process.env.MEMRACER_PUBLIC_URL);
  const projectKnowledge = new ProjectKnowledgeState(db);
  const requestKnowledgeRefresh = async (
    projectId: string,
    domains: ProjectKnowledgeDomain[],
    reason: string,
  ) => {
    await projectKnowledge.markEvent(projectId, domains, reason);
  };

  function scoped(
    allowQueryToken: boolean,
    handler: (req: Request, res: Response, member: Member, membership: Membership) => void | Promise<void>,
  ) {
    return async (req: Request, res: Response) => {
      const member = await memberFor(db, req, allowQueryToken);
      if (!member) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }
      const membership = member.memberships.find((m) => m.projectId === req.params.project);
      if (!membership) {
        res.status(404).json({ error: "not found" });
        return;
      }
      await handler(req, res, member, membership);
    };
  }

  app.get("/api/projects", async (req, res) => {
    const member = await memberFor(db, req, false);
    if (member) {
      res.json({ projects: member.memberships });
      return;
    }
    // A signed-in human with no membership yet (fresh sign-up) is not
    // unauthorized — they get an empty list and the client shows onboarding.
    const user = await resolveSessionUser(db, req.headers);
    if (user) {
      res.json({ projects: [] });
      return;
    }
    res.status(401).json({ error: "unauthorized" });
  });

  // Who am I (#73): the signed-in identity + memberships, for the dashboard to
  // render the authenticated shell (better-auth session cookie or Bearer token).
  app.get("/api/me", async (req, res) => {
    const member = await memberFor(db, req, false);
    if (member) {
      res.json({ name: member.name, memberships: member.memberships });
      return;
    }
    const user = await resolveSessionUser(db, req.headers);
    if (user) {
      res.json({ name: user.name, memberships: [] });
      return;
    }
    res.status(401).json({ error: "unauthorized" });
  });

  // ===================================================================
  // #78 — real onboarding + team management (write routes). Every mutation
  // is authenticated by a better-auth SESSION (a signed-in human), never a
  // legacy token, and admin actions are gated on better-auth org membership.
  // ===================================================================

  const ROLES: Role[] = ["human", "coder", "admin"];
  const isRole = (v: unknown): v is Role => typeof v === "string" && (ROLES as string[]).includes(v);

  // better-auth's API-key and magic-link methods, narrowed at the call site
  // (the widened BetterAuthOptions erases these off auth.api).
  interface AdminAuthApi {
    signInMagicLink(args: {
      body: {
        email: string;
        name?: string;
        callbackURL?: string;
        newUserCallbackURL?: string;
        errorCallbackURL?: string;
        metadata?: Record<string, unknown>;
      };
      headers?: Headers;
    }): Promise<{ status: boolean }>;
    createApiKey(args: {
      body: { userId: string; name?: string; metadata?: Record<string, unknown> };
    }): Promise<{
      id: string;
      name: string | null;
      start: string | null;
      key: string;
      createdAt: string | Date;
    }>;
    getAccessToken(args: {
      body: { providerId: string; userId: string };
    }): Promise<{ accessToken: string }>;
  }
  function authApi(): AdminAuthApi | null {
    const handle = authFor(db);
    return handle ? (handle.auth.api as unknown as AdminAuthApi) : null;
  }

  /**
   * Mint a role-scoped seat key via better-auth, tagged with { projectId, type }
   * so the Tokens screen and the MCP endpoint resolve its role. Shared by the
   * api-keys route and seat enrollment redemption (DRY). Throws if better-auth
   * is unavailable on this backend; callers that can surface a 409 check first.
   */
  async function mintSeatKey(
    userId: string,
    projectId: string,
    // Any project role SLUG (human, coder, or a custom role like reviewer).
    // metadata.type stores the raw slug; auth resolution maps it to a surface.
    role: string,
    name: string,
  ): Promise<{ key: string; keyId: string; name: string; start: string | null; createdAt: number | null }> {
    const api = authApi();
    if (!api) throw new Error("better-auth unavailable on this backend");
    const clarificationMode: ClarificationMode = "text";
    const created = await api.createApiKey({
      body: { userId, name, metadata: { projectId, type: role, clarificationMode } },
    });
    return {
      key: created.key,
      keyId: created.id,
      name: created.name ?? name,
      start: created.start,
      createdAt: toEpochMs(created.createdAt),
    };
  }

  /**
   * Mint an identity-wide OPERATOR key for the CLI (`memracer login`). Unlike a
   * seat key it carries no projectId — metadata.type === "operator" tells the
   * auth resolver to grant the user's full membership set, so the CLI can act as
   * the operator across every project they admin (mint enrollments, list seats).
   */
  async function mintOperatorKey(userId: string): Promise<{ token: string }> {
    const api = authApi();
    if (!api) throw new Error("better-auth unavailable on this backend");
    const created = await api.createApiKey({
      body: { userId, name: "memracer CLI", metadata: { type: "operator" } },
    });
    return { token: created.key };
  }

  async function issueMagicLink(args: {
    email: string;
    name?: string;
    callbackURL: string;
    purpose: "sign-in" | "invite";
  }): Promise<void> {
    const api = authApi();
    if (!api) throw new Error("better-auth unavailable on this backend");
    await api.signInMagicLink({
      body: {
        email: args.email,
        name: args.name,
        callbackURL: args.callbackURL,
        newUserCallbackURL: args.callbackURL,
        metadata: { purpose: args.purpose },
      },
      headers: new Headers({ origin: process.env.MEMRACER_PUBLIC_URL || "http://localhost:3000" }),
    });
  }

  const duplicateWarning = (kind: "Org" | "Project", duplicateName: boolean) =>
    duplicateName ? `Another ${kind} already uses this name. The new ${kind} was still created.` : null;

  /** The signed-in user for a mutation, or a 401-terminated request. */
  async function sessionUserOr401(
    req: Request,
    res: Response,
  ): Promise<{ userId: string; name: string; email: string | null } | null> {
    const user = await resolveSessionUser(db, req.headers);
    if (!user) {
      res.status(401).json({ error: "sign in required" });
      return null;
    }
    return user;
  }

  async function requireOrgAccess(req: Request, res: Response) {
    const user = await sessionUserOr401(req, res);
    if (!user) return null;
    const orgId = String(req.params.org);
    const org = await db.prepare(
      `SELECT id, name, created_by, provider_id, custom_base_url, lite_model_mode, lite_model,
              thinking_model_mode, thinking_model, allow_project_model_override,
              project_create_policy, default_provider_key_id,
              stripe_customer_id, stripe_subscription_id, plan, seat_quantity,
              billing_status, current_period_end, billing_email
         FROM orgs WHERE id = ?`,
    ).get<{
      id: string;
      name: string;
      created_by: string | null;
      provider_id: string | null;
      custom_base_url: string | null;
      lite_model_mode: string | null;
      lite_model: string | null;
      thinking_model_mode: string | null;
      thinking_model: string | null;
      allow_project_model_override: number | null;
      project_create_policy: string | null;
      default_provider_key_id: string | null;
      stripe_customer_id: string | null;
      stripe_subscription_id: string | null;
      plan: string | null;
      seat_quantity: number | null;
      billing_status: string | null;
      current_period_end: number | null;
      billing_email: string | null;
    }>(orgId);
    if (!org) {
      res.status(404).json({ error: "org not found" });
      return null;
    }
    if (!(await isOrgMember(db, user.userId, orgId))) {
      res.status(403).json({ error: "Org access required" });
      return null;
    }
    return { user, org };
  }

  async function requireOrgAdmin(req: Request, res: Response) {
    const access = await requireOrgAccess(req, res);
    if (!access) return null;
    if (access.org.created_by !== access.user.userId) {
      res.status(403).json({ error: "Org admin required" });
      return null;
    }
    return access;
  }

  async function assertCanCreateProject(
    org: {
      id: string;
      created_by: string | null;
      project_create_policy: string | null;
      plan?: string | null;
      seat_quantity?: number | null;
      billing_status?: string | null;
    },
    userId: string,
    res: Response,
  ): Promise<boolean> {
    const policy = org.project_create_policy === "org_admins_only" ? "org_admins_only" : "any_org_member";
    if (policy === "org_admins_only" && org.created_by !== userId) {
      res.status(403).json({ error: "Only org admins can create projects" });
      return false;
    }
    const { assertCanAddProject } = await import("./billing/limits.js");
    const gate = await assertCanAddProject(db, {
      id: org.id,
      plan: org.plan ?? "none",
      seat_quantity: org.seat_quantity ?? 0,
      billing_status: org.billing_status ?? "none",
    });
    if (!gate.ok) {
      res.status(gate.status).json({ error: gate.error });
      return false;
    }
    return true;
  }

  function asModelMode(raw: unknown, fallback: ModelMode = "use_default"): ModelMode {
    return raw === "override" ? "override" : fallback;
  }

  /**
   * User-to-server GitHub OAuth token for the signed-in dashboard user.
   *
   * When accessTokenExpiresAt is past/near, force a direct refresh against
   * GitHub and persist the new tokens — do not trust better-auth getAccessToken
   * alone (it can return a stale token after a silent refresh miss). On
   * forceRefresh, skip the stored token entirely. Returns null when the
   * account is missing or refresh is required but fails (caller should offer
   * reconnect).
   */
  async function githubAccessToken(
    userId: string,
    opts: { forceRefresh?: boolean } = {},
  ): Promise<string | null> {
    const handle = authFor(db);
    if (!handle) return null;
    await handle.ready;

    const account = await db.prepare(
      `SELECT id, "accessToken", "refreshToken", "accessTokenExpiresAt"
         FROM "account" WHERE "userId" = ? AND "providerId" = ?`,
    ).get<{
      id: string;
      accessToken: string | null;
      refreshToken: string | null;
      accessTokenExpiresAt: string | Date | null;
    }>(userId, "github");
    if (!account) return null;

    const expiresMs = account.accessTokenExpiresAt
      ? new Date(account.accessTokenExpiresAt).getTime()
      : NaN;
    // Refresh when forceRefresh, or when we know the token is expired/near-expiry.
    // Legacy rows with null expiresAt keep the better-auth path; 401 retry covers them.
    const expiredOrNear =
      Number.isFinite(expiresMs) && expiresMs - Date.now() < 60_000;
    const mustRefresh = Boolean(opts.forceRefresh || expiredOrNear);

    if (mustRefresh) {
      if (!account.refreshToken) return null;
      const refreshed = await refreshGitHubUserAccessToken(account.refreshToken);
      if (!refreshed) return null;
      const nowIso = new Date().toISOString();
      await db.prepare(
        `UPDATE "account" SET
           "accessToken" = ?,
           "refreshToken" = ?,
           "accessTokenExpiresAt" = ?,
           "refreshTokenExpiresAt" = COALESCE(?, "refreshTokenExpiresAt"),
           "updatedAt" = ?
         WHERE id = ?`,
      ).run(
        refreshed.accessToken,
        refreshed.refreshToken,
        refreshed.accessTokenExpiresAt.toISOString(),
        refreshed.refreshTokenExpiresAt?.toISOString() ?? null,
        nowIso,
        account.id,
      );
      return refreshed.accessToken;
    }

    try {
      const token = (await (handle.auth.api as unknown as AdminAuthApi).getAccessToken({
        body: { providerId: "github", userId },
      })).accessToken;
      return token || account.accessToken || null;
    } catch {
      return account.accessToken || null;
    }
  }

  /** Run a user-token GitHub call; on 401 force-refresh once and retry. */
  async function withGitHubUserToken<T>(
    userId: string,
    run: (token: string) => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; reauth: true }> {
    let token = await githubAccessToken(userId);
    if (!token) return { ok: false, reauth: true };
    try {
      return { ok: true, value: await run(token) };
    } catch (error) {
      if (!(error instanceof GitHubAppError) || error.status !== 401) throw error;
      token = await githubAccessToken(userId, { forceRefresh: true });
      if (!token) return { ok: false, reauth: true };
      try {
        return { ok: true, value: await run(token) };
      } catch (retryError) {
        if (retryError instanceof GitHubAppError && retryError.status === 401) {
          return { ok: false, reauth: true };
        }
        throw retryError;
      }
    }
  }

  class CandidateCollision extends Error {}
  class RepositoryAlreadyEnrolled extends Error {}

  async function createProjectRecord(input: {
    orgId: string;
    userId: string;
    name: string;
    repo: string | null;
    github?: { installationId: string; repository: GitHubRepository };
  }) {
    if (!authFor(db)) throw new GitHubAppError(409, "better-auth unavailable on this backend");
    const nowIso = new Date().toISOString();
    const projectId = await allocateSlug({
      preferred: input.name,
      entity: "project",
      claim: async (candidate) => {
        try {
          await db.transaction(async () => {
            const project = await db
              .prepare("INSERT INTO projects (id, name, repo, org_id, created_by) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING")
              .run(candidate, input.name, input.repo, input.orgId, input.userId);
            if (project.changes === 0) throw new CandidateCollision();
            const organization = await db
              .prepare('INSERT INTO "organization" (id, name, slug, "createdAt") VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING')
              .run(candidate, input.name, candidate, nowIso);
            if (organization.changes === 0) {
              const candidateConflict = await db
                .prepare('SELECT id FROM "organization" WHERE id = ? OR slug = ?')
                .get(candidate, candidate);
              if (candidateConflict) throw new CandidateCollision();
              throw new Error("better-auth organization insert hit an unrelated unique constraint");
            }
            await db
              .prepare(
                'INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES (?, ?, ?, ?, ?)',
              )
              .run(randomUUID(), candidate, input.userId, "admin", nowIso);
            // Seed the two built-in roles (human + coder) so every new project
            // resolves seat role slugs from day one (Part F).
            await seedDefaultRoles(db, candidate);
            if (input.github) {
              const binding = await db.prepare(
                `INSERT INTO github_project_repos (project_id, installation_id, repository_id, full_name)
                 VALUES (?, ?, ?, ?) ON CONFLICT (repository_id) DO NOTHING`,
              ).run(candidate, input.github.installationId, input.github.repository.id, input.github.repository.fullName);
              if (binding.changes === 0) throw new RepositoryAlreadyEnrolled();
            }
          });
          return true;
        } catch (error) {
          if (error instanceof CandidateCollision) return false;
          throw error;
        }
      },
    });
    const duplicateName =
      (await db.prepare("SELECT COUNT(*) AS n FROM projects WHERE name = ?").get<{ n: number }>(input.name))!.n > 1;
    if (input.repo) {
      await requestKnowledgeRefresh(
        projectId,
        ["architecture-tech", "operational-external"],
        `repository associated at project creation: ${input.repo}`,
      );
    }
    return {
      id: projectId,
      name: input.name,
      repo: input.repo,
      orgId: input.orgId,
      duplicateName,
      warning: duplicateWarning("Project", duplicateName),
    };
  }

  function githubFailure(res: Response, error: unknown): void {
    if (res.headersSent) return;
    if (error instanceof GitHubAppError) {
      res.status(error.status).json({ error: error.message, message: error.message });
      return;
    }
    if (error instanceof RepositoryAlreadyEnrolled) {
      res.status(409).json({
        error: "repository is already enrolled in a Project",
        message: "repository is already enrolled in a Project",
      });
      return;
    }
    // Never rethrow from async Express handlers — unhandled rejection becomes a
    // proxy 502 with no JSON body. Surface a structured 500 instead.
    const message = error instanceof Error ? error.message : String(error);
    console.error("[github-request-failure]", message);
    res.status(500).json({ error: "GitHub request failed", message });
  }

  /** Assert the session user is an admin of :project; 401/403-terminates otherwise. */
  async function requireProjectAdmin(
    req: Request,
    res: Response,
    lockForDelete = false,
  ): Promise<{ userId: string; projectId: string } | null> {
    const user = await sessionUserOr401(req, res);
    if (!user) return null;
    const projectId = String(req.params.project);
    const memberSql =
      lockForDelete
        ? projectDeleteRowLockSql(db.dialect, 'SELECT m.role, p.created_by FROM "member" m JOIN projects p ON p.id = m."organizationId" WHERE m."userId" = ? AND m."organizationId" = ?')
        : 'SELECT m.role, p.created_by FROM "member" m JOIN projects p ON p.id = m."organizationId" WHERE m."userId" = ? AND m."organizationId" = ?';
    const row = await db
      .prepare(memberSql)
      .get<{ role: string; created_by: string | null }>(user.userId, projectId);
    if (!row) {
      res.status(404).json({ error: "not found" });
      return null;
    }
    if (row.role !== "admin" && row.created_by !== user.userId) {
      res.status(403).json({ error: "admin only" });
      return null;
    }
    return { userId: user.userId, projectId };
  }

  /**
   * Admit an admin of :project via EITHER a browser session OR a Bearer operator
   * token (CLI-managed tokens, D3). A signed-in session takes the existing
   * requireProjectAdmin path (404/403 as before). With no session we fall
   * through to the operator token: it resolves to a Member carrying every
   * membership, and we require an admin membership on this project.
   */
  async function requireProjectAdminOrOperator(
    req: Request,
    res: Response,
  ): Promise<{ userId: string; projectId: string } | null> {
    // A signed-in human keeps the cookie path (and its 404/403 semantics).
    if (await resolveSessionUser(db, req.headers)) return requireProjectAdmin(req, res);
    const attribution = { sourceIp: requestSourceIp(req.headers, req.socket.remoteAddress) };
    const member = await resolveMember(db, req.header("authorization"), attribution);
    if (!member || !member.userId) {
      res.status(401).json({ error: "sign in required" });
      return null;
    }
    const projectId = String(req.params.project);
    const admin = member.memberships.find((m) => m.projectId === projectId && m.role === "admin");
    if (!admin) {
      res.status(403).json({ error: "admin only" });
      return null;
    }
    return { userId: member.userId, projectId };
  }

  // Public marketing waitlist (task #509). No session; store-only, idempotent.
  // Validate first (400), then rate-limit valid submits (5/min/IP).
  app.post("/api/waitlist", async (req, res) => {
    const email = normalizeWaitlistEmail(req.body?.email);
    if (!email) {
      res.status(400).json({ error: "valid email required" });
      return;
    }
    const ip = requestSourceIp(req.headers) ?? req.ip ?? "unknown";
    const limited = WAITLIST_LIMITER.check(`waitlist:${ip}`);
    if (!limited.allowed) {
      res.setHeader("Retry-After", String(limited.retryAfterSec));
      res.status(429).json({ error: "too many waitlist requests; try again shortly" });
      return;
    }
    const source =
      typeof req.body?.source === "string" && req.body.source.trim()
        ? req.body.source.trim().slice(0, 64)
        : "homepage";
    await db
      .prepare(
        "INSERT INTO waitlist_emails (email, created_at, source) VALUES (?, ?, ?) ON CONFLICT (email) DO NOTHING",
      )
      .run(email, Date.now(), source);
    res.json({ ok: true });
  });

  // The signed-in identity even with no membership — drives the onboarding vs.
  // gate decision on the client (a fresh sign-up must not be bounced to the gate).
  app.get("/api/session", async (req, res) => {
    const user = await resolveSessionUser(db, req.headers);
    if (!user) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    res.json({ userId: user.userId, name: user.name, email: user.email });
  });

  // Client runtime config for the Tokens screen. No CF Access credentials —
  // MCP snippets are Bearer-only.
  app.get("/api/config", async (req, res) => {
    const user = await sessionUserOr401(req, res);
    if (!user) return;
    res.json({
      vapidPublicKey: vapidPublicKey(),
      mcpUrl: "https://memracer.com/mcp",
      publicUrl: process.env.MEMRACER_PUBLIC_URL || null,
    });
  });

  // Canonical project attention (task #418) — same builder as human_status.
  app.get(
    "/api/p/:project/attention",
    scoped(false, async (_req, res, member, membership) => {
      const items = await listHumanAttention(db, attentionAlerts, {
        projectIds: [membership.projectId],
        projectNames: new Map([[membership.projectId, membership.projectName]]),
        publicUrl: process.env.MEMRACER_PUBLIC_URL,
        memberName: member.name,
        includeLeases: true,
        includeBlocked: true,
      });
      res.json({ items });
    }),
  );

  // Zero-token waiter (Fix A): the claimable-count for a role, so a BYO coder
  // can block cheaply in `memracer wait` (the CLI loops, the model stays asleep)
  // and wake only when there is claimable work. Accepts the operator OR a seat
  // Bearer token via scoped()/memberFor; member-scoped to the project.
  app.get(
    "/api/p/:project/queue-depth",
    scoped(false, async (req, res, _member, membership) => {
      const role =
        typeof req.query.role === "string" && req.query.role ? req.query.role : "coder";
      const available = await queue.claimableCount(membership.projectId, role);
      res.json({ available });
    }),
  );

  // Web Push subscription management (session-auth only).
  app.get("/api/push/status", async (req, res) => {
    const user = await sessionUserOr401(req, res);
    if (!user) return;
    res.json(await pushStatusForUser(db, user.userId));
  });

  app.post("/api/push/subscribe", async (req, res) => {
    const user = await sessionUserOr401(req, res);
    if (!user) return;
    if (!vapidConfigured()) {
      res.status(503).json({ error: "web push is not configured" });
      return;
    }
    const endpoint = typeof req.body?.endpoint === "string" ? req.body.endpoint.trim() : "";
    const p256dh = typeof req.body?.keys?.p256dh === "string" ? req.body.keys.p256dh.trim() : "";
    const auth = typeof req.body?.keys?.auth === "string" ? req.body.keys.auth.trim() : "";
    if (!endpoint || !p256dh || !auth) {
      res.status(400).json({ error: "endpoint and keys.p256dh/keys.auth required" });
      return;
    }
    if (!endpoint.startsWith("https://")) {
      res.status(400).json({ error: "endpoint must be https" });
      return;
    }
    await upsertPushSubscription(db, {
      userId: user.userId,
      endpoint,
      p256dh,
      auth,
      userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null,
    });
    res.json({ ok: true, ...(await pushStatusForUser(db, user.userId)) });
  });

  app.delete("/api/push/subscribe", async (req, res) => {
    const user = await sessionUserOr401(req, res);
    if (!user) return;
    const endpoint = typeof req.body?.endpoint === "string" ? req.body.endpoint.trim() : "";
    if (!endpoint) {
      res.status(400).json({ error: "endpoint required" });
      return;
    }
    await revokePushSubscription(db, user.userId, endpoint);
    res.json({ ok: true, ...(await pushStatusForUser(db, user.userId)) });
  });

  // Create an org (the project-owner scope). Any signed-in user may create one.
  app.post("/api/orgs", async (req, res) => {
    const user = await sessionUserOr401(req, res);
    if (!user) return;
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!name) {
      res.status(400).json({ error: "name required" });
      return;
    }
    // Record the creator on the org row itself — teams have no membership
    // table, so created_by is the durable "who owns this team" fact. (The
    // creator of each project inside it additionally gets an admin member
    // row; roles stack, and admin implies human everywhere roles are read.)
    const id = await allocateSlug({
      preferred: name,
      entity: "organization",
      claim: async (candidate) =>
        (await db
          .prepare("INSERT INTO orgs (id, name, created_by, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO NOTHING")
          .run(candidate, name, user.userId, Date.now())).changes === 1,
    });
    const duplicateName =
      (await db.prepare("SELECT COUNT(*) AS n FROM orgs WHERE name = ?").get<{ n: number }>(name))!.n > 1;
    res.json({ id, name, duplicateName, warning: duplicateWarning("Org", duplicateName) });
  });

  // Create a project inside an org; the creator becomes its better-auth admin.
  // Provisions the paired better-auth organization (id == project id) so the
  // project's queue, team, roles, and API keys all resolve through better-auth.
  app.post("/api/orgs/:org/projects", async (req, res) => {
    const access = await requireOrgAccess(req, res);
    if (!access) return;
    if (!(await assertCanCreateProject(access.org, access.user.userId, res))) return;
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!name) {
      res.status(400).json({ error: "name required" });
      return;
    }
    const repo = typeof req.body?.repo === "string" && req.body.repo.trim() ? req.body.repo.trim() : null;
    try {
      res.json(await createProjectRecord({ orgId: access.org.id, userId: access.user.userId, name, repo }));
    } catch (error) {
      githubFailure(res, error);
    }
  });

  // Org Settings: provider, models, keys, project-create policy (admin mutates).
  app.get("/api/orgs/:org/settings", async (req, res) => {
    const access = await requireOrgAccess(req, res);
    if (!access) return;
    const org = access.org;
    const providerId = isProviderId(org.provider_id ?? "") ? (org.provider_id as ProviderId) : "openrouter";
    const liteMode = asModelMode(org.lite_model_mode);
    const thinkingMode = asModelMode(org.thinking_model_mode);
    let resolved: { liteModel: string; thinkingModel: string };
    try {
      resolved = resolveModels({
        providerId,
        liteMode,
        liteOverride: org.lite_model,
        thinkingMode,
        thinkingOverride: org.thinking_model,
      });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
    const keys = await db.prepare(
      `SELECT id, label, last4, created_at, created_by
         FROM org_provider_keys WHERE org_id = ? ORDER BY created_at DESC`,
    ).all<{ id: string; label: string; last4: string; created_at: number; created_by: string | null }>(org.id);
    const isAdmin = org.created_by === access.user.userId;
    res.json({
      id: org.id,
      name: org.name,
      createdBy: org.created_by,
      isAdmin,
      projectCreatePolicy: org.project_create_policy === "org_admins_only" ? "org_admins_only" : "any_org_member",
      providerId,
      customBaseUrl: org.custom_base_url,
      liteModelMode: liteMode,
      liteModel: org.lite_model,
      thinkingModelMode: thinkingMode,
      thinkingModel: org.thinking_model,
      resolvedLiteModel: resolved.liteModel,
      resolvedThinkingModel: resolved.thinkingModel,
      allowProjectModelOverride: Number(org.allow_project_model_override ?? 0) === 1,
      defaultProviderKeyId: org.default_provider_key_id,
      keys: keys.map((k) => ({
        id: k.id,
        label: k.label,
        last4: k.last4,
        createdAt: k.created_at,
        createdBy: k.created_by,
        isDefault: k.id === org.default_provider_key_id,
      })),
      providers: PROVIDER_IDS.map((id) => ({
        id,
        label: PROVIDER_CATALOG[id].label,
        baseUrl: PROVIDER_CATALOG[id].baseUrl,
        defaultLiteModel: PROVIDER_CATALOG[id].defaultLiteModel,
        defaultThinkingModel: PROVIDER_CATALOG[id].defaultThinkingModel,
      })),
      billing: {
        plan: org.plan ?? "none",
        seatQuantity: Number(org.seat_quantity ?? 0),
        billingStatus: org.billing_status ?? "none",
        currentPeriodEnd: org.current_period_end,
        billingEmail: org.billing_email,
        hasCustomer: Boolean(org.stripe_customer_id),
        stripeConfigured: Boolean(process.env.STRIPE_SECRET_KEY?.trim()),
      },
    });
  });

  // Stripe Checkout / Customer Portal (org admin).
  app.post("/api/orgs/:org/billing/checkout", async (req, res) => {
    const access = await requireOrgAdmin(req, res);
    if (!access) return;
    const plan = req.body?.plan === "solo" || req.body?.plan === "team" ? req.body.plan : null;
    const seats = Number(req.body?.seats);
    if (!plan || !Number.isFinite(seats) || seats < 1) {
      res.status(400).json({ error: "plan (solo|team) and seats (>=1) required" });
      return;
    }
    if (plan === "solo" && seats > 15) {
      res.status(400).json({ error: "Solo plan allows at most 15 seats" });
      return;
    }
    if (plan === "team" && seats > 100) {
      res.status(400).json({ error: "Team plan allows at most 100 seats self-serve" });
      return;
    }
    try {
      const { createCheckoutSession, stripeFromEnv } = await import("./billing/stripe.js");
      const stripe = stripeFromEnv(process.env);
      if (!stripe) {
        res.status(503).json({ error: "Stripe is not configured on this host" });
        return;
      }
      const session = await createCheckoutSession(stripe, {
        orgId: access.org.id,
        plan,
        seats,
        customerId: access.org.stripe_customer_id,
        customerEmail: access.user.email ?? access.org.billing_email,
      });
      res.json({ url: session.url, sessionId: session.sessionId });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/orgs/:org/billing/portal", async (req, res) => {
    const access = await requireOrgAdmin(req, res);
    if (!access) return;
    if (!access.org.stripe_customer_id) {
      res.status(400).json({ error: "No Stripe customer yet — start Checkout first" });
      return;
    }
    try {
      const { createPortalSession, stripeFromEnv } = await import("./billing/stripe.js");
      const stripe = stripeFromEnv(process.env);
      if (!stripe) {
        res.status(503).json({ error: "Stripe is not configured on this host" });
        return;
      }
      const portal = await createPortalSession(stripe, access.org.stripe_customer_id);
      res.json({ url: portal.url });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.patch("/api/orgs/:org/settings", async (req, res) => {
    const access = await requireOrgAdmin(req, res);
    if (!access) return;
    const body = req.body ?? {};
    const updates: string[] = [];
    const params: Array<string | number | null> = [];

    if (typeof body.name === "string" && body.name.trim()) {
      updates.push("name = ?");
      params.push(body.name.trim());
    }
    if (body.projectCreatePolicy === "org_admins_only" || body.projectCreatePolicy === "any_org_member") {
      updates.push("project_create_policy = ?");
      params.push(body.projectCreatePolicy);
    }
    if (typeof body.providerId === "string") {
      if (!isProviderId(body.providerId)) {
        res.status(400).json({ error: "unknown provider" });
        return;
      }
      updates.push("provider_id = ?");
      params.push(body.providerId);
    }
    if (body.customBaseUrl !== undefined) {
      const url = body.customBaseUrl === null || body.customBaseUrl === ""
        ? null
        : String(body.customBaseUrl).trim();
      if (url && !/^https:\/\//i.test(url)) {
        res.status(400).json({ error: "custom base URL must use https" });
        return;
      }
      updates.push("custom_base_url = ?");
      params.push(url);
    }
    if (body.liteModelMode === "use_default" || body.liteModelMode === "override") {
      updates.push("lite_model_mode = ?");
      params.push(body.liteModelMode);
    }
    if (body.liteModel !== undefined) {
      updates.push("lite_model = ?");
      params.push(body.liteModel === null || body.liteModel === "" ? null : String(body.liteModel).trim());
    }
    if (body.thinkingModelMode === "use_default" || body.thinkingModelMode === "override") {
      updates.push("thinking_model_mode = ?");
      params.push(body.thinkingModelMode);
    }
    if (body.thinkingModel !== undefined) {
      updates.push("thinking_model = ?");
      params.push(
        body.thinkingModel === null || body.thinkingModel === ""
          ? null
          : String(body.thinkingModel).trim(),
      );
    }
    if (typeof body.allowProjectModelOverride === "boolean") {
      updates.push("allow_project_model_override = ?");
      params.push(body.allowProjectModelOverride ? 1 : 0);
    }
    if (body.defaultProviderKeyId !== undefined) {
      const keyId = body.defaultProviderKeyId === null || body.defaultProviderKeyId === ""
        ? null
        : String(body.defaultProviderKeyId);
      if (keyId) {
        const exists = await db.prepare(
          "SELECT id FROM org_provider_keys WHERE id = ? AND org_id = ?",
        ).get(keyId, access.org.id);
        if (!exists) {
          res.status(400).json({ error: "default key not found in this org" });
          return;
        }
      }
      updates.push("default_provider_key_id = ?");
      params.push(keyId);
    }
    if (updates.length === 0) {
      res.status(400).json({ error: "no settings to update" });
      return;
    }
    params.push(access.org.id);
    await db.prepare(`UPDATE orgs SET ${updates.join(", ")} WHERE id = ?`).run(...params);
    res.json({ ok: true });
  });

  app.post("/api/orgs/:org/provider-keys", async (req, res) => {
    const access = await requireOrgAdmin(req, res);
    if (!access) return;
    const label = typeof req.body?.label === "string" ? req.body.label.trim() : "";
    const secret = typeof req.body?.secret === "string" ? req.body.secret.trim() : "";
    if (!label || !secret) {
      res.status(400).json({ error: "label and secret required" });
      return;
    }
    let enc: ReturnType<typeof encryptSecret>;
    try {
      enc = encryptSecret(secret, process.env);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
    const id = randomUUID();
    const now = Date.now();
    await db.transaction(async () => {
      await db.prepare(
        `INSERT INTO org_provider_keys
          (id, org_id, label, ciphertext, iv, tag, last4, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, access.org.id, label, enc.ciphertext, enc.iv, enc.tag, enc.last4, now, access.user.userId);
      if (!access.org.default_provider_key_id) {
        await db.prepare("UPDATE orgs SET default_provider_key_id = ? WHERE id = ?").run(id, access.org.id);
      }
    });
    res.status(201).json({
      id,
      label,
      last4: enc.last4,
      createdAt: now,
      isDefault: !access.org.default_provider_key_id || access.org.default_provider_key_id === id,
    });
  });

  app.delete("/api/orgs/:org/provider-keys/:keyId", async (req, res) => {
    const access = await requireOrgAdmin(req, res);
    if (!access) return;
    const keyId = String(req.params.keyId);
    const deleted = await db.prepare(
      "DELETE FROM org_provider_keys WHERE id = ? AND org_id = ?",
    ).run(keyId, access.org.id);
    if (deleted.changes === 0) {
      res.status(404).json({ error: "key not found" });
      return;
    }
    if (access.org.default_provider_key_id === keyId) {
      const next = await db.prepare(
        "SELECT id FROM org_provider_keys WHERE org_id = ? ORDER BY created_at DESC LIMIT 1",
      ).get<{ id: string }>(access.org.id);
      await db.prepare("UPDATE orgs SET default_provider_key_id = ? WHERE id = ?").run(
        next?.id ?? null,
        access.org.id,
      );
    }
    res.json({ ok: true });
  });

  app.post("/api/orgs/:org/provider-keys/:keyId/default", async (req, res) => {
    const access = await requireOrgAdmin(req, res);
    if (!access) return;
    const keyId = String(req.params.keyId);
    const exists = await db.prepare(
      "SELECT id FROM org_provider_keys WHERE id = ? AND org_id = ?",
    ).get(keyId, access.org.id);
    if (!exists) {
      res.status(404).json({ error: "key not found" });
      return;
    }
    await db.prepare("UPDATE orgs SET default_provider_key_id = ? WHERE id = ?").run(keyId, access.org.id);
    res.json({ ok: true });
  });

  app.get("/api/orgs/:org/github", async (req, res) => {
    const access = await requireOrgAccess(req, res);
    if (!access) return;
    const config = githubAppConfig();
    const linked = Boolean(await db.prepare(
      'SELECT id FROM "account" WHERE "userId" = ? AND "providerId" = ?',
    ).get(access.user.userId, "github"));
    let installation = await db.prepare(
      `SELECT installation_id, account_id, account_login, repository_selection FROM github_installations WHERE org_id = ?`,
    ).get<{ installation_id: string; account_id: string; account_login: string; repository_selection: "selected" | "all" }>(access.org.id);
    if (!config || !linked || !installation) {
      res.json({
        configured: Boolean(config),
        linked,
        installation: installation
          ? { id: installation.installation_id, accountLogin: installation.account_login, repositorySelection: installation.repository_selection }
          : null,
        repositories: [],
      });
      return;
    }
    try {
      const loaded = await withGitHubUserToken(access.user.userId, async (token) => {
        const verified = await verifyInstallation(token, installation!.installation_id);
        if (
          installation!.account_id !== verified.accountId ||
          installation!.account_login !== verified.accountLogin ||
          installation!.repository_selection !== verified.repositorySelection
        ) {
          await db.prepare(
            `UPDATE github_installations
                SET account_id = ?, account_login = ?, repository_selection = ?, updated_at = ?
              WHERE org_id = ? AND installation_id = ?`,
          ).run(
            verified.accountId,
            verified.accountLogin,
            verified.repositorySelection,
            Date.now(),
            access.org.id,
            installation!.installation_id,
          );
          installation = {
            ...installation!,
            account_id: verified.accountId,
            account_login: verified.accountLogin,
            repository_selection: verified.repositorySelection,
          };
        }
        const repositories = await listInstallationRepositories(token, installation!.installation_id);
        return { installation: installation!, repositories };
      });
      if (!loaded.ok) {
        // Expired/unrecoverable user token: 200 + reauth shape so the panel can
        // offer Reconnect GitHub instead of a bare 401 ErrorState.
        res.json({
          configured: true,
          linked: false,
          reauthRequired: true,
          installation: {
            id: installation.installation_id,
            accountLogin: installation.account_login,
            repositorySelection: installation.repository_selection,
          },
          repositories: [],
        });
        return;
      }
      res.json({
        configured: true,
        linked: true,
        installation: {
          id: loaded.value.installation.installation_id,
          accountLogin: loaded.value.installation.account_login,
          repositorySelection: loaded.value.installation.repository_selection,
        },
        repositories: loaded.value.repositories,
      });
    } catch (error) {
      githubFailure(res, error);
    }
  });

  app.post("/api/orgs/:org/github/install", async (req, res) => {
    const access = await requireOrgAccess(req, res);
    if (!access) return;
    const config = githubAppConfig();
    if (!config) {
      res.status(409).json({ error: "GitHub App is not configured" });
      return;
    }
    if (!(await githubAccessToken(access.user.userId))) {
      res.status(409).json({ error: "link your GitHub account before installing the GitHub App" });
      return;
    }
    const returnTo = typeof req.body?.returnTo === "string" ? req.body.returnTo : "/dashboard";
    const state = createInstallState(config, access.org.id, access.user.userId, returnTo);
    res.json({ installUrl: installationUrl(config, state) });
  });

  app.get("/api/github/install/callback", async (req, res) => {
    const user = await sessionUserOr401(req, res);
    if (!user) return;
    const config = githubAppConfig();
    if (!config) {
      res.status(409).json({ error: "GitHub App is not configured" });
      return;
    }
    try {
      const state = readInstallState(config, typeof req.query.state === "string" ? req.query.state : "");
      if (state.userId !== user.userId || !(await isOrgMember(db, user.userId, state.orgId))) {
        throw new GitHubAppError(403, "GitHub installation state does not belong to this user and Org");
      }
      const token = await githubAccessToken(user.userId);
      if (!token) throw new GitHubAppError(409, "linked GitHub account is unavailable");
      const installation = await verifyInstallation(
        token,
        typeof req.query.installation_id === "string" ? req.query.installation_id : "",
      );
      const existing = await db.prepare(
        "SELECT org_id FROM github_installations WHERE installation_id = ?",
      ).get<{ org_id: string }>(installation.id);
      if (existing && existing.org_id !== state.orgId) {
        throw new GitHubAppError(409, "GitHub installation is already connected to another Org");
      }
      const current = await db.prepare(
        "SELECT installation_id FROM github_installations WHERE org_id = ?",
      ).get<{ installation_id: string }>(state.orgId);
      if (current && current.installation_id !== installation.id) {
        const bound = await db.prepare(
          "SELECT project_id FROM github_project_repos WHERE installation_id = ? LIMIT 1",
        ).get(current.installation_id);
        if (bound) {
          throw new GitHubAppError(409, "disconnect repository-backed Projects before replacing this installation");
        }
      }
      const now = Date.now();
      await db.prepare(
        `INSERT INTO github_installations
           (installation_id, org_id, account_id, account_login, connected_by, repository_selection, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (org_id) DO UPDATE SET
           installation_id=excluded.installation_id,
           account_id=excluded.account_id,
           account_login=excluded.account_login,
           connected_by=excluded.connected_by,
           repository_selection=excluded.repository_selection,
           updated_at=excluded.updated_at`,
      ).run(
        installation.id,
        state.orgId,
        installation.accountId,
        installation.accountLogin,
        user.userId,
        installation.repositorySelection,
        now,
        now,
      );
      res.redirect(state.returnTo);
    } catch (error) {
      githubFailure(res, error);
    }
  });

  app.post("/api/orgs/:org/github/projects", async (req, res) => {
    const access = await requireOrgAccess(req, res);
    if (!access) return;
    if (!(await assertCanCreateProject(access.org, access.user.userId, res))) return;
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const repositoryId = typeof req.body?.repositoryId === "string" ? req.body.repositoryId : "";
    if (!name || !/^\d+$/.test(repositoryId)) {
      res.status(400).json({ error: "name and repositoryId required" });
      return;
    }
    const connected = await db.prepare(
      "SELECT installation_id FROM github_installations WHERE org_id = ?",
    ).get<{ installation_id: string }>(access.org.id);
    if (!connected) {
      res.status(409).json({ error: "connect the GitHub App to this Org first" });
      return;
    }
    const token = await githubAccessToken(access.user.userId);
    if (!token) {
      res.status(409).json({ error: "linked GitHub account is unavailable" });
      return;
    }
    try {
      await verifyInstallation(token, connected.installation_id);
      const repositories = await listInstallationRepositories(token, connected.installation_id);
      const repository = repositories.find((candidate) => candidate.id === repositoryId);
      if (!repository) throw new GitHubAppError(403, "repository is not selected for this GitHub App installation");
      res.json(await createProjectRecord({
        orgId: access.org.id,
        userId: access.user.userId,
        name,
        repo: repository.fullName,
        github: { installationId: connected.installation_id, repository },
      }));
    } catch (error) {
      githubFailure(res, error);
    }
  });

  // Organization roster: authorize through the derived org-membership seam,
  // then return the actual project memberships as flat rows. The browser
  // groups these rows by person while preserving every project association.
  // Missing and foreign organizations are intentionally indistinguishable.
  app.get("/api/orgs/:org/roster", async (req, res) => {
    const user = await sessionUserOr401(req, res);
    if (!user) return;
    const orgId = String(req.params.org);
    if (!(await isOrgMember(db, user.userId, orgId))) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const org = await db
      .prepare("SELECT id, name FROM orgs WHERE id = ?")
      .get<{ id: string; name: string }>(orgId);
    if (!org) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const members = await db
      .prepare(
        `SELECT u.id AS "userId", u.name, u.email,
                p.id AS "projectId", p.name AS "projectName", m.role, m."createdAt"
         FROM projects p
         JOIN "member" m ON m."organizationId" = p.id
         JOIN "user" u ON u.id = m."userId"
         WHERE p.org_id = ?
         ORDER BY LOWER(u.name), LOWER(u.email), u.id, LOWER(p.name), p.id`,
      )
      .all<{
        userId: string;
        name: string;
        email: string;
        projectId: string;
        projectName: string;
        role: Role;
        createdAt: string | Date;
      }>(orgId);
    res.json({
      org,
      members: members.map((member) => ({
        userId: member.userId,
        name: member.name,
        email: member.email,
        projectId: member.projectId,
        projectName: member.projectName,
        role: member.role,
        joinedAt: toEpochMs(member.createdAt),
      })),
    });
  });

  // Invite a teammate by email. Admin-gated. The invitation row remains the
  // project-scoped, single-use authorization, while Better Auth sends a
  // separate hashed, single-use magic link to the exact invited address. The
  // callback lands on /join and accepts the invitation with that session.
  app.post("/api/p/:project/invite", async (req, res) => {
    const ctx = await requireProjectAdmin(req, res);
    if (!ctx) return;
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const role = req.body?.role === undefined ? "human" : req.body.role;
    if (!email || !isRole(role)) {
      res.status(400).json({ error: "email and a valid role required" });
      return;
    }
    const projectOrg = await db
      .prepare("SELECT org_id FROM projects WHERE id = ?")
      .get<{ org_id: string | null }>(ctx.projectId);
    if (projectOrg?.org_id) {
      const billingOrg = await db
        .prepare(
          "SELECT id, plan, seat_quantity, billing_status FROM orgs WHERE id = ?",
        )
        .get<{ id: string; plan: string | null; seat_quantity: number | null; billing_status: string | null }>(
          projectOrg.org_id,
        );
      if (billingOrg) {
        const { assertCanAddSeat } = await import("./billing/limits.js");
        // Existing org member on another project does not consume a new seat.
        const existingMember = await db
          .prepare(
            `SELECT 1 AS ok
               FROM "member" m
               INNER JOIN projects p ON p.id = m."organizationId"
               INNER JOIN "user" u ON u.id = m."userId"
              WHERE p.org_id = ?
                AND (p.archived_at IS NULL)
                AND lower(u.email) = ?
              LIMIT 1`,
          )
          .get<{ ok: number }>(billingOrg.id, email);
        const gate = await assertCanAddSeat(db, billingOrg, {
          existingOrgMember: Boolean(existingMember),
        });
        if (!gate.ok) {
          res.status(gate.status).json({ error: gate.error });
          return;
        }
      }
    }
    // Unguessable, URL-safe, single-use token. 32 random bytes (256 bits) —
    // never logged, never derived from the email. The row is the only record.
    const token = randomBytes(32).toString("base64url");
    const expiresAtMs = Date.now() + INVITE_TTL_MS;
    const expiresAtIso = new Date(expiresAtMs).toISOString();
    // Reuse better-auth's invitation table (organizationId == projectId). A
    // fresh token supersedes any prior pending invite for the same email.
    await db
      .prepare('DELETE FROM "invitation" WHERE email = ? AND "organizationId" = ? AND status = ?')
      .run(email, ctx.projectId, "pending");
    await db
      .prepare(
        'INSERT INTO "invitation" (id, "organizationId", email, role, status, "expiresAt", "createdAt", "inviterId", token)' +
          " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        randomUUID(),
        ctx.projectId,
        email,
        role,
        "pending",
        expiresAtIso,
        new Date().toISOString(),
        ctx.userId,
        token,
      );
    try {
      await issueMagicLink({
        email,
        name: email.split("@")[0],
        callbackURL: `${joinUrl(req, token)}&auto=1`,
        purpose: "invite",
      });
    } catch {
      await db.prepare('DELETE FROM "invitation" WHERE token = ? AND status = ?').run(token, "pending");
      res.status(503).json({ error: "invitation email unavailable" });
      return;
    }
    res.json({ inviteUrl: joinUrl(req, token), email, role, expiresAt: expiresAtMs, emailSent: true });
  });

  // The project's pending (unexpired) invites — admin-gated — so the team view
  // can re-copy a link (the link is not a secret; the token gates acceptance).
  app.get("/api/p/:project/invites", async (req, res) => {
    const ctx = await requireProjectAdmin(req, res);
    if (!ctx) return;
    const rows = await db
      .prepare(
        'SELECT email, role, token, "expiresAt" FROM "invitation" WHERE "organizationId" = ? AND status = ?',
      )
      .all<{ email: string; role: string; token: string; expiresAt: string }>(ctx.projectId, "pending");
    const now = Date.now();
    const invites = rows
      .filter((r) => new Date(r.expiresAt).getTime() > now)
      .map((r) => ({
        email: r.email,
        role: r.role,
        expiresAt: new Date(r.expiresAt).getTime(),
        inviteUrl: joinUrl(req, r.token),
      }));
    res.json({ invites });
  });

  // ===================================================================
  // Join-link flow. GET renders the invitation; accept attaches the current
  // magic-link session to the project.
  // ===================================================================

  /** A live (pending + unexpired) invitation for a token, or null. */
  async function liveInvitation(token: string): Promise<{
    email: string;
    role: Role;
    status: string;
    projectId: string;
    projectName: string;
    expired: boolean;
    consumed: boolean;
  } | null> {
    if (!authFor(db) || !token) return null;
    const row = await db
      .prepare(
        'SELECT i.email, i.role, i.status, i."organizationId" AS "projectId", i."expiresAt", p.name AS "projectName"' +
          ' FROM "invitation" i JOIN projects p ON p.id = i."organizationId" WHERE i.token = ?',
      )
      .get<{
        email: string;
        role: Role;
        status: string;
        projectId: string;
        expiresAt: string;
        projectName: string;
      }>(token);
    if (!row) return null;
    return {
      email: row.email,
      role: row.role,
      status: row.status,
      projectId: row.projectId,
      projectName: row.projectName,
      expired: new Date(row.expiresAt).getTime() <= Date.now(),
      consumed: row.status !== "pending",
    };
  }

  // The join page reads this to render "you've been invited to <project> as
  // <email>". Unknown / expired / already-consumed tokens are all 404 — a
  // dead link is indistinguishable from one that never existed.
  app.get("/api/invite/:token", async (req, res) => {
    const inv = await liveInvitation(String(req.params.token));
    if (!inv || inv.expired || inv.consumed) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const existing = await db
      .prepare('SELECT id FROM "user" WHERE email = ?')
      .get<{ id: string }>(inv.email);
    res.json({
      project: { id: inv.projectId, name: inv.projectName },
      email: inv.email,
      role: inv.role,
      status: inv.status,
      hasAccount: !!existing,
    });
  });

  // Accept an invite only with a Better Auth session for the exact invited
  // address. The magic-link verifier creates the user when needed, sets the
  // session cookie, and atomically consumes its own verification token before
  // this endpoint is reached.
  app.post("/api/invite/:token/accept", async (req, res) => {
    const token = String(req.params.token);
    const inv = await liveInvitation(token);
    if (!inv) {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (inv.expired || inv.consumed) {
      res.status(410).json({ error: "this invite has expired or already been used" });
      return;
    }
    const sessionUser = await resolveSessionUser(db, req.headers);
    if (!sessionUser || sessionUser.email?.toLowerCase() !== inv.email.toLowerCase()) {
      res.status(400).json({ error: "sign in with the invited email using its magic link" });
      return;
    }
    const userId = sessionUser.userId;

    // Seat re-check on accept (members only): create-time gate reserved capacity
    // via pending invites. Accept converts the reservation — reject only when
    // filled seats already meet/exceed the cap (or past_due / unpaid).
    const acceptProjectOrg = await db
      .prepare("SELECT org_id FROM projects WHERE id = ?")
      .get<{ org_id: string | null }>(inv.projectId);
    if (acceptProjectOrg?.org_id) {
      const billingOrg = await db
        .prepare(
          "SELECT id, plan, seat_quantity, billing_status FROM orgs WHERE id = ?",
        )
        .get<{ id: string; plan: string | null; seat_quantity: number | null; billing_status: string | null }>(
          acceptProjectOrg.org_id,
        );
      if (billingOrg) {
        const {
          countOrgSeats,
          hasActivePaidPlan,
          maxSeats: seatCap,
          userHasOrgSeat,
          writesBlocked,
        } = await import("./billing/limits.js");
        if (writesBlocked(billingOrg)) {
          res.status(402).json({
            error: "Billing past due — update payment method in Org Settings before joining.",
          });
          return;
        }
        if (!hasActivePaidPlan(billingOrg)) {
          res.status(402).json({
            error: "Set up billing in Org Settings (Checkout) before accepting invites.",
          });
          return;
        }
        const alreadySeated = await userHasOrgSeat(db, billingOrg.id, userId);
        if (!alreadySeated) {
          const cap = seatCap(billingOrg);
          if (cap !== null) {
            const filled = await countOrgSeats(db, billingOrg.id);
            if (filled >= cap) {
              res.status(402).json({
                error: `Seat limit reached (${filled}/${cap}). Upgrade plan or add seats in billing.`,
              });
              return;
            }
          }
        }
      }
    }

    // Attach membership at the invited role (idempotent — no duplicate rows, no
    // escalation: the role is the invite's, not anything the caller supplied).
    const member = await db
      .prepare('SELECT id FROM "member" WHERE "userId" = ? AND "organizationId" = ?')
      .get<{ id: string }>(userId, inv.projectId);
    if (member) {
      await db.prepare('UPDATE "member" SET role = ? WHERE id = ?').run(inv.role, member.id);
    } else {
      await db
        .prepare(
          'INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES (?, ?, ?, ?, ?)',
        )
        .run(randomUUID(), inv.projectId, userId, inv.role, new Date().toISOString());
    }
    // Consume the single-use token (guarded on pending so a race cannot double-accept).
    const consumed = await db
      .prepare('UPDATE "invitation" SET status = ? WHERE token = ? AND status = ?')
      .run("accepted", token, "pending");
    if (consumed.changes === 1) {
      const joined = await db.prepare('SELECT name FROM "user" WHERE id=?').get<{ name: string }>(userId);
      await requestKnowledgeRefresh(
        inv.projectId,
        ["team-people", "roles-collaboration"],
        `member ${joined?.name ?? sessionUser.name} joined with role ${inv.role}`,
      );
    }

    res.json({ ok: true, project: { id: inv.projectId, name: inv.projectName }, signedIn: true });
  });

  // Project inference overrides (provider key + optional model ids).
  app.get("/api/p/:project/inference", async (req, res) => {
    const user = await sessionUserOr401(req, res);
    if (!user) return;
    const projectId = String(req.params.project);
    const member = await db
      .prepare(
        'SELECT m.role FROM "member" m WHERE m."userId" = ? AND m."organizationId" = ?',
      )
      .get<{ role: string }>(user.userId, projectId);
    if (!member) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const project = await db
      .prepare(
        `SELECT p.id, p.org_id, p.provider_key_mode, p.provider_key_id, p.project_key_last4,
                p.lite_model_mode, p.lite_model, p.thinking_model_mode, p.thinking_model,
                o.allow_project_model_override, o.default_provider_key_id
           FROM projects p
           LEFT JOIN orgs o ON o.id = p.org_id
          WHERE p.id = ?`,
      )
      .get<{
        id: string;
        org_id: string | null;
        provider_key_mode: string | null;
        provider_key_id: string | null;
        project_key_last4: string | null;
        lite_model_mode: string | null;
        lite_model: string | null;
        thinking_model_mode: string | null;
        thinking_model: string | null;
        allow_project_model_override: number | null;
        default_provider_key_id: string | null;
      }>(projectId);
    if (!project) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const orgKeys = project.org_id
      ? await db.prepare(
        `SELECT id, label, last4 FROM org_provider_keys WHERE org_id = ? ORDER BY created_at DESC`,
      ).all<{ id: string; label: string; last4: string }>(project.org_id)
      : [];
    res.json({
      providerKeyMode: project.provider_key_mode ?? "inherit",
      providerKeyId: project.provider_key_id,
      projectKeyLast4: project.project_key_last4,
      allowProjectModelOverride: Number(project.allow_project_model_override ?? 0) === 1,
      liteModelMode: project.lite_model_mode,
      liteModel: project.lite_model,
      thinkingModelMode: project.thinking_model_mode,
      thinkingModel: project.thinking_model,
      orgKeys: orgKeys.map((k) => ({
        id: k.id,
        label: k.label,
        last4: k.last4,
        isDefault: k.id === project.default_provider_key_id,
      })),
    });
  });

  app.patch("/api/p/:project/inference", async (req, res) => {
    const ctx = await requireProjectAdmin(req, res);
    if (!ctx) return;
    const project = await db
      .prepare(
        `SELECT p.id, p.org_id, o.allow_project_model_override
           FROM projects p LEFT JOIN orgs o ON o.id = p.org_id WHERE p.id = ?`,
      )
      .get<{ id: string; org_id: string | null; allow_project_model_override: number | null }>(
        ctx.projectId,
      );
    if (!project) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const body = req.body ?? {};
    const updates: string[] = [];
    const params: Array<string | number | null> = [];

    if (body.providerKeyMode === "inherit" || body.providerKeyMode === "org_key" || body.providerKeyMode === "project_secret") {
      updates.push("provider_key_mode = ?");
      params.push(body.providerKeyMode);
    }
    if (body.providerKeyId !== undefined) {
      const keyId = body.providerKeyId === null || body.providerKeyId === ""
        ? null
        : String(body.providerKeyId);
      if (keyId && project.org_id) {
        const exists = await db.prepare(
          "SELECT id FROM org_provider_keys WHERE id = ? AND org_id = ?",
        ).get(keyId, project.org_id);
        if (!exists) {
          res.status(400).json({ error: "org key not found" });
          return;
        }
      }
      updates.push("provider_key_id = ?");
      params.push(keyId);
    }
    if (typeof body.projectSecret === "string" && body.projectSecret.trim()) {
      let enc: ReturnType<typeof encryptSecret>;
      try {
        enc = encryptSecret(body.projectSecret.trim(), process.env);
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        return;
      }
      updates.push(
        "project_key_ciphertext = ?",
        "project_key_iv = ?",
        "project_key_tag = ?",
        "project_key_last4 = ?",
        "provider_key_mode = ?",
      );
      params.push(enc.ciphertext, enc.iv, enc.tag, enc.last4, "project_secret");
    }
    if (body.clearProjectSecret === true) {
      updates.push(
        "project_key_ciphertext = ?",
        "project_key_iv = ?",
        "project_key_tag = ?",
        "project_key_last4 = ?",
      );
      params.push(null, null, null, null);
      if (body.providerKeyMode === undefined) {
        updates.push("provider_key_mode = ?");
        params.push("inherit");
      }
    }

    const allowModels = Number(project.allow_project_model_override ?? 0) === 1;
    if (allowModels) {
      if (body.liteModelMode === "use_default" || body.liteModelMode === "override" || body.liteModelMode === null) {
        updates.push("lite_model_mode = ?");
        params.push(body.liteModelMode);
      }
      if (body.liteModel !== undefined) {
        updates.push("lite_model = ?");
        params.push(body.liteModel === null || body.liteModel === "" ? null : String(body.liteModel).trim());
      }
      if (body.thinkingModelMode === "use_default" || body.thinkingModelMode === "override" || body.thinkingModelMode === null) {
        updates.push("thinking_model_mode = ?");
        params.push(body.thinkingModelMode);
      }
      if (body.thinkingModel !== undefined) {
        updates.push("thinking_model = ?");
        params.push(
          body.thinkingModel === null || body.thinkingModel === ""
            ? null
            : String(body.thinkingModel).trim(),
        );
      }
    } else if (
      body.liteModelMode !== undefined
      || body.liteModel !== undefined
      || body.thinkingModelMode !== undefined
      || body.thinkingModel !== undefined
    ) {
      res.status(403).json({ error: "org does not allow project model overrides" });
      return;
    }

    if (updates.length === 0) {
      res.status(400).json({ error: "no inference settings to update" });
      return;
    }
    params.push(ctx.projectId);
    await db.prepare(`UPDATE projects SET ${updates.join(", ")} WHERE id = ?`).run(...params);
    res.json({ ok: true });
  });

  // Change a member's role. Admin-gated; enforced through the better-auth member row.
  app.post("/api/p/:project/members/:userId/role", async (req, res) => {
    const ctx = await requireProjectAdmin(req, res);
    if (!ctx) return;
    const role = req.body?.role;
    if (!isRole(role)) {
      res.status(400).json({ error: "valid role required" });
      return;
    }
    const target = String(req.params.userId);
    const row = await db
      .prepare(`SELECT m.id, m.role, u.name
                  FROM "member" m JOIN "user" u ON u.id=m."userId"
                 WHERE m."userId" = ? AND m."organizationId" = ?`)
      .get<{ id: string; role: string; name: string }>(target, ctx.projectId);
    if (!row) {
      res.status(404).json({ error: "member not found" });
      return;
    }
    const changed = row.role === role
      ? { changes: 0 }
      : await db.prepare('UPDATE "member" SET role = ? WHERE id = ?').run(role, row.id);
    if (changed.changes === 1) {
      await requestKnowledgeRefresh(
        ctx.projectId,
        ["team-people", "roles-collaboration"],
        `member ${row.name} role changed from ${row.role} to ${role}`,
      );
    }
    res.json({ userId: target, role });
  });

  // Remove a member from the project. Admin-gated.
  app.delete("/api/p/:project/members/:userId", async (req, res) => {
    const ctx = await requireProjectAdmin(req, res);
    if (!ctx) return;
    const target = String(req.params.userId);
    const removing = await db.prepare(
      `SELECT u.name, m.role FROM "member" m JOIN "user" u ON u.id=m."userId"
        WHERE m."userId"=? AND m."organizationId"=?`,
    ).get<{ name: string; role: string }>(target, ctx.projectId);
    const removed = await db
      .prepare('DELETE FROM "member" WHERE "userId" = ? AND "organizationId" = ?')
      .run(target, ctx.projectId);
    if (removed.changes === 1) {
      await requestKnowledgeRefresh(
        ctx.projectId,
        ["team-people", "roles-collaboration"],
        `member ${removing?.name ?? target} (${removing?.role ?? "unknown role"}) removed from project`,
      );
    }
    res.json({ ok: true });
  });

  // Soft-delete (archive) a project for 30 days. Exact-name confirmation.
  // Hard purge runs via archive poller after retention; restore while archived.
  app.delete("/api/p/:project", async (req, res) => {
    const ctx = await requireProjectAdmin(req, res, true);
    if (!ctx) return;
    const projectSql = projectDeleteRowLockSql(
      db.dialect,
      "SELECT name, archived_at FROM projects WHERE id = ?",
    );
    const project = await db
      .prepare(projectSql)
      .get<{ name: string; archived_at: number | null }>(ctx.projectId);
    if (!project || project.archived_at != null) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const confirmation = typeof req.body?.name === "string" ? req.body.name : "";
    if (confirmation !== project.name) {
      res.status(400).json({ error: "project name does not match" });
      return;
    }
    await softArchiveProject(db, ctx.projectId, ctx.userId);
    queue.notifyChanged(ctx.projectId);
    res.json({
      ok: true,
      archivedProjectId: ctx.projectId,
      retentionDays: 30,
      message: "Project archived for 30 days, then permanently deleted. Restore from Org settings while archived.",
    });
  });

  app.post("/api/p/:project/restore", async (req, res) => {
    const ctx = await requireProjectAdmin(req, res);
    if (!ctx) return;
    // Admin may restore even when memberships hide archived projects — load by id.
    const project = await db
      .prepare("SELECT id, name, archived_at FROM projects WHERE id = ?")
      .get<{ id: string; name: string; archived_at: number | null }>(ctx.projectId);
    if (!project || project.archived_at == null) {
      res.status(404).json({ error: "not found or not archived" });
      return;
    }
    // requireProjectAdmin uses member join which filters live-only — so for
    // archived projects we authorize via created_by or org creator separately.
    const outcome = await restoreProject(db, ctx.projectId);
    if (outcome === "expired") {
      res.status(410).json({ error: "archive window expired; project will be purged" });
      return;
    }
    if (outcome === "not_found") {
      res.status(404).json({ error: "not found or not archived" });
      return;
    }
    queue.notifyChanged(ctx.projectId);
    res.json({ ok: true, restoredProjectId: ctx.projectId });
  });

  // Soft-delete entire org (org creator) — cascades archive to all live projects.
  app.delete("/api/orgs/:org", async (req, res) => {
    const access = await requireOrgAccess(req, res);
    if (!access) return;
    const org = await db
      .prepare("SELECT id, name, created_by, archived_at FROM orgs WHERE id = ?")
      .get<{ id: string; name: string; created_by: string | null; archived_at: number | null }>(
        access.org.id,
      );
    if (!org || org.archived_at != null) {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (org.created_by !== access.user.userId) {
      res.status(403).json({ error: "Org admin required" });
      return;
    }
    const confirmation = typeof req.body?.name === "string" ? req.body.name : "";
    if (confirmation !== org.name) {
      res.status(400).json({ error: "org name does not match" });
      return;
    }
    const { projectIds } = await softArchiveOrg(db, org.id, access.user.userId);
    for (const id of projectIds) queue.notifyChanged(id);
    res.json({
      ok: true,
      archivedOrgId: org.id,
      archivedProjectIds: projectIds,
      retentionDays: 30,
    });
  });

  app.post("/api/orgs/:org/restore", async (req, res) => {
    const user = await sessionUserOr401(req, res);
    if (!user) return;
    const orgId = String(req.params.org);
    const org = await db
      .prepare("SELECT id, created_by, archived_at FROM orgs WHERE id = ?")
      .get<{ id: string; created_by: string | null; archived_at: number | null }>(orgId);
    if (!org || org.archived_at == null) {
      res.status(404).json({ error: "not found or not archived" });
      return;
    }
    if (org.created_by !== user.userId) {
      res.status(403).json({ error: "Org admin required" });
      return;
    }
    const outcome = await restoreOrg(db, orgId);
    if (outcome === "expired") {
      res.status(410).json({ error: "archive window expired" });
      return;
    }
    if (outcome === "not_found") {
      res.status(404).json({ error: "not found or not archived" });
      return;
    }
    res.json({ ok: true, restoredOrgId: orgId });
  });

  // Archived projects in an org (for restore UI). Creator-only.
  app.get("/api/orgs/:org/archived-projects", async (req, res) => {
    const user = await sessionUserOr401(req, res);
    if (!user) return;
    const orgId = String(req.params.org);
    const org = await db
      .prepare("SELECT id, created_by FROM orgs WHERE id = ?")
      .get<{ id: string; created_by: string | null }>(orgId);
    if (!org || org.created_by !== user.userId) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const projects = await db
      .prepare(
        `SELECT id, name, archived_at, archived_by FROM projects
          WHERE org_id = ? AND archived_at IS NOT NULL
          ORDER BY archived_at DESC`,
      )
      .all<{ id: string; name: string; archived_at: number; archived_by: string | null }>(orgId);
    res.json({
      projects: projects.map((p) => ({
        id: p.id,
        name: p.name,
        archivedAt: p.archived_at,
        archivedBy: p.archived_by,
        purgeAt: p.archived_at + 30 * 24 * 60 * 60 * 1000,
      })),
    });
  });

  // Mint a headless API key for the signed-in caller — so coders need no seeded
  // static token. Scoped to a project the caller belongs to; the key resolves
  // back to the caller's matching membership. The key is tagged in better-auth
  // metadata with { projectId, type } so the Tokens screen can list/scope it and tell a
  // coder key from a human one. The plaintext secret is returned once, never
  // stored client-side and never revealed again.
  app.post("/api/p/:project/api-keys", async (req, res) => {
    // Admin-only mint: any project member minting seats is an insider abuse vector.
    const ctx = await requireProjectAdmin(req, res);
    if (!ctx) return;
    const projectId = ctx.projectId;
    if (!authApi()) {
      res.status(409).json({ error: "better-auth unavailable on this backend" });
      return;
    }
    const type: TokenType = req.body?.type === "coder" ? "coder" : "human";
    const requestedName = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const name = requestedName && requestedName.toLowerCase() !== type
      ? requestedName
      : `${type === "coder" ? "Coder" : "Human"} seat ${randomBytes(3).toString("hex").toUpperCase()}`;
    const clarificationMode: ClarificationMode = "text";
    const created = await mintSeatKey(ctx.userId, projectId, type, name);
    res.json({
      id: created.keyId,
      name: created.name,
      type,
      clarificationMode,
      start: created.start,
      createdAt: created.createdAt,
      key: created.key, // the one-time secret
    });
  });

  // CLI login loopback (D3): authorize (session → code) + token (code → operator key).
  registerCliAuth(app, { db, sessionUserOr401, mintOperatorKey });

  // Part A — seat enrollment grants (mint admin-only, redeem public single-use).
  // Reuses mintSeatKey so an enrolled seat is identical to a directly minted one.
  // The admin gate accepts a browser session OR a Bearer operator token, so the
  // CLI mints its own enrollments once the operator has run `memracer login`.
  registerSeatEnrollment(app, {
    db,
    requireProjectAdmin: requireProjectAdminOrOperator,
    publicBaseUrl: () => resolvePublicUrl(),
    projectName: async (d, pid) =>
      (await d.prepare("SELECT name FROM projects WHERE id = ?").get<{ name: string }>(pid))?.name ?? pid,
    roleIsWorker: async (d, pid, role) => (await roleKind(d, pid, role)) === "worker",
    mintSeat: (_d, a) => mintSeatKey(a.userId, a.projectId, a.role, a.name),
  });

  // Part F3 — custom roles. An admin defines project roles; any member reads
  // them. A role's kind ('human'|'worker') selects the seat's tool surface at
  // auth time, so a custom worker role reuses the coder surface transparently.
  app.get("/api/p/:project/roles", async (req, res) => {
    const user = await sessionUserOr401(req, res);
    if (!user) return;
    const projectId = String(req.params.project);
    const member = await db
      .prepare('SELECT id FROM "member" WHERE "userId" = ? AND "organizationId" = ?')
      .get<{ id: string }>(user.userId, projectId);
    if (!member) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(await listRoles(db, projectId));
  });

  app.post("/api/p/:project/roles", async (req, res) => {
    const ctx = await requireProjectAdmin(req, res);
    if (!ctx) return;
    const slug = typeof req.body?.slug === "string" ? req.body.slug.trim() : "";
    const kind = req.body?.kind;
    const displayName = typeof req.body?.displayName === "string" ? req.body.displayName.trim() : "";
    const systemPrompt = typeof req.body?.systemPrompt === "string" ? req.body.systemPrompt : null;
    const model = typeof req.body?.model === "string" ? req.body.model : null;
    if (!/^[a-z][a-z0-9-]*$/.test(slug)) {
      res.status(400).json({ error: "slug must match /^[a-z][a-z0-9-]*$/" });
      return;
    }
    if (kind !== "human" && kind !== "worker") {
      res.status(400).json({ error: "kind must be 'human' or 'worker'" });
      return;
    }
    if (!displayName) {
      res.status(400).json({ error: "displayName required" });
      return;
    }
    const existing = await db
      .prepare("SELECT slug FROM roles WHERE project_id = ? AND slug = ?")
      .get<{ slug: string }>(ctx.projectId, slug);
    if (existing) {
      res.status(409).json({ error: "role slug already exists" });
      return;
    }
    const now = Date.now();
    await db
      .prepare(
        `INSERT INTO roles
           (project_id, slug, kind, display_name, system_prompt, model, always_available, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(ctx.projectId, slug, kind, displayName, systemPrompt, model, 0, now);
    res.json({
      projectId: ctx.projectId,
      slug,
      kind,
      displayName,
      systemPrompt,
      model,
      alwaysAvailable: false,
      createdAt: now,
    });
  });

  // Project-wide MCP seat readiness for Operations Get started (counts only).
  app.get("/api/p/:project/seat-readiness", async (req, res) => {
    const user = await sessionUserOr401(req, res);
    if (!user) return;
    const projectId = String(req.params.project);
    const member = await db
      .prepare('SELECT id FROM "member" WHERE "userId" = ? AND "organizationId" = ?')
      .get<{ id: string }>(user.userId, projectId);
    if (!member) {
      res.status(404).json({ error: "not found" });
      return;
    }
    let humanSeats = 0;
    let coderSeats = 0;
    // Prefer project-scoped metadata rows (LIKE prefilter + parse); still parse
    // authoritatively so corrupt JSON cannot inflate counts.
    const apikeyRows = await db
      .prepare(
        `SELECT metadata FROM apikey
          WHERE metadata LIKE ? OR metadata LIKE ?`,
      )
      .all<{ metadata: string | null }>(
        `%"projectId":"${projectId}"%`,
        `%"projectId": "${projectId}"%`,
      );
    for (const row of apikeyRows) {
      const meta = parseKeyMetadata(row.metadata);
      if (meta.projectId !== projectId) continue;
      // Align with api-keys list: missing type counts as human.
      if (meta.type === "coder") coderSeats += 1;
      else humanSeats += 1;
      if (humanSeats >= 1 && coderSeats >= 1) break;
    }
    if (humanSeats < 1 || coderSeats < 1) {
      const oauthRows = await db
        .prepare(
          `SELECT role, COUNT(*) AS n FROM oauth_seats
            WHERE project_id = ? AND revoked_at IS NULL
            GROUP BY role`,
        )
        .all<{ role: string; n: number }>(projectId);
      for (const row of oauthRows) {
        const n = Number(row.n) || 0;
        if (row.role === "coder") coderSeats += n;
        else if (row.role === "human") humanSeats += n;
      }
    }
    const taskRow = await db
      .prepare("SELECT 1 AS ok FROM tasks WHERE project_id = ? LIMIT 1")
      .get<{ ok: number }>(projectId);
    const hasTaskHistory = Boolean(taskRow);
    const factoryReady = humanSeats >= 1 && coderSeats >= 1;
    // Frigg only grooms once the org has an active paid plan. Seats mint free,
    // so surface this as an onboarding gate rather than blocking seat creation.
    const projectOrg = await db
      .prepare("SELECT org_id FROM projects WHERE id = ?")
      .get<{ org_id: string | null }>(projectId);
    let friggReady = false;
    if (projectOrg?.org_id) {
      const billingOrg = await db
        .prepare("SELECT id, plan, seat_quantity, billing_status FROM orgs WHERE id = ?")
        .get<{ id: string; plan: string | null; seat_quantity: number | null; billing_status: string | null }>(
          projectOrg.org_id,
        );
      if (billingOrg) {
        const { friggAllowed } = await import("./billing/limits.js");
        friggReady = friggAllowed(billingOrg);
      }
    }
    res.json({ factoryReady, humanSeats, coderSeats, hasTaskHistory, friggReady });
  });

  // Project-wide seat liveness for the CLI `memracer ps`. Member-guarded
  // (mirrors the api-keys auth). A seat is "live" if its key authenticated in
  // the last 2 minutes. Project-scoped via the apikey metadata (LIKE prefilter +
  // authoritative parse), so it covers every teammate's seats, not just the
  // caller's.
  app.get("/api/p/:project/seats/live", async (req, res) => {
    const projectId = String(req.params.project);
    // Accept a browser session OR a Bearer operator token (CLI `memracer ps`).
    const session = await resolveSessionUser(db, req.headers);
    if (session) {
      const member = await db
        .prepare('SELECT id FROM "member" WHERE "userId" = ? AND "organizationId" = ?')
        .get<{ id: string }>(session.userId, projectId);
      if (!member) {
        res.status(404).json({ error: "not found" });
        return;
      }
    } else {
      const attribution = { sourceIp: requestSourceIp(req.headers, req.socket.remoteAddress) };
      const operator = await resolveMember(db, req.header("authorization"), attribution);
      if (!operator) {
        res.status(401).json({ error: "sign in required" });
        return;
      }
      if (!operator.memberships.some((m) => m.projectId === projectId)) {
        res.status(404).json({ error: "not found" });
        return;
      }
    }
    const rows = await db
      .prepare(
        `SELECT id, name, metadata, "lastRequest" FROM apikey
          WHERE metadata LIKE ? OR metadata LIKE ?`,
      )
      .all<{ id: string; name: string | null; metadata: string | null; lastRequest: string | null }>(
        `%"projectId":"${projectId}"%`,
        `%"projectId": "${projectId}"%`,
      );
    const now = Date.now();
    const seats = rows
      .map((r) => ({ ...r, meta: parseKeyMetadata(r.metadata) }))
      .filter((r) => r.meta.projectId === projectId)
      .map((r) => {
        const lastRequest = toEpochMs(r.lastRequest);
        return {
          keyId: r.id,
          role: (r.meta.type ?? "human") as TokenType,
          name: r.name,
          lastRequest,
          live: (lastRequest ?? 0) > now - 120000,
        };
      });
    res.json(seats);
  });

  // The caller's tokens for this project — never the secret. A key is an apikey
  // row owned by the caller (referenceId) whose metadata pins it to this project.
  app.get("/api/p/:project/api-keys", async (req, res) => {
    // Accept a browser session OR a Bearer operator token (CLI `seat ls`).
    // Both resolve to member.userId; the query stays scoped to that owner, so
    // an operator only ever sees the seats they own.
    const caller = await memberFor(db, req, false);
    if (!caller?.userId) {
      res.status(401).json({ error: "sign in required" });
      return;
    }
    const projectId = String(req.params.project);
    const member = await db
      .prepare('SELECT id FROM "member" WHERE "userId" = ? AND "organizationId" = ?')
      .get<{ id: string }>(caller.userId, projectId);
    if (!member) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const rows = await db
      .prepare('SELECT id, name, start, metadata, "createdAt", "lastRequest" FROM apikey WHERE "referenceId" = ?')
      .all<{ id: string; name: string | null; start: string | null; metadata: string | null; createdAt: string; lastRequest: string | null }>(
        caller.userId,
      );
    const staticKeys = rows
      .map((r) => ({ ...r, meta: parseKeyMetadata(r.metadata) }))
      .filter((r) => r.meta.projectId === projectId)
      .map((r) => {
        const type = (r.meta.type ?? "human") as TokenType;
        const prefix = r.id.slice(0, 8);
        const storedName = r.name?.trim();
        return {
          id: r.id,
          authMethod: "static" as const,
          name: storedName && storedName.toLowerCase() !== type
            ? storedName
            : `${type === "coder" ? "Coder" : "Human"} seat ${prefix}`,
          type,
          clarificationMode: "text" as const,
          prefix,
          createdAt: toEpochMs(r.createdAt),
          lastUsedAt: toEpochMs(r.lastRequest),
        };
      });
    const oauthKeys = await db.prepare(
      `SELECT id, name, role, created_at, last_used_at
         FROM oauth_seats
        WHERE user_id = ? AND project_id = ? AND revoked_at IS NULL
        ORDER BY created_at`,
    ).all<{ id: string; name: string; role: TokenType; created_at: number; last_used_at: number | null }>(
      caller.userId, projectId,
    );
    const keys = [...staticKeys, ...oauthKeys.map((seat) => ({
      id: seat.id,
      authMethod: "oauth" as const,
      name: seat.name,
      type: seat.role,
      clarificationMode: "text" as const,
      prefix: "OAuth",
      createdAt: seat.created_at,
      lastUsedAt: seat.last_used_at,
    }))];
    res.json({ keys });
  });

  // Retired clarification-mode endpoint: all seats deliver queued text.
  app.patch("/api/p/:project/api-keys/:id", async (req, res) => {
    const user = await sessionUserOr401(req, res);
    if (!user) return;
    const projectId = String(req.params.project);
    const keyId = String(req.params.id);
    const hasRequestedName = typeof req.body?.name === "string";
    const requestedName = hasRequestedName ? req.body.name.trim() : "";
    if (hasRequestedName) {
      if (!requestedName || requestedName.length > 80) {
        res.status(400).json({ error: "seat name must be between 1 and 80 characters" });
        return;
      }
      const staticRow = await db.prepare(
        `SELECT metadata FROM apikey WHERE id = ? AND "referenceId" = ?`,
      ).get<{ metadata: string | null }>(keyId, user.userId);
      if (staticRow && parseKeyMetadata(staticRow.metadata).projectId === projectId) {
        await db.prepare("UPDATE apikey SET name = ? WHERE id = ?").run(requestedName, keyId);
        res.json({ id: keyId, name: requestedName });
        return;
      }
      const oauthRenamed = await db.prepare(
        `UPDATE oauth_seats SET name = ?, updated_at = ?
          WHERE id = ? AND user_id = ? AND project_id = ? AND revoked_at IS NULL`,
      ).run(requestedName, Date.now(), keyId, user.userId, projectId);
      if (oauthRenamed.changes > 0) {
        res.json({ id: keyId, name: requestedName });
        return;
      }
      res.status(404).json({ error: "not found" });
      return;
    }
    const row = await db
      .prepare('SELECT "referenceId", metadata FROM apikey WHERE id = ?')
      .get<{ referenceId: string; metadata: string | null }>(keyId);
    const meta = parseKeyMetadata(row?.metadata ?? null);
    if (
      !row ||
      row.referenceId !== user.userId ||
      meta.projectId !== projectId ||
      (meta.type ?? "human") !== "human"
    ) {
      res.status(404).json({ error: "not found" });
      return;
    }
    await db
      .prepare("UPDATE apikey SET metadata = ? WHERE id = ?")
      .run(JSON.stringify({ ...meta, clarificationMode: "text" }), keyId);
    res.json({ id: keyId, clarificationMode: "text" });
  });

  // Revoke a token. Ownership (referenceId) and project (metadata) are verified
  // before the row is deleted; a mismatch is a 404, indistinguishable from a key
  // that never existed. Deleting the apikey row IS the revocation.
  app.delete("/api/p/:project/api-keys/:id", async (req, res) => {
    // Accept a browser session OR a Bearer operator token (CLI `seat revoke`).
    // Ownership stays pinned to caller.userId (referenceId / oauth user_id), so
    // an operator can only revoke the seats they own — a mismatch is a 404.
    const caller = await memberFor(db, req, false);
    if (!caller?.userId) {
      res.status(401).json({ error: "sign in required" });
      return;
    }
    const projectId = String(req.params.project);
    const keyId = String(req.params.id);
    const row = await db
      .prepare('SELECT "referenceId", metadata FROM apikey WHERE id = ?')
      .get<{ referenceId: string; metadata: string | null }>(keyId);
    const meta = parseKeyMetadata(row?.metadata ?? null);
    if (row && row.referenceId === caller.userId && meta.projectId === projectId) {
      await db.prepare("DELETE FROM apikey WHERE id = ?").run(keyId);
      res.json({ ok: true });
      return;
    }
    const revoked = await db.prepare(
      `UPDATE oauth_seats SET revoked_at = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND project_id = ? AND revoked_at IS NULL`,
    ).run(Date.now(), Date.now(), keyId, caller.userId, projectId);
    if (revoked.changes === 0) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json({ ok: true });
  });

  // A project's team (#73): its better-auth members and roles (organization =
  // project, 1:1 by id). Read-only; membership-scoped.
  app.get(
    "/api/p/:project/team",
    scoped(false, async (_req, res, _member, membership) => {
      const projectId = membership.projectId;
      const byName = new Map<
        string,
        { name: string; role: string; email: string | null; userId: string | null; joinedAt: number | null }
      >();
      if (authFor(db)) {
        const rows = await db
          .prepare(
            `SELECT u.id AS "userId", u.name AS name, u.email AS email, m.role AS role, m."createdAt"
             FROM "member" m JOIN "user" u ON u.id = m."userId"
             WHERE m."organizationId" = ? ORDER BY u.name`,
          )
          .all<{ userId: string; name: string; email: string | null; role: string; createdAt: string | Date }>(projectId);
        for (const m of rows)
          byName.set(m.name, { name: m.name, role: m.role, email: m.email, userId: m.userId, joinedAt: toEpochMs(m.createdAt) });
      }
      res.json({ members: [...byName.values()] });
    }),
  );

  app.get(
    "/api/p/:project/analytics",
    scoped(false, async (req, res, _member, membership) => {
      const requested = typeof req.query.period === "string" ? req.query.period : "7d";
      const period: AnalyticsPeriod = requested === "24h" || requested === "30d" || requested === "all" ? requested : "7d";
      res.json(await loadProjectAnalytics(db, membership.projectId, period));
    }),
  );

  app.get(
    "/api/p/:project/queue",
    scoped(false, async (req, res, _member, membership) => {
      const since = Date.now() - OVERVIEW_WINDOW_MS;
      const limit = pageLimit(req);
      const cursor = decodeCursor(req, "queue");
      const cursorDone = numericCursorValue(cursor, "done");
      const cursorPriority = numericCursorValue(cursor, "priority");
      const cursorId = numericCursorValue(cursor, "id");
      const hasCursor = cursorDone !== null && cursorPriority !== null && cursorId !== null;
      const taskRows = await db
        .prepare(
          `SELECT t.id, t.title, t.body, t.priority, t.state, t.base_sha, t.repo,
                  t.submitted_by, t.lease_agent, t.lease_expires_at,
                  t.result_summary, t.result_pr_url, t.result_pr_number, t.pr_verification,
                  t.grooming_rationale, t.parent_id, t.plan, t.plan_deadline, t.queued_at,
                  p.title AS parent_title, p.submitted_by AS parent_submitted_by,
                  t.incubate_until, t.hold_cause, t.created_at, t.updated_at, t.block_kind, t.block_requeue_at,
                  (SELECT COUNT(*) FROM evidence e WHERE e.task_id = t.id AND e.kind <> 'image') AS evidence_count,
                  (SELECT a.notes FROM attempts a WHERE a.task_id = t.id ORDER BY a.id DESC LIMIT 1) AS latest_attempt_note
           FROM tasks t
           LEFT JOIN tasks p ON p.id = t.parent_id
           WHERE t.project_id = ? AND t.state <> 'DONE'
           ${hasCursor ? `AND (
             t.priority > ? OR (t.priority = ? AND t.id > ?)
           )` : ""}
           ORDER BY t.priority ASC, t.id ASC
           LIMIT ?`,
        )
        .all<Record<string, unknown> & {
          id: number;
          priority: number;
          state: string;
          lease_agent: string | null;
          block_kind: string | null;
          latest_attempt_note: string | null;
        }>(
          membership.projectId,
          ...(hasCursor ? [cursorPriority, cursorPriority, cursorId] : []),
          limit + 1,
        );
      const { rows: tasks, hasMore } = pageRows(taskRows, limit);
      const actorLabels = await projectActorLabels(
        db,
        tasks.flatMap((task) => task.lease_agent
          ? [{ actor: task.lease_agent, projectId: membership.projectId }]
          : []),
      );
      const trendRow = await db
        .prepare(
          `SELECT
             COALESCE(SUM((CASE WHEN to_state <> 'DONE' THEN 1 ELSE 0 END) - (CASE WHEN from_state <> 'DONE' THEN 1 ELSE 0 END)), 0) AS open,
             COALESCE(SUM((CASE WHEN to_state IN ('CLAIMED','PLANNED','EXECUTING') THEN 1 ELSE 0 END) - (CASE WHEN from_state IN ('CLAIMED','PLANNED','EXECUTING') THEN 1 ELSE 0 END)), 0) AS active,
             COALESCE(SUM((CASE WHEN to_state = 'QUEUED' THEN 1 ELSE 0 END) - (CASE WHEN from_state = 'QUEUED' THEN 1 ELSE 0 END)), 0) AS ready,
             COALESCE(SUM((CASE WHEN to_state = 'DONE' THEN 1 ELSE 0 END) - (CASE WHEN from_state = 'DONE' THEN 1 ELSE 0 END)), 0) AS done
           FROM task_transitions WHERE project_id = ? AND changed_at >= ?`,
        )
        .get<Record<OverviewCategory, number>>(membership.projectId, since);
      const currentRow = await db
        .prepare(
          `SELECT
             COALESCE(SUM(CASE WHEN state <> 'DONE' THEN 1 ELSE 0 END), 0) AS open,
             COALESCE(SUM(CASE WHEN state IN ('CLAIMED','PLANNED','EXECUTING') THEN 1 ELSE 0 END), 0) AS active,
             COALESCE(SUM(CASE WHEN state = 'QUEUED' THEN 1 ELSE 0 END), 0) AS ready,
             COALESCE(SUM(CASE WHEN state = 'DONE' THEN 1 ELSE 0 END), 0) AS done
           FROM tasks WHERE project_id = ?`,
        )
        .get<Record<OverviewCategory, number>>(membership.projectId);
      const transitionRows = await db
        .prepare(
          `SELECT tr.id, tr.task_id, t.title, tr.from_state, tr.to_state, tr.changed_at
             FROM task_transitions tr JOIN tasks t ON t.id = tr.task_id
            WHERE tr.project_id = ? AND tr.changed_at >= ?
            ORDER BY tr.changed_at DESC, tr.id DESC LIMIT 10`,
        )
        .all<{ id: number; task_id: number; title: string; from_state: string; to_state: string; changed_at: number }>(
          membership.projectId,
          since,
        );
      const trends = Object.fromEntries(OVERVIEW_CATEGORIES.map((category) => [category, Number(trendRow?.[category] ?? 0)])) as Record<OverviewCategory, number>;
      const lastTask = tasks.at(-1);
      const { deriveOperationalDisposition } = await import("./operational-disposition.js");
      const { unsatisfiedDeps } = await import("./queue.js");
      // Batch open-question + latest groom status (avoid N+1 per queue row).
      const openQuestionTaskIds = new Set(
        (
          await db
            .prepare(
              `SELECT DISTINCT task_id AS id FROM questions
                WHERE project_id = ? AND status = 'open' AND task_id IS NOT NULL`,
            )
            .all<{ id: number }>(membership.projectId)
        ).map((row) => row.id),
      );
      const groomByTask = new Map<number, "pending" | "running" | "done" | "failed">();
      for (const job of await db
        .prepare(
          `SELECT id, status, payload FROM jobs
            WHERE project_id = ? AND kind = 'groom'
            ORDER BY id DESC`,
        )
        .all<{ id: number; status: string; payload: string }>(membership.projectId)) {
        let taskId: number | null = null;
        try {
          const parsed = JSON.parse(job.payload) as { taskId?: unknown };
          if (typeof parsed.taskId === "number") taskId = parsed.taskId;
        } catch {
          /* ignore */
        }
        if (taskId == null || groomByTask.has(taskId)) continue;
        if (job.status === "pending" || job.status === "running" || job.status === "done" || job.status === "failed") {
          groomByTask.set(taskId, job.status);
        }
      }
      res.json({
        tasks: await Promise.all(tasks.map(async (task) => {
          const row = task as Record<string, unknown> & {
            id: number;
            state: string;
            lease_agent: string | null;
            block_kind: string | null;
            latest_attempt_note: string | null;
          };
          const waiting_on = await unsatisfiedDeps(db, row.id);
          const operational = deriveOperationalDisposition({
            state: String(row.state),
            lease_agent: row.lease_agent,
            lease_expires_at: (row.lease_expires_at as number | null) ?? null,
            hold_cause: (row.hold_cause as string | null) ?? null,
            block_kind: row.block_kind,
            block_requeue_at: (row.block_requeue_at as number | null) ?? null,
            incubate_until: (row.incubate_until as number | null) ?? null,
            grooming_rationale: (row.grooming_rationale as string | null) ?? null,
            plan: (row.plan as string | null) ?? null,
            plan_deadline: (row.plan_deadline as number | null) ?? null,
            queued_at: (row.queued_at as number | null) ?? null,
            updated_at: (row.updated_at as number | null) ?? null,
            waiting_on,
            groom_job_status: groomByTask.get(row.id) ?? null,
            has_open_question: openQuestionTaskIds.has(row.id),
          });
          const {
            block_kind,
            latest_attempt_note,
            plan: _taskPlan,
            plan_deadline: _planDeadline,
            queued_at: _queuedAt,
            block_requeue_at: _blockRequeueAt,
            ...rest
          } = row;
          return {
            ...rest,
            latest_attempt_note: publicAttemptNote(latest_attempt_note, {
              blockKind: block_kind,
              blocked: row.state === "BLOCKED",
            }),
            lease_agent: row.lease_agent === null
              ? null
              : projectActorLabel(actorLabels, row.lease_agent, membership.projectId) ?? row.lease_agent,
            operational,
          };
        })),
        overview: {
          window: { label: "last 7 days", since },
          current: Object.fromEntries(OVERVIEW_CATEGORIES.map((category) => [category, Number(currentRow?.[category] ?? 0)])),
          trends,
          transitions: transitionRows,
        },
        next_cursor: hasMore && lastTask
          ? encodeCursor("queue", {
              done: 0,
              priority: lastTask.priority,
              id: lastTask.id,
            })
          : null,
      });
    }),
  );

  app.get(
    "/api/p/:project/tasks/done",
    scoped(false, async (req, res, _member, membership) => {
      const limit = pageLimit(req);
      const offset = pageOffset(req);
      const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
      res.json(await completedTasksPage(db, membership.projectId, query, limit, offset));
    }),
  );

  // Warming view (#63): the read-only workshop surface. Lists the project's
  // INCUBATING tasks (born of a warm_for submission, #61) with the graduation
  // clock and a contributor count — distinct authors across the task's threads
  // (its own threads plus the submission root). Soonest to graduate first. The
  // per-task curation transcript is served by the existing /timeline route.
  app.get(
    "/api/p/:project/warming",
    scoped(false, async (req, res, _member, membership) => {
      const limit = pageLimit(req);
      const cursor = decodeCursor(req, "warming");
      const cursorUntil = numericCursorValue(cursor, "until");
      const cursorId = numericCursorValue(cursor, "id");
      const hasCursor = cursorUntil !== null && cursorId !== null;
      const taskRows = await db
        .prepare(
          `SELECT t.id, t.title, t.body, t.priority, t.submitted_by,
                  t.incubate_until, t.created_at, t.updated_at,
                  (SELECT COUNT(DISTINCT m.author)
                     FROM thread_messages m JOIN threads th ON th.id = m.thread_id
                    WHERE th.task_id = t.id OR th.id = t.root_thread_id) AS contributor_count,
                  (SELECT COUNT(*) FROM threads th
                    WHERE th.task_id = t.id OR th.id = t.root_thread_id) AS thread_count
           FROM tasks t
           WHERE t.project_id = ? AND t.state = 'INCUBATING'
           ${hasCursor ? "AND (t.incubate_until > ? OR (t.incubate_until = ? AND t.id > ?))" : ""}
           ORDER BY t.incubate_until ASC, t.id ASC LIMIT ?`,
        )
        .all<Record<string, unknown> & { id: number; incubate_until: number }>(
          membership.projectId,
          ...(hasCursor ? [cursorUntil, cursorUntil, cursorId] : []),
          limit + 1,
        );
      const { rows: tasks, hasMore } = pageRows(taskRows, limit);
      const lastTask = tasks.at(-1);
      res.json({
        tasks: tasks.map((t) => ({ ...t, state: "INCUBATING" })),
        next_cursor: hasMore && lastTask
          ? encodeCursor("warming", { until: lastTask.incubate_until, id: lastTask.id })
          : null,
      });
    }),
  );

  app.get(
    "/api/p/:project/agents",
    scoped(false, async (_req, res, _member, membership) => {
      const now = Date.now();
      const agents = await db
        .prepare(
          `SELECT lease_agent AS agent, id AS task_id, title, state, lease_expires_at
           FROM tasks
           WHERE project_id = ? AND lease_agent IS NOT NULL AND lease_expires_at > ?
           ORDER BY lease_agent, id`,
        )
        .all<Record<string, unknown> & { agent: string }>(membership.projectId, now);
      const actorLabels = await projectActorLabels(
        db,
        agents.map((agent) => ({ actor: agent.agent, projectId: membership.projectId })),
      );
      const { queued } = (await db
        .prepare("SELECT COUNT(*) AS queued FROM tasks WHERE project_id = ? AND state = 'QUEUED'")
        .get<{ queued: number }>(membership.projectId)) as { queued: number };
      res.json({
        agents: agents.map((agent) => ({
          ...agent,
          agent: projectActorLabel(actorLabels, agent.agent, membership.projectId) ?? agent.agent,
        })),
        queued,
      });
    }),
  );

  // Orchestrator health: per-source sweep/drain error counters so a persistently
  // failing worker is visible in the dashboard without reading server logs. The
  // data is global (the worker is shared) but sits behind per-project auth,
  // mirroring /agents. Absent worker (some test harnesses) reads as healthy.
  const HEALTHY = { count: 0, lastMessage: null, lastAt: null, escalated: false };
  app.get(
    "/api/p/:project/health",
    scoped(false, (_req, res) => {
      res.json(
        worker
          ? worker.status()
          : { inFlight: 0, sweepErrors: { ...HEALTHY }, drainErrors: { ...HEALTHY } },
      );
    }),
  );

  app.get(
    "/api/p/:project/threads",
    scoped(false, async (req, res, _member, membership) => {
      // Ordering contract for UIs: group threads by root_id (NULL = the row
      // is itself a root), sections per task by task id, messages by
      // (thread_id, id) — monotonic ids are the anchors, never timestamps.
      const limit = pageLimit(req);
      const cursorId = numericCursorValue(decodeCursor(req, "threads"), "id");
      const threadRows = await db
        .prepare(
          `WITH scoped_threads AS (
             SELECT id, kind, task_id, root_id, created_at, summary
               FROM threads
              WHERE project_id = ? ${cursorId === null ? "" : "AND id < ?"}
              ORDER BY id DESC LIMIT ?
           ), message_bounds AS (
             SELECT m.thread_id, MIN(m.id) AS first_id, MAX(m.id) AS last_id,
                    MIN(CASE WHEN m.role = 'human' THEN m.id END) AS first_human_id,
                    MAX(m.created_at) AS last_activity
               FROM thread_messages m JOIN scoped_threads th ON th.id = m.thread_id
              GROUP BY m.thread_id
           )
           SELECT th.id, th.kind, th.task_id, th.root_id, th.created_at, th.summary,
                  t.title AS task_title, t.state AS task_state, first.content AS first_message,
                  last.content AS last_message, last.author AS last_author, last.role AS last_role,
                  first_human.content AS first_human_message,
                  COALESCE(bounds.last_activity, th.created_at) AS last_activity
             FROM scoped_threads th
             LEFT JOIN tasks t ON t.id = th.task_id
             LEFT JOIN message_bounds bounds ON bounds.thread_id = th.id
             LEFT JOIN thread_messages first ON first.id = bounds.first_id
             LEFT JOIN thread_messages last ON last.id = bounds.last_id
             LEFT JOIN thread_messages first_human ON first_human.id = bounds.first_human_id
            ORDER BY th.id DESC`,
        )
        .all<{
          id: number;
          kind: string;
          task_id: number | null;
          root_id: number | null;
          created_at: number;
          summary: string | null;
          task_title: string | null;
          task_state: string | null;
          first_message: string | null;
          last_message: string | null;
          last_author: string | null;
          last_role: string | null;
          first_human_message: string | null;
          last_activity: number;
        }>(membership.projectId, ...(cursorId === null ? [] : [cursorId]), limit + 1);
      const { rows, hasMore } = pageRows(threadRows, limit);
      const lastThread = rows.at(-1);
      res.json({
        threads: rows.map((r) => ({
          ...r,
          summary: preview(r.summary),
          first_message: preview(r.first_message),
          last_message: preview(r.last_message),
          first_human_message: preview(r.first_human_message),
        })),
        next_cursor: hasMore && lastThread ? encodeCursor("threads", { id: lastThread.id }) : null,
      });
    }),
  );

  app.get(
    "/api/p/:project/threads/:id",
    scoped(false, async (req, res, _member, membership) => {
      const thread = await db
        .prepare("SELECT id, kind, task_id, root_id, created_at FROM threads WHERE id = ? AND project_id = ?")
        .get<{ id: number; kind: string; task_id: number | null; root_id: number | null; created_at: number }>(
          Number(req.params.id),
          membership.projectId,
        );
      if (!thread) {
        res.status(404).json({ error: "not found" });
        return;
      }
      const messages = await db
        .prepare(
          "SELECT role, author, content, created_at FROM thread_messages WHERE thread_id = ? ORDER BY id ASC",
        )
        .all(thread.id);
      // Session assembly: the whole ordered, typed, parent-linked event
      // stream for this thread's session (its root, or itself when a root) —
      // not just this thread's slice. Legacy `messages` stay for back-compat.
      const sessionId = thread.root_id ?? thread.id;
      const session = await db
        .prepare(
          `SELECT id, parent_id, thread_id, task_id, seq, type, role, author, content, status, start_time, end_time
             FROM session_events WHERE session_id = ? ORDER BY seq ASC`,
        )
        .all(sessionId);
      res.json({ ...thread, messages, session_id: sessionId, session });
    }),
  );

  app.get(
    "/api/p/:project/sessions/:id/siblings",
    scoped(false, async (req, res, _member, membership) => {
      const sessionId = Number(req.params.id);
      const selectedThreadId = typeof req.query.thread === "string" ? Number(req.query.thread) : sessionId;
      if (!Number.isSafeInteger(sessionId) || !Number.isSafeInteger(selectedThreadId)) {
        res.status(404).json({ error: "not found" });
        return;
      }
      const selected = await db
        .prepare(
          `SELECT id FROM threads
            WHERE id = ? AND project_id = ? AND (id = ? OR root_id = ?)`,
        )
        .get<{ id: number }>(selectedThreadId, membership.projectId, sessionId, sessionId);
      if (!selected) {
        res.status(404).json({ error: "not found" });
        return;
      }
      const first = await db
        .prepare(
          `SELECT parent_id FROM session_events
            WHERE session_id = ? AND thread_id = ? ORDER BY seq ASC LIMIT 1`,
        )
        .get<{ parent_id: number | null }>(sessionId, selectedThreadId);
      if (first?.parent_id == null) {
        res.json({ originText: null, siblings: [] });
        return;
      }
      const origin = await db
        .prepare(
          `SELECT content FROM session_events
            WHERE id = ? AND project_id = ? AND session_id = ?`,
        )
        .get<{ content: string }>(first.parent_id, membership.projectId, sessionId);
      const siblings = await db
        .prepare(
          `WITH first_events AS (
             SELECT thread_id, MIN(seq) AS first_seq
               FROM session_events
              WHERE session_id = ? AND thread_id IS NOT NULL
              GROUP BY thread_id
           )
           SELECT th.id AS thread_id, th.task_id, COALESCE(th.root_id, th.id) AS session_id
             FROM first_events first
             JOIN session_events event
               ON event.session_id = ? AND event.thread_id = first.thread_id AND event.seq = first.first_seq
             JOIN threads th ON th.id = first.thread_id
            WHERE event.parent_id = ? AND th.id <> ? AND th.project_id = ?
            ORDER BY th.id ASC`,
        )
        .all<{ thread_id: number; task_id: number | null; session_id: number }>(
          sessionId,
          sessionId,
          first.parent_id,
          selectedThreadId,
          membership.projectId,
        );
      res.json({
        originText: origin ? preview(origin.content.split("\n")[0]) : `event #${first.parent_id}`,
        siblings: siblings.map((sibling) => ({
          taskId: sibling.task_id,
          sessionId: sibling.session_id,
          threadId: sibling.thread_id,
          label: sibling.task_id ? `task #${sibling.task_id}` : `session #${sibling.thread_id}`,
        })),
      });
    }),
  );

  // A session replayed over the Vercel AI-SDK UI Message Stream SSE
  // vocabulary: the client reads text-delta / reasoning-delta /
  // tool-input-available / tool-output-available frames bracketed by
  // start-step / finish-step, exactly as it would a live model stream. Token
  // accepted as ?token= (EventSource cannot set an Authorization header).
  app.get(
    "/api/p/:project/sessions/:id/stream",
    scoped(true, async (req, res, _member, membership) => {
      const sessionId = Number(req.params.id);
      const owner = await db
        .prepare("SELECT project_id FROM threads WHERE id = ?")
        .get<{ project_id: string }>(sessionId);
      // Unknown session or one owned by another project → 404. No cross-project read.
      if (!owner || owner.project_id !== membership.projectId) {
        res.status(404).json({ error: "not found" });
        return;
      }
      const resumeValue = req.get("Last-Event-ID") ?? (typeof req.query.lastEventId === "string" ? req.query.lastEventId : "");
      const parsedResume = Number(resumeValue);
      const resumeAfter = resumeValue !== "" && Number.isSafeInteger(parsedResume) && parsedResume >= 0 ? parsedResume : -1;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.flushHeaders();
      const keepalive = setInterval(() => res.write(`: keepalive\n\n`), keepaliveMs);
      req.on("close", () => clearInterval(keepalive));
      try {
        const events = await db
          .prepare(
            `SELECT e.id, e.parent_id, e.thread_id, e.task_id, e.seq, e.type, e.role, e.author,
                  e.content, e.status, e.start_time, e.end_time,
                  p.thread_id AS parent_thread_id, p.task_id AS parent_task_id
             FROM session_events e
             LEFT JOIN session_events p ON p.id = e.parent_id
            WHERE e.session_id = ? ORDER BY e.seq ASC`,
          )
          .all<{
            id: number; parent_id: number | null; thread_id: number | null; task_id: number | null;
            parent_thread_id: number | null; parent_task_id: number | null; seq: number; type: string;
            role: string; author: string; content: string; status: string;
            start_time: number; end_time: number | null;
          }>(sessionId);
        const decisions = await db
          .prepare(
            `SELECT id, task_id, kind, summary, rationale, created_at, citations
             FROM decision_log
            WHERE project_id = ? AND task_id IN
                  (SELECT DISTINCT task_id FROM session_events WHERE session_id = ? AND task_id IS NOT NULL)
            ORDER BY created_at ASC, id ASC`,
          )
          .all<{
            id: number; task_id: number | null; kind: string; summary: string;
            rationale: string; created_at: number; citations: string;
          }>(membership.projectId, sessionId);
        let timelineOrder = 0;
        const send = (frame: Record<string, unknown>) => {
          const frameId = timelineOrder++;
          if (frameId <= resumeAfter) return;
          res.write(`id: ${frameId}\ndata: ${JSON.stringify({ ...frame, timelineOrder: frameId })}\n\n`);
        };
      const meta = (e: (typeof events)[number]) => ({
        eventId: e.id,
        seq: e.seq,
        parentId: e.parent_id,
        threadId: e.thread_id,
        taskId: e.task_id,
        role: e.role,
        author: e.author,
        startTime: e.start_time,
        endTime: e.end_time,
        status: e.status,
      });
      const timeline = [
        ...events.map((event) => ({ at: event.start_time, rank: 0, id: event.id, event })),
        ...decisions.map((decision) => ({ at: decision.created_at, rank: 1, id: decision.id, decision })),
      ].sort((a, b) => a.at - b.at || a.rank - b.rank || a.id - b.id);
      const crossingsByAffected = groupReplayCrossings(projectReplayCrossings(events));
      send({ type: "start", sessionId });
      for (const item of timeline) {
        if ("decision" in item && item.decision) {
          const d = item.decision;
          send({
            type: "data-decision",
            id: `decision-${d.id}`,
            taskId: d.task_id,
            createdAt: d.created_at,
            decisionKind: d.kind,
            title: d.summary,
            rationale: d.rationale,
            citations: parseDecisionCitations(d.citations),
          });
          continue;
        }
        if (!("event" in item) || !item.event) continue;
        const e = item.event;
        for (const crossing of crossingsByAffected.get(e.id) ?? []) {
          const incoming = crossing.arrival.task_id != null
            ? `task #${crossing.arrival.task_id}`
            : `thread #${crossing.arrival.thread_id}`;
          const origin = crossing.arrival.parent_task_id != null
            ? `task #${crossing.arrival.parent_task_id}`
            : `thread #${crossing.arrival.parent_thread_id}`;
          let outcome = "";
          if (crossing.outcome) {
            try {
              const parsed = JSON.parse(crossing.outcome.content) as Record<string, unknown>;
              const decision = typeof parsed.verdict === "string"
                ? parsed.verdict
                : typeof parsed.action === "string" ? parsed.action : "decision";
              const reason = typeof parsed.feedback === "string"
                ? parsed.feedback
                : typeof parsed.rationale === "string" ? parsed.rationale : "";
              outcome = `${decision}${reason ? ` — ${reason}` : ""}`;
            } catch {
              outcome = crossing.outcome.content.slice(0, 180);
            }
          }
          const source = `${incoming} arrived from ${origin}`;
          const impact = outcome
            ? `${e.author} re-evaluated ${incoming} → ${outcome}`
            : `${e.author} ${e.type.replaceAll("_", " ")} began for ${incoming}`;
          send({
            type: "data-cross-thread",
            id: `cross-${crossing.arrival.id}`,
            createdAt: e.start_time,
            source,
            impact,
            affectedEventId: e.id,
            fromThreadId: crossing.arrival.parent_thread_id,
            fromTaskId: crossing.arrival.parent_task_id,
            toThreadId: crossing.arrival.thread_id,
            toTaskId: crossing.arrival.task_id,
          });
        }
        const id = String(e.id);
        switch (e.type) {
          case "request":
            send({ type: "start-step", id, text: e.content, ...meta(e) });
            break;
          case "reasoning":
            send({ type: "reasoning-delta", id, delta: e.content, ...meta(e) });
            break;
          case "tool_call":
            send({ type: "tool-input-available", id, toolCallId: id, input: e.content, ...meta(e) });
            break;
          case "tool_result":
            send({
              type: "tool-output-available",
              id,
              toolCallId: String(e.parent_id ?? e.id),
              output: e.content,
              ...meta(e),
            });
            break;
          default:
            // verdict, text, clarification_q, clarification_a → rendered prose.
            send({ type: "text-delta", id, kind: e.type, delta: e.content, ...meta(e) });
        }
      }
      send({ type: "finish-step" });
      send({ type: "finish" });
      res.write("data: [DONE]\n\n");
      res.end();
      } finally {
        clearInterval(keepalive);
      }
    }),
  );

  app.get(
    "/api/p/:project/questions",
    scoped(false, async (req, res, _member, membership) => {
      const limit = pageLimit(req);
      const cursor = decodeCursor(req, "questions");
      const cursorStatus = numericCursorValue(cursor, "status");
      const cursorId = numericCursorValue(cursor, "id");
      const hasCursor = cursorStatus !== null && cursorId !== null;
      const questionRows = await db
        .prepare(
          `SELECT q.id, q.task_id, t.title AS task_title, q.asked_by, q.question, q.answer, q.answered_by, q.status, q.created_at
             FROM questions q LEFT JOIN tasks t ON t.id = q.task_id
            WHERE q.project_id = ?
            ${hasCursor ? `AND (
              CASE WHEN q.status = 'open' THEN 0 ELSE 1 END > ? OR
              (CASE WHEN q.status = 'open' THEN 0 ELSE 1 END = ? AND q.id < ?)
            )` : ""}
            ORDER BY CASE WHEN q.status = 'open' THEN 0 ELSE 1 END, q.id DESC
            LIMIT ?`,
        )
        .all<Record<string, unknown> & { id: number; status: string }>(
          membership.projectId,
          ...(hasCursor ? [cursorStatus, cursorStatus, cursorId] : []),
          limit + 1,
        );
      const { rows: questions, hasMore } = pageRows(questionRows, limit);
      const lastQuestion = questions.at(-1);
      res.json({
        questions,
        next_cursor: hasMore && lastQuestion
          ? encodeCursor("questions", { status: lastQuestion.status === "open" ? 0 : 1, id: lastQuestion.id })
          : null,
      });
    }),
  );

  app.get(
    "/api/p/:project/tasks/:id",
    scoped(false, async (req, res, _member, membership) => {
      const taskId = Number(req.params.id);
      const owned = await db
        .prepare("SELECT id FROM tasks WHERE id = ? AND project_id = ?")
        .get(taskId, membership.projectId);
      if (!owned) {
        res.status(404).json({ error: "not found" });
        return;
      }
      const brief = await presentTaskBriefActors(db, await queue.brief(taskId));
      // System-domain blocked attempt notes never leave the dashboard API.
      const attempts = brief.attempts.map((attempt) => ({
        ...attempt,
        notes: publicAttemptNote(attempt.notes, {
          blockKind: brief.block_kind,
          blocked: attempt.outcome === "blocked" || brief.state === "BLOCKED",
        }),
      }));
      // Include the root submission thread even when threads.task_id was never
      // backfilled (legacy orphans keep root_thread_id on the task only).
      const threads = await db
        .prepare(
          `SELECT id, kind, root_id, created_at FROM threads
           WHERE project_id = ? AND (task_id = ? OR id = ?)
           ORDER BY id DESC`,
        )
        .all(membership.projectId, taskId, brief.root_thread_id ?? -1);
      const decisions = await db
        .prepare(
          `SELECT id, kind, summary, rationale, created_at, citations
           FROM decision_log WHERE task_id = ? AND project_id = ? ORDER BY id DESC`,
        )
        .all<Record<string, unknown> & { rationale: string; citations: string }>(taskId, membership.projectId);
      const parsedDecisions = decisions.map((decision) => ({
        ...decision,
        citations: parseDecisionCitations(decision.citations),
      }));
      const grooming = parsedDecisions.find((decision) => decision.rationale === brief.grooming_rationale);
      const parent = brief.parent_id
        ? await db
          .prepare("SELECT title, submitted_by FROM tasks WHERE id = ? AND project_id = ?")
          .get<{ title: string; submitted_by: string }>(brief.parent_id, membership.projectId)
        : null;
      res.json({
        ...brief,
        attempts,
        grooming_citations: grooming?.citations ?? [],
        threads,
        decisions: parsedDecisions,
        parent_title: parent?.title ?? null,
        parent_submitted_by: parent?.submitted_by ?? null,
      });
    }),
  );

  app.get(
    "/api/p/:project/tasks/:id/images",
    scoped(false, async (req, res, _member, membership) => {
      const taskId = Number(req.params.id);
      if (!Number.isSafeInteger(taskId) || taskId <= 0) {
        res.status(404).json({ error: "not found" });
        return;
      }
      const owned = await db
        .prepare("SELECT id FROM tasks WHERE id = ? AND project_id = ?")
        .get(taskId, membership.projectId);
      if (!owned) {
        res.status(404).json({ error: "not found" });
        return;
      }
      const images = imageAttachments
        ? await imageAttachments.list(membership.projectId, taskId)
        : [];
      res.json({
        images: images.map((image) => ({
          id: image.id,
          mime_type: image.mimeType,
          caption: image.caption,
        })),
      });
    }),
  );

  app.get(
    "/p/:project/images/:id",
    scoped(false, async (req, res, _member, membership) => {
      const imageId = Number(req.params.id);
      if (!imageAttachments || !Number.isSafeInteger(imageId) || imageId <= 0) {
        res.status(404).json({ error: "not found" });
        return;
      }
      try {
        const image = await imageAttachments.read(membership.projectId, imageId);
        if (!image || !IMAGE_MIME_TYPES.includes(image.attachment.mimeType)) {
          res.status(404).json({ error: "not found" });
          return;
        }
        res.setHeader("Content-Type", image.attachment.mimeType);
        res.setHeader("Content-Length", image.bytes.byteLength);
        res.setHeader("Cache-Control", "private, no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.status(200).end(Buffer.from(image.bytes));
      } catch {
        // A missing object and a foreign image are deliberately
        // indistinguishable to this private route.
        res.status(404).json({ error: "not found" });
      }
    }),
  );

  // Woven per-task timeline (#45): one chronological stream that merges the
  // task's conversation bubbles (thread_messages anchored to the task, plus its
  // root submission) with projected event rows from decision_log, questions,
  // steers, memory_log and the task's PR fields. Typed {kind: bubble|event},
  // ordered by created_at ascending; message id breaks ties within a source.
  app.get(
    "/api/p/:project/tasks/:id/timeline",
    scoped(false, async (req, res, _member, membership) => {
      const taskId = Number(req.params.id);
      const task = await db
        .prepare(
          `SELECT id, root_thread_id, result_pr_url, result_pr_number, result_summary, created_at, updated_at
           FROM tasks WHERE id = ? AND project_id = ?`,
        )
        .get<{
          id: number;
          root_thread_id: number | null;
          result_pr_url: string | null;
          result_pr_number: number | null;
          result_summary: string | null;
          created_at: number;
          updated_at: number;
        }>(taskId, membership.projectId);
      if (!task) {
        res.status(404).json({ error: "not found" });
        return;
      }

      const bubbleRows = await db
        .prepare(
          `SELECT m.id, m.thread_id, th.kind AS thread_kind, m.role, m.author, m.content,
                  m.reasoning, m.structured, m.model, m.usage, m.created_at
           FROM thread_messages m JOIN threads th ON th.id = m.thread_id
           WHERE th.project_id = ? AND (th.task_id = ? OR th.id = ?)
           ORDER BY m.created_at ASC, m.id ASC`,
        )
        .all<{
          id: number; thread_id: number; thread_kind: string; role: string; author: string;
          content: string; reasoning: string | null; structured: string | null;
          model: string | null; usage: string | null; created_at: number;
        }>(membership.projectId, taskId, task.root_thread_id ?? -1);

      const decisionRows = await db
        .prepare(
          `SELECT id, kind, summary, rationale, created_at, citations FROM decision_log
           WHERE task_id = ? AND project_id = ? ORDER BY id ASC`,
        )
        .all<{ id: number; kind: string; summary: string; rationale: string; created_at: number; citations: string }>(
          taskId,
          membership.projectId,
        );
      const questionRows = await db
        .prepare(
          `SELECT id, asked_by, question, answer, answered_by, status, created_at FROM questions
           WHERE task_id = ? AND project_id = ? ORDER BY id ASC`,
        )
        .all<{
          id: number; asked_by: string; question: string; answer: string | null; answered_by: string | null;
          status: string; created_at: number;
        }>(taskId, membership.projectId);
      const steerRows = await db
        .prepare(
          "SELECT id, author, instruction, delivered, created_at FROM steers WHERE task_id = ? ORDER BY id ASC",
        )
        .all<{ id: number; author: string; instruction: string; delivered: number; created_at: number }>(taskId);
      // Scoped to THIS task (#86): only curate entries attributed to it, not
      // the whole project's curation log dumped into every timeline.
      const memoryRows = await db
        .prepare(
          "SELECT id, entry, created_at FROM memory_log WHERE project_id = ? AND task_id = ? ORDER BY id ASC",
        )
        .all<{ id: number; entry: string; created_at: number }>(membership.projectId, taskId);
      const evidence = await db
        .prepare(
          "SELECT id, kind, path, lines, snippet, note FROM evidence WHERE task_id = ? AND kind <> 'image' ORDER BY id",
        )
        .all(taskId);

      const jsonOrNull = (s: string | null): unknown => {
        if (s === null) return null;
        try {
          return JSON.parse(s);
        } catch {
          return s;
        }
      };

      type Item = { kind: "bubble" | "event"; type: string; created_at: number } & Record<string, unknown>;
      const items: Item[] = [];
      for (const b of bubbleRows) {
        items.push({
          kind: "bubble",
          type: b.thread_kind,
          thread_id: b.thread_id,
          role: b.role,
          author: b.author,
          content: b.content,
          reasoning: b.reasoning,
          structured: jsonOrNull(b.structured),
          model: b.model,
          usage: jsonOrNull(b.usage),
          created_at: b.created_at,
        });
      }
      for (const d of decisionRows) {
        items.push({ kind: "event", type: "decision", decision_id: d.id, decision_kind: d.kind, summary: d.summary, rationale: d.rationale, citations: parseDecisionCitations(d.citations), created_at: d.created_at });
      }
      for (const q of questionRows) {
        items.push({ kind: "event", type: "question", asked_by: q.asked_by, question: q.question, answer: q.answer, answered_by: q.answered_by, status: q.status, created_at: q.created_at });
      }
      for (const s of steerRows) {
        items.push({ kind: "event", type: "steer", author: s.author, instruction: s.instruction, delivered: s.delivered === 1, created_at: s.created_at });
      }
      for (const m of memoryRows) {
        items.push({ kind: "event", type: "memory", entry: m.entry, created_at: m.created_at });
      }
      for (const row of evidence as Array<Record<string, unknown> & { id: number }>) {
        items.push({
          kind: "event",
          type: "evidence",
          evidence_id: row.id,
          evidence_kind: row.kind,
          path: row.path,
          lines: row.lines,
          snippet: row.snippet,
          note: row.note,
          created_at: task.created_at,
        });
      }
      if (task.result_pr_url) {
        items.push({
          kind: "event",
          type: "pr",
          pr_url: task.result_pr_url,
          pr_number: task.result_pr_number,
          summary: task.result_summary,
          created_at: task.updated_at,
        });
      }

      items.sort((a, b) => a.created_at - b.created_at);
      res.json({ timeline: items, evidence });
    }),
  );

  // Multi-human conflict conversations (#77): the read view. list = every
  // conversation for the project (state, participants, tasks, counts); the
  // per-id route returns the full discussion, participants (with who replied),
  // the conflicting tasks, and the decisions the close produced.
  app.get(
    "/api/p/:project/conversations",
    scoped(false, async (_req, res, _member, membership) => {
      res.json({ conversations: await conversations.listForProject(membership.projectId) });
    }),
  );

  app.get(
    "/api/p/:project/conversations/:id",
    scoped(false, async (req, res, _member, membership) => {
      const view = await conversations.get(Number(req.params.id));
      if (!view || view.project_id !== membership.projectId) {
        res.status(404).json({ error: "not found" });
        return;
      }
      const tasks = await db
        .prepare(
          `SELECT id, title, state FROM tasks WHERE id IN (${view.task_ids.map(() => "?").join(",") || "NULL"})`,
        )
        .all<{ id: number; title: string; state: string }>(...view.task_ids);
      const decisions = view.decision_ids.length
        ? await db
            .prepare(
              `SELECT id, kind, summary, rationale, created_at, citations FROM decision_log
               WHERE id IN (${view.decision_ids.map(() => "?").join(",")}) ORDER BY id`,
            )
            .all<{ id: number; kind: string; summary: string; rationale: string; created_at: number; citations: string }>(...view.decision_ids)
        : [];
      res.json({ ...view, tasks, decisions: decisions.map((decision) => ({ ...decision, citations: parseDecisionCitations(decision.citations) })) });
    }),
  );

  app.get(
    "/api/p/:project/decisions",
    scoped(false, async (req, res, _member, membership) => {
      const limit = pageLimit(req);
      const cursorId = numericCursorValue(decodeCursor(req, "decisions"), "id");
      const decisionRows = await db
        .prepare(
          `SELECT id, task_id, kind, summary, rationale, created_at, citations
           FROM decision_log WHERE project_id = ? ${cursorId === null ? "" : "AND id < ?"}
           ORDER BY id DESC LIMIT ?`,
        )
        .all<{ id: number; citations: string } & Record<string, unknown>>(
          membership.projectId,
          ...(cursorId === null ? [] : [cursorId]),
          limit + 1,
        );
      const { rows: decisions, hasMore } = pageRows(decisionRows, limit);
      const lastDecision = decisions.at(-1);
      res.json({
        decisions: decisions.map((decision) => ({ ...decision, citations: parseDecisionCitations(decision.citations) })),
        next_cursor: hasMore && lastDecision ? encodeCursor("decisions", { id: lastDecision.id }) : null,
      });
    }),
  );

  app.get(
    "/api/p/:project/knowledge/activity",
    scoped(false, async (_req, res, _member, membership) => {
      const knowledge = await activeKnowledgeForProject(db, membership.projectId);
      res.json({
        updates: knowledge.updates.slice(0, 8),
        conventions: knowledge.conventions,
        decisions: knowledge.decisions.slice(0, 8),
      });
    }),
  );

  // Knowledge (OKF) — read-only browse of a project's DB-backed memory_docs.
  // list: concept summaries (tags parsed from their JSON column) ordered by
  // path so the UI can group by type; ?q= filters case-insensitively over
  // title + description + body.
  app.get(
    "/api/p/:project/knowledge",
    scoped(false, async (req, res, _member, membership) => {
      const rows = await db
        .prepare(
          `SELECT path, type, title, description, tags, body, updated_at
           FROM memory_docs WHERE project_id = ? ORDER BY path`,
        )
        .all<{
          path: string;
          type: string;
          title: string;
          description: string;
          tags: string;
          body: string;
          updated_at: number;
        }>(membership.projectId);
      const q = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";
      const concepts = rows
        .filter((r) =>
          q === ""
            ? true
            : `${r.title} ${r.description} ${r.body}`.toLowerCase().includes(q),
        )
        .map((r) => ({
          path: r.path,
          type: r.type,
          title: r.title,
          description: r.description,
          tags: parseStringArray(r.tags),
          updated_at: r.updated_at,
        }));
      res.json({ concepts });
    }),
  );

  // doc: one concept's full body plus resolved outbound links and backlinks.
  // Path travels as ?path= (not a wildcard route) so express-5 does not try to
  // parse the slashes and `.md` of a concept path as route segments.
  app.get(
    "/api/p/:project/knowledge/doc",
    scoped(false, async (req, res, _member, membership) => {
      const path = typeof req.query.path === "string" ? req.query.path : "";
      if (path === "") {
        res.status(404).json({ error: "not found" });
        return;
      }
      const doc = await db
        .prepare(
          `SELECT path, type, title, description, tags, body, updated_at
             FROM memory_docs WHERE project_id = ? AND path = ?`,
        )
        .get<{
          path: string;
          type: string;
          title: string;
          description: string;
          tags: string;
          body: string;
          updated_at: number;
        }>(membership.projectId, path);
      if (!doc) {
        res.status(404).json({ error: "not found" });
        return;
      }
      const linkable = await db
        .prepare("SELECT path, title, body FROM memory_docs WHERE project_id = ?")
        .all<LinkableDoc>(membership.projectId);
      const { links, backlinks } = resolveLinks(linkable, path);
      const linkTargets = resolveMarkdownLinkTargets(linkable, path);
      const provenance = (await knowledgeProvenanceForDoc(db, membership.projectId, doc))
        .map((decision) => ({
          id: decision.id,
          kind: decision.kind,
          summary: decision.summary,
          created_at: decision.created_at,
          task: decision.task_id === null ? null : {
            id: decision.task_id,
            title: decision.task_title ?? `Task ${decision.task_id}`,
          },
        }));
      res.json({
        path: doc.path,
        type: doc.type,
        title: doc.title,
        description: doc.description,
        tags: parseStringArray(doc.tags),
        body: doc.body,
        updated_at: doc.updated_at,
        links,
        linkTargets,
        backlinks,
        provenance,
      });
    }),
  );

  // Service worker for Web Push (must be same-origin under /dashboard scope).
  app.get("/dashboard/sw.js", (_req, res) => {
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.setHeader("Service-Worker-Allowed", "/dashboard");
    res.sendFile(path.join(fileURLToPath(new URL("./dashboard/public/", import.meta.url)), "sw.js"));
  });

  // SSE stream. Token also accepted as ?token= — EventSource cannot set an
  // Authorization header. Keepalive comments keep proxies (Cloudflare) from
  // idling out the connection.
  app.get(
    "/api/p/:project/events",
    scoped(true, (req, res, _member, membership) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(`: connected\n\n`);
      // Version announce: a long-open page reloads itself when a deploy lands
      // (found live — a stale tab survived deploys running old UI forever).
      res.write(`event: version\ndata: ${JSON.stringify({ version: serverVersion() })}\n\n`);

      const projectId = membership.projectId;

      // A `memracer wait` seat subscribes with ?role=<role> so the server pushes
      // the claimable count IN-BAND: once on connect (which delivers work that is
      // already queued right away — closing the subscribe/check race) and again
      // on every change (so the waiter never issues a follow-up request, however
      // busy the project). Dashboards omit role and pay nothing. A failed count
      // skips one frame and never crashes the stream — the durable queue and the
      // next change keep the agent from being stranded or left without data.
      const role =
        typeof req.query.role === "string" && req.query.role ? req.query.role : null;
      const pushQueue = async (): Promise<void> => {
        if (!role) return;
        try {
          const available = await queue.claimableCount(projectId, role);
          res.write(`event: queue\ndata: ${JSON.stringify({ role, available })}\n\n`);
        } catch {
          // transient — the next change re-pushes; the waiter's fallback re-checks.
        }
      };
      void pushQueue();

      const onChanged = (pid: string) => {
        if (pid === projectId) {
          res.write(`event: changed\ndata: ${JSON.stringify({ project: projectId })}\n\n`);
          void pushQueue();
        }
      };
      queue.onChanged(onChanged);
      const keepalive = setInterval(() => res.write(`: keepalive\n\n`), keepaliveMs);

      req.on("close", () => {
        clearInterval(keepalive);
        queue.offChanged(onChanged);
        res.end();
      });
    }),
  );
}
