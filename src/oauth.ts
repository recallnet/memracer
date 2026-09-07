import { randomUUID } from "node:crypto";
import express from "express";
import { fromNodeHeaders } from "better-auth/node";
import type { Db } from "./db.js";
import type { AuthHandle } from "./auth/instance.js";
import { OAUTH_SEAT_SCOPE_PREFIX, resolveSessionUser } from "./auth.js";
import { resolvePublicUrl } from "./public-hosts.js";

const OAUTH_SCOPES = "openid profile email offline_access";

interface OAuthApi {
  getMcpOAuthConfig(args: { asResponse: true }): Promise<Response>;
  getMCPProtectedResource(args: { asResponse: true }): Promise<Response>;
  mcpOAuthToken(args: { body: Record<string, unknown>; headers: Headers; asResponse: true }): Promise<Response>;
  oAuthConsent(args: {
    body: { accept: boolean; consent_code: string };
    headers: Headers;
  }): Promise<{ redirectURI: string }>;
}

interface PendingGrant {
  clientId: string;
  redirectURI: string;
  scope: string[];
  userId: string;
  requireConsent: boolean;
}

function publicBaseUrl(): string {
  return resolvePublicUrl(process.env);
}

export function mcpResource(): string {
  return `${publicBaseUrl()}/mcp`;
}

export function protectedResourceUrl(): string {
  return `${publicBaseUrl()}/.well-known/oauth-protected-resource/mcp`;
}

export function mcpWwwAuthenticate(): string {
  return `Bearer resource_metadata="${protectedResourceUrl()}", scope="${OAUTH_SCOPES}"`;
}

async function sendFetchResponse(res: express.Response, response: Response): Promise<void> {
  res.status(response.status);
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.send(Buffer.from(await response.arrayBuffer()));
}

function invalidResource(res: express.Response): void {
  res.status(400).json({ error: "invalid_target", error_description: `resource must equal ${mcpResource()}` });
}

async function pendingGrant(db: Db, code: string): Promise<PendingGrant | null> {
  const row = await db.prepare(
    `SELECT value, "expiresAt" AS expires_at FROM verification WHERE identifier = ?`,
  ).get<{ value: string; expires_at: string | number }>(code);
  if (!row || new Date(row.expires_at).getTime() <= Date.now()) return null;
  try {
    const value = JSON.parse(row.value) as PendingGrant;
    return value.requireConsent && value.userId && Array.isArray(value.scope) ? value : null;
  } catch {
    return null;
  }
}

export function registerOAuthRoutes(app: express.Express, db: Db, handle: AuthHandle): void {
  const api = handle.auth.api as unknown as OAuthApi;

  app.get(["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"], async (_req, res) => {
    await sendFetchResponse(res, await api.getMcpOAuthConfig({ asResponse: true }));
  });
  app.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], async (_req, res) => {
    await sendFetchResponse(res, await api.getMCPProtectedResource({ asResponse: true }));
  });

  app.get("/api/auth/mcp/authorize", (req, res, next) => {
    if (req.query.resource !== mcpResource()) {
      invalidResource(res);
      return;
    }
    req.query.prompt = "consent";
    const url = new URL(req.originalUrl, publicBaseUrl());
    url.searchParams.set("prompt", "consent");
    req.url = `${url.pathname}${url.search}`;
    next();
  });

  app.post(
    "/api/auth/mcp/token",
    express.urlencoded({ extended: false }),
    express.json(),
    async (req, res) => {
      if (req.body?.resource !== mcpResource()) {
        invalidResource(res);
        return;
      }
      const body = { ...req.body } as Record<string, unknown>;
      delete body.resource;
      await sendFetchResponse(res, await api.mcpOAuthToken({
        body,
        headers: fromNodeHeaders(req.headers),
        asResponse: true,
      }));
    },
  );

  app.get("/api/oauth/consent", async (req, res) => {
    const user = await resolveSessionUser(db, req.headers);
    const code = typeof req.query.consent_code === "string" ? req.query.consent_code : "";
    const grant = user && code ? await pendingGrant(db, code) : null;
    if (!user || !grant || grant.userId !== user.userId) {
      res.status(401).json({ error: "invalid or expired consent request" });
      return;
    }
    const projects = await db.prepare(
      `SELECT p.id, p.name, m.role
         FROM "member" m JOIN projects p ON p.id = m."organizationId"
        WHERE m."userId" = ? ORDER BY p.name`,
    ).all<{ id: string; name: string; role: string }>(user.userId);
    res.json({ clientId: grant.clientId, projects: projects.map(({ id, name }) => ({ id, name })) });
  });

  app.post("/api/oauth/consent", express.json(), async (req, res) => {
    const user = await resolveSessionUser(db, req.headers);
    const code = typeof req.body?.consentCode === "string" ? req.body.consentCode : "";
    const grant = user && code ? await pendingGrant(db, code) : null;
    if (!user || !grant || grant.userId !== user.userId) {
      res.status(401).json({ error: "invalid or expired consent request" });
      return;
    }
    if (req.body?.accept !== true) {
      res.json(await api.oAuthConsent({
        body: { accept: false, consent_code: code },
        headers: fromNodeHeaders(req.headers),
      }));
      return;
    }
    const projectId = typeof req.body?.projectId === "string" ? req.body.projectId : "";
    const role = req.body?.role === "coder" ? "coder" : req.body?.role === "human" ? "human" : null;
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!role || !name || name.length > 80) {
      res.status(400).json({ error: "project, role, and a seat name of at most 80 characters are required" });
      return;
    }
    const membership = await db.prepare(
      `SELECT 1 AS allowed FROM "member" WHERE "userId" = ? AND "organizationId" = ?`,
    ).get<{ allowed: number }>(user.userId, projectId);
    if (!membership) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const seatId = randomUUID();
    const seatScope = `${OAUTH_SEAT_SCOPE_PREFIX}${seatId}`;
    const now = Date.now();
    let result: { redirectURI: string };
    try {
      await db.transaction(async () => {
        const current = await pendingGrant(db, code);
        if (!current || current.userId !== user.userId || current.scope.some((scope) => scope.startsWith(OAUTH_SEAT_SCOPE_PREFIX))) {
          throw new Error("consent request was already used");
        }
        await db.prepare(
          `INSERT INTO oauth_seats (id, user_id, project_id, role, name, consent_code, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(seatId, user.userId, projectId, role, name, code, now, now);
        await db.prepare("UPDATE verification SET value = ? WHERE identifier = ?")
          .run(JSON.stringify({ ...current, scope: [...current.scope, seatScope] }), code);
      });
      result = await api.oAuthConsent({
        body: { accept: true, consent_code: code },
        headers: fromNodeHeaders(req.headers),
      });
    } catch (error) {
      await db.transaction(async () => {
        await db.prepare("DELETE FROM oauth_seats WHERE consent_code = ?").run(code);
        await db.prepare("UPDATE verification SET value = ? WHERE identifier = ?")
          .run(JSON.stringify(grant), code);
      }).catch(() => undefined);
      res.status(409).json({ error: error instanceof Error ? error.message : "consent failed" });
      return;
    }
    res.json(result);
  });
}
