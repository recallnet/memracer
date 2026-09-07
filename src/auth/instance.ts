/**
 * The better-auth instance, built over the database seam's native handle.
 *
 * Real users, sessions, org membership, and headless API keys, all sitting
 * BEHIND src/auth.ts's
 * resolveMember() seam so server.ts / tools.ts never learn better-auth's
 * vocabulary. The instance is keyed to a Db in a registry (below) so
 * resolveMember(db, header) can reach it without a signature change.
 *
 * Backend reach: better-auth's Kysely adapter drives a raw better-sqlite3
 * Database (SQLite, the default) or a node-postgres Pool (Postgres). When db.authDatabase() returns null (the PGlite test pool),
 * better-auth is disabled — there is no other auth, so resolveMember returns
 * null there. Suites that need auth open SQLite directly.
 */
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { getMigrations } from "better-auth/db/migration";
import { mcp, organization } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { apiKey } from "@better-auth/api-key";
import { magicLink } from "better-auth/plugins/magic-link";
import type { Db } from "../db.js";
import type { Role } from "../auth.js";
import { sendMagicLinkEmail } from "../email.js";
import { resolvePublicUrl, trustedAuthOrigins } from "../public-hosts.js";

/**
 * The three memracer roles as an access-control set (createAccessControl),
 * named human/coder/admin so the role string stays stable end-to-end. Grants
 * mirror requireRole in src/tools.ts: human submits, coder claims/
 * completes, admin does both plus project management.
 */
const statement = {
  project: ["submit", "claim", "complete", "manage"],
} as const;
const ac = createAccessControl(statement);
export const roles = {
  human: ac.newRole({ project: ["submit"] }),
  coder: ac.newRole({ project: ["claim", "complete"] }),
  admin: ac.newRole({ project: ["submit", "claim", "complete", "manage"] }),
};
export const ROLE_NAMES: Role[] = ["human", "coder", "admin"];

export type Auth = ReturnType<typeof betterAuth>;

export interface AuthHandle {
  auth: Auth;
  /** Resolves once better-auth's additive migrations have run on this handle. */
  ready: Promise<void>;
}

/**
 * The invite-only signup gate. When MEMRACER_INVITE_ONLY is set, a self-serve
 * magic-link sign-in is only allowed for an email that already belongs to a
 * user OR has a pending, unexpired invitation. Emails are stored lowercased
 * (dashboard.ts:1102); `lower(email)` keeps the compare case-insensitive on
 * both dialects. expiresAt is an ISO-8601 UTC string, so lexicographic `>`
 * against `new Date().toISOString()` is a correct "not yet expired" test.
 */
async function inviteOnlyAllows(db: Db, email: string): Promise<boolean> {
  const existingUser = await db
    .prepare('SELECT 1 AS one FROM "user" WHERE lower(email) = ? LIMIT 1')
    .get<{ one: number }>(email);
  if (existingUser) return true;
  const pending = await db
    .prepare(
      'SELECT 1 AS one FROM "invitation" WHERE lower(email) = ? AND status = ? AND "expiresAt" > ? LIMIT 1',
    )
    .get<{ one: number }>(email, "pending", new Date().toISOString());
  return Boolean(pending);
}

/** Build the options object shared by betterAuth() and getMigrations(). */
export function buildAuthOptions(db: Db, handle: unknown): BetterAuthOptions {
  const publicUrl = resolvePublicUrl(process.env);
  const githubClientId = process.env.MEMRACER_GITHUB_APP_CLIENT_ID;
  const githubClientSecret = process.env.MEMRACER_GITHUB_APP_CLIENT_SECRET;
  return {
    baseURL: publicUrl,
    trustedOrigins: trustedAuthOrigins(process.env),
    secret:
      process.env.BETTER_AUTH_SECRET ||
      "memracer-dev-better-auth-secret-0123456789-abcdef",
    socialProviders: githubClientId && githubClientSecret
      ? { github: { clientId: githubClientId, clientSecret: githubClientSecret } }
      : undefined,
    // GitHub primary email often differs from the magic-link login email
    // (personal vs work domain). Allow linking anyway; do not copy GitHub profile fields
    // onto the memracer user (updateUserInfoOnLink stays off / unset).
    account: {
      accountLinking: {
        allowDifferentEmails: true,
        trustedProviders: ["github"],
      },
    },
    database: handle as BetterAuthOptions["database"],
    // Invite-only signup gate (MEMRACER_INVITE_ONLY). Runs as a before-hook so
    // the raw body still reaches toNodeHandler intact — an Express middleware
    // would consume it. No-op for every path except self-serve magic-link
    // sign-in, and only when the flag is set, so all other auth is untouched.
    // The internal server-side invite (dashboard.ts issueMagicLink) passes
    // metadata.purpose === "invite" and is always allowed; it also has an
    // invitation row by then, but the metadata check is the explicit bypass.
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // Returning users: strip client `name` so re-signin cannot overwrite
        // user.name (edit only in Settings). New users may omit name entirely —
        // databaseHooks default it from email local-part on create.
        if (ctx.path === "/sign-in/magic-link" && ctx.body && typeof ctx.body === "object") {
          const body = ctx.body as Record<string, unknown> & {
            email?: unknown;
            name?: unknown;
          };
          const email =
            typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
          if (email && "name" in body) {
            const existing = await db
              .prepare('SELECT 1 AS one FROM "user" WHERE lower(email) = ? LIMIT 1')
              .get<{ one: number }>(email);
            if (existing) delete body.name;
          }
        }
        if (!process.env.MEMRACER_INVITE_ONLY) return;
        if (ctx.path !== "/sign-in/magic-link") return;
        const body = ctx.body as
          | { email?: unknown; metadata?: { purpose?: unknown } }
          | undefined;
        if (body?.metadata?.purpose === "invite") return;
        const email =
          typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
        // Let better-auth's own zod validation reject a missing/invalid email.
        if (!email) return;
        if (await inviteOnlyAllows(db, email)) return;
        throw new APIError("FORBIDDEN", {
          message: "Sign-ups are invite-only right now — ask an admin for an invite.",
        });
      }),
    },
    // New users only: better-auth requires a name field; we default once from the
    // email local-part (simplest acceptable ship). Returning users keep their
    // stored name; they edit it only in Settings (POST /api/auth/update-user).
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const email = typeof user.email === "string" ? user.email : "";
            const local = email.includes("@") ? email.split("@")[0]! : email;
            const name =
              typeof user.name === "string" && user.name.trim()
                ? user.name.trim()
                : local || "member";
            return { data: { ...user, name } };
          },
        },
      },
    },
    // Rate limiting OFF: an API key is a headless coder/MCP credential that the
    // fleet hammers continuously (many requests/second). better-auth's default
    // (~10 requests/day/key) would 401 the fleet in production — and every test
    // that reuses one key. Verification stays; throttling is the caller's job.
    // enableMetadata: minted keys carry { projectId, type } so a project's keys
    // are listable/scopable and a coder key is distinguishable from a human one.
    plugins: [
      organization({ ac, roles }),
      apiKey({ rateLimit: { enabled: false }, enableMetadata: true }),
      magicLink({
        expiresIn: 15 * 60,
        storeToken: "hashed",
        sendMagicLink: async ({ email, url, metadata }) => {
          await sendMagicLinkEmail(email, url, metadata?.purpose === "invite" ? "invite" : "sign-in");
        },
      }),
      mcp({
        loginPage: "/signin",
        resource: `${publicUrl}/mcp`,
        oidcConfig: {
          loginPage: "/signin",
          consentPage: "/oauth/consent",
          requirePKCE: true,
        },
      }),
    ],
  };
}

// One better-auth instance per Db. WeakMap so a closed test Db is collectable.
const registry = new WeakMap<Db, AuthHandle>();

/**
 * Build (once) and register the better-auth instance for a Db, kicking off its
 * additive migrations. Returns null when the backend exposes no better-auth
 * handle (PGlite tests) — auth is then unavailable on that Db.
 */
export function initAuth(db: Db): AuthHandle | null {
  const existing = registry.get(db);
  if (existing) return existing;
  const handle = db.authDatabase();
  if (!handle) return null;
  const options = buildAuthOptions(db, handle);
  const auth = betterAuth(options);
  // getMigrations runs better-auth's own schema additively alongside the
  // memracer tables — nothing dropped, its tables (user/session/account/
  // organization/member/apikey/invitation/verification) simply appear next
  // to ours. The invitation-token column is added AFTER those migrations run:
  // the table does not exist at openDb() time, so this is the ensureColumns /
  // postgres-tail additive pattern applied at the only point the table is live.
  const ready = getMigrations(options)
    .then(({ runMigrations }) => runMigrations())
    .then(() => ensureInvitationToken(db))
    .then(() => repairLegacyProjectAdminRoles(db));
  const record: AuthHandle = { auth, ready };
  registry.set(db, record);
  return record;
}

/**
 * Add the URL-safe join `token` column to better-auth's `invitation` table.
 * better-auth's organization plugin ships the invitation table (id,
 * organizationId, email, role, status, expiresAt, createdAt, inviterId) but no
 * token, and the copyable-join-link flow needs an unguessable, single-use
 * handle for the /join page to resolve without prior auth. Additive + nullable,
 * idempotent in both dialects — mirrors the sqlite ensureColumns / postgres
 * duplicate_column-guarded ALTER pattern used across the memracer schema.
 */
async function ensureInvitationToken(db: Db): Promise<void> {
  if (db.dialect === "postgres") {
    await db.exec(
      `DO $$ BEGIN ALTER TABLE "invitation" ADD COLUMN token TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
       CREATE UNIQUE INDEX IF NOT EXISTS idx_invitation_token ON "invitation" (token);`,
    );
    return;
  }
  const cols = await db
    .prepare("SELECT name FROM pragma_table_info('invitation')")
    .all<{ name: string }>();
  if (!cols.some((c) => c.name === "token")) {
    await db.exec('ALTER TABLE "invitation" ADD COLUMN token TEXT');
  }
  await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_invitation_token ON "invitation" (token)');
}

const ADMIN_ROLE_REPAIR_MIGRATION = "2026-07-17-admin-role-repair-v3";

/** Correct historical admin rows once, after better-auth's member tables exist. */
export async function repairLegacyProjectAdminRoles(db: Db): Promise<void> {
  await db.transaction(async () => {
    await db.exec(`CREATE TABLE IF NOT EXISTS memracer_auth_migrations (
      id TEXT PRIMARY KEY,
      applied_at BIGINT NOT NULL
    )`);
    const claimed = await db.prepare(
      `INSERT INTO memracer_auth_migrations (id, applied_at) VALUES (?, ?)
       ON CONFLICT (id) DO NOTHING`,
    ).run(ADMIN_ROLE_REPAIR_MIGRATION, Date.now());
    if (claimed.changes === 0) return;

    const projects = await db.prepare(
      `SELECT p.id, p.org_id, o.created_by AS org_created_by
         FROM projects p
         LEFT JOIN orgs o ON o.id = p.org_id
        WHERE p.created_by IS NULL
        ORDER BY p.id`,
    ).all<{ id: string; org_id: string | null; org_created_by: string | null }>();

    for (const project of projects) {
      const orgCreatorMembership = project.org_created_by
        ? await db.prepare(
            `SELECT "userId" FROM "member"
              WHERE "organizationId" = ? AND "userId" = ?`,
          ).get<{ userId: string }>(project.id, project.org_created_by)
        : undefined;
      const earliestAdmin = await db.prepare(
        `SELECT "userId" FROM "member"
          WHERE "organizationId" = ? AND role = 'admin'
          ORDER BY "createdAt" ASC, id ASC
          LIMIT 1`,
      ).get<{ userId: string }>(project.id);
      const creatorId = orgCreatorMembership?.userId ?? earliestAdmin?.userId;
      if (!creatorId) {
        console.warn(`Skipping admin-role repair for Project ${project.id}: no historical admin membership`);
        continue;
      }
      await db.prepare(
        `UPDATE "member" SET role = 'human'
          WHERE "organizationId" = ? AND role = 'admin' AND "userId" <> ?`,
      ).run(project.id, creatorId);
      await db.prepare(
        `UPDATE "member" SET role = 'admin'
          WHERE "organizationId" = ? AND "userId" = ?`,
      ).run(project.id, creatorId);
      await db.prepare(
        `UPDATE "invitation" SET role = 'human'
          WHERE "organizationId" = ? AND role = 'admin'`,
      ).run(project.id);
      await db.prepare(
        "UPDATE projects SET created_by = ? WHERE id = ?",
      ).run(creatorId, project.id);
      if (project.org_id && !project.org_created_by) {
        await db.prepare(
          "UPDATE orgs SET created_by = ? WHERE id = ? AND created_by IS NULL",
        ).run(creatorId, project.org_id);
      }
    }
  });
}

/** The registered handle for a Db, or undefined if better-auth is disabled here. */
export function authFor(db: Db): AuthHandle | undefined {
  return registry.get(db);
}

/** Await better-auth's migrations for a Db (no-op when disabled). */
export async function authReady(db: Db): Promise<void> {
  await registry.get(db)?.ready;
}
