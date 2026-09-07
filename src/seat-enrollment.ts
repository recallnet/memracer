// Part A — seat enrollment grants. An admin mints a short-lived, single-use
// token; a teammate redeems it to mint a role-scoped seat key. Only the token's
// sha256 is stored, so a leaked database row cannot reconstruct the secret.
//
// Kept out of the (already large) dashboard.ts. The routes take their side
// effects as injected deps so the module never imports better-auth or env
// directly — dashboard.ts wires the concrete implementations.
import { randomBytes, randomUUID, createHash } from "node:crypto";
import type express from "express";
import type { Request, Response } from "express";
import type { Db } from "./db.js";
import { buildEnrollmentPrompt } from "./onboarding-prompt.js";
import { cliInstallCommand } from "./cli-install.js";

/** The npm package name new teammates install to redeem an enrollment. */
/** How long a freshly minted grant stays redeemable. */
const ENROLLMENT_TTL_MS = 15 * 60 * 1000;

/** A minted seat key — the plaintext secret is returned exactly once. */
export interface MintedSeat {
  key: string;
  keyId: string;
}

export interface SeatEnrollmentDeps {
  db: Db;
  /** Admin gate: resolves the caller/project or terminates the request (401/403/404). */
  requireProjectAdmin: (req: Request, res: Response) => Promise<{ userId: string; projectId: string } | null>;
  /** The deployed origin, e.g. https://memracer.com (no trailing slash). */
  publicBaseUrl: () => string;
  /** Human-readable project name for a project id. */
  projectName: (db: Db, projectId: string) => Promise<string>;
  /** Whether a role drives a coding agent (worktree) vs a human seat (Frigg). */
  roleIsWorker: (db: Db, projectId: string, role: string) => Promise<boolean>;
  /** Mint a role-scoped seat key owned by userId, tagged with the role. */
  mintSeat: (
    db: Db,
    args: { userId: string; projectId: string; role: string; name: string },
  ) => Promise<MintedSeat>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Register the mint (admin) and redeem (public, single-use) enrollment routes. */
export function registerSeatEnrollment(app: express.Express, deps: SeatEnrollmentDeps): void {
  const { db } = deps;

  // Admin mints a grant for a role. The plaintext token is returned once,
  // alongside a copy-paste onboarding prompt; only its hash is persisted.
  app.post("/api/p/:project/enrollments", async (req, res) => {
    const ctx = await deps.requireProjectAdmin(req, res);
    if (!ctx) return;
    // Any project role SLUG (human, coder, or a custom role like reviewer). The
    // redeemed seat's surface is derived from the role's KIND at auth time, so
    // an unknown slug still mints a safe worker seat. Default to coder.
    const role = typeof req.body?.role === "string" && req.body.role.trim() ? req.body.role.trim() : "coder";
    const token = `mzr_enrl_${randomBytes(24).toString("base64url")}`;
    const now = Date.now();
    const expiresAt = now + ENROLLMENT_TTL_MS;
    await db
      .prepare(
        `INSERT INTO seat_enrollments
           (id, project_id, role, token_hash, created_by, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), ctx.projectId, role, sha256(token), ctx.userId, expiresAt, now);

    const prompt = buildEnrollmentPrompt({
      projectName: await deps.projectName(db, ctx.projectId),
      role,
      token,
      installUrl: deps.publicBaseUrl(),
      installCommand: cliInstallCommand(),
      expiresMinutes: Math.round(ENROLLMENT_TTL_MS / 60000),
      isWorker: await deps.roleIsWorker(db, ctx.projectId, role),
    });
    res.json({ token, prompt, role, expiresAt });
  });

  // Public redemption: exchange a valid, unredeemed, unexpired token for a
  // role-scoped seat key. Single-use via a conditional UPDATE claim.
  app.post("/api/enroll/redeem", async (req, res) => {
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    if (!token) {
      res.status(400).json({ error: "token required" });
      return;
    }
    const row = await db
      .prepare(
        `SELECT id, project_id, role, created_by, expires_at, redeemed_at
           FROM seat_enrollments WHERE token_hash = ?`,
      )
      .get<{
        id: string;
        project_id: string;
        role: string;
        created_by: string;
        expires_at: number;
        redeemed_at: number | null;
      }>(sha256(token));
    if (!row) {
      res.status(404).json({ error: "unknown enrollment token" });
      return;
    }
    if (row.redeemed_at != null) {
      res.status(409).json({ error: "enrollment already redeemed" });
      return;
    }
    if (row.expires_at < Date.now()) {
      res.status(410).json({ error: "enrollment expired" });
      return;
    }

    const seatLabel = row.role === "human" ? "Human" : row.role.charAt(0).toUpperCase() + row.role.slice(1);
    const seat = await deps.mintSeat(db, {
      userId: row.created_by,
      projectId: row.project_id,
      role: row.role,
      name: `${seatLabel} seat ${randomBytes(3).toString("hex").toUpperCase()}`,
    });
    // Claim the grant. If a concurrent redemption won the race, changes === 0.
    const claim = await db
      .prepare("UPDATE seat_enrollments SET redeemed_at = ?, redeemed_key_id = ? WHERE id = ? AND redeemed_at IS NULL")
      .run(Date.now(), seat.keyId, row.id);
    if (claim.changes !== 1) {
      res.status(409).json({ error: "enrollment already redeemed" });
      return;
    }
    res.json({
      key: seat.key,
      keyId: seat.keyId,
      // `project` keeps the id for back-compat with the api client, which uses it
      // to build /api/p/:projectId/... routes; projectName is for display.
      project: row.project_id,
      projectId: row.project_id,
      projectName: await deps.projectName(db, row.project_id),
      role: row.role,
      mcpUrl: `${deps.publicBaseUrl()}/mcp`,
    });
  });
}
