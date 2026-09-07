// Part F — per-project roles. A role generalizes the hardcoded human/coder
// pair: every project seeds those two built-ins, and admins can add custom
// roles (e.g. "reviewer"). A role's KIND — 'human' or 'worker' — is what
// actually selects the MCP tool surface: a human-kind seat gets the human
// tools, every worker-kind seat (coder, reviewer, …) reuses the coder surface.
// Per-role claim filtering / model routing is a separate future plan; this
// module only owns the table, the seed, and the slug→kind lookup.
import type { Db } from "./db.js";

/** A role's tool surface. 'human' → human tools; 'worker' → coder tools. */
export type RoleKind = "human" | "worker";

export interface Role {
  projectId: string;
  slug: string;
  kind: RoleKind;
  displayName: string;
  systemPrompt: string | null;
  model: string | null;
  alwaysAvailable: boolean;
  createdAt: number;
}

interface RoleRow {
  project_id: string;
  slug: string;
  kind: string;
  display_name: string;
  system_prompt: string | null;
  model: string | null;
  always_available: number;
  created_at: number;
}

function toRole(row: RoleRow): Role {
  return {
    projectId: row.project_id,
    slug: row.slug,
    kind: row.kind === "human" ? "human" : "worker",
    displayName: row.display_name,
    systemPrompt: row.system_prompt,
    model: row.model,
    alwaysAvailable: row.always_available !== 0,
    createdAt: row.created_at,
  };
}

/**
 * Seed the two built-in roles for a project. Idempotent via ON CONFLICT DO
 * NOTHING on the (project_id, slug) primary key, so it is safe to call on every
 * project creation and to re-run. `human` is always_available (Frigg needs a
 * human seat present); `coder` drives the worker surface.
 */
export async function seedDefaultRoles(db: Db, projectId: string): Promise<void> {
  const now = Date.now();
  const insert = `INSERT INTO roles
      (project_id, slug, kind, display_name, system_prompt, model, always_available, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (project_id, slug) DO NOTHING`;
  await db.prepare(insert).run(projectId, "human", "human", "Human", null, null, 1, now);
  await db.prepare(insert).run(projectId, "coder", "worker", "Coder", null, null, 0, now);
}

/** Every role defined for a project, oldest first (human/coder lead). */
export async function listRoles(db: Db, projectId: string): Promise<Role[]> {
  const rows = await db
    .prepare(
      `SELECT project_id, slug, kind, display_name, system_prompt, model, always_available, created_at
         FROM roles WHERE project_id = ? ORDER BY created_at, slug`,
    )
    .all<RoleRow>(projectId);
  return rows.map(toRole);
}

/**
 * Resolve a role slug to its tool-surface KIND. An unknown slug returns
 * 'worker' — the safe default, so a stale or mistyped role can never escalate
 * into the human tools.
 */
export async function roleKind(db: Db, projectId: string, slug: string): Promise<RoleKind> {
  const row = await db
    .prepare("SELECT kind FROM roles WHERE project_id = ? AND slug = ?")
    .get<{ kind: string }>(projectId, slug);
  if (row) return row.kind === "human" ? "human" : "worker";
  // No roles row yet (legacy project created before the roles table, or a test
  // that inserts projects directly): fall back to the literal slug so a `human`
  // seat keeps the human surface. Only genuinely-seeded custom roles change kind.
  return slug === "human" ? "human" : "worker";
}
