import { z } from "zod";
import type { Db, SqlValue } from "../db.js";

/**
 * The dynamic read-only query escape hatch (capability C9): when the pre-built
 * context packs miss, the discuss/historian driver may invoke ONE bounded,
 * parameterized, whitelisted query over decisions/tasks/threads and ground its
 * reply in the returned rows.
 *
 * This module is the capability boundary. There is no raw-SQL surface: a query
 * is a structured descriptor over four fixed dimensions (entity / kind / time /
 * actor). The schema is `.strict()`, so any unknown key — a smuggled `sql`
 * field, a `project_id` override, a write verb — is refused at parse time. The
 * server always supplies project_id as a bound parameter; every filter value is
 * bound, never interpolated, so injection strings are inert literals.
 */

/** Hard cap on rows a single escape-hatch query may return. */
export const META_QUERY_ROW_CAP = 25;

/** Default row limit when the query omits one. */
export const META_QUERY_DEFAULT_LIMIT = 10;

/** Content excerpt cap for thread-message rows (~chars). */
const THREAD_CONTENT_CAP = 400;

export const metaQuerySchema = z
  .object({
    entity: z.enum(["tasks", "decisions", "threads"]),
    /** Entity-specific category: task state, decision kind, or thread kind. */
    kind: z.string().max(40).optional(),
    /** Who: task submitter or thread-message author. */
    actor: z.string().max(120).optional(),
    /** Lower time bound (inclusive): ISO-8601 string or epoch ms. */
    since: z.union([z.string(), z.number()]).optional(),
    /** Upper time bound (inclusive): ISO-8601 string or epoch ms. */
    until: z.union([z.string(), z.number()]).optional(),
    /** Row cap; clamped to [1, META_QUERY_ROW_CAP]. */
    limit: z.number().int().positive().optional(),
  })
  .strict();

export type MetaQuery = z.infer<typeof metaQuerySchema>;

export interface MetaQueryResult {
  entity: MetaQuery["entity"];
  rows: Record<string, SqlValue>[];
  /** Task ids present in the rows — the citable universe this result adds. */
  taskIds: number[];
  /** Decision ids present in the rows (decisions entity only). */
  decisionIds: number[];
}

/** A refusal at the capability boundary (bad shape, raw SQL, cross-project, bad time). */
export class MetaQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetaQueryError";
  }
}

interface EntitySpec {
  /** FROM clause; project scoping always via `<alias>.project_id`. */
  from: string;
  /** SELECT list (aliased columns the historian reads). */
  select: string;
  /** Column the `kind` dimension filters on, if the entity supports it. */
  kindColumn?: string;
  /** Column the `actor` dimension filters on, if the entity supports it. */
  actorColumn?: string;
  /** Column the since/until window filters on. */
  timeColumn: string;
  /** How to project a row into citable task/decision ids. */
  ids: (row: Record<string, SqlValue>) => { task?: number | null; decision?: number | null };
}

/**
 * The whitelist. Every query resolves to exactly one of these hand-authored,
 * fully parameterized templates — the only SQL that can ever run through the
 * escape hatch. Columns are fixed identifiers, never taken from the descriptor.
 */
const ENTITIES: Record<MetaQuery["entity"], EntitySpec> = {
  tasks: {
    from: "tasks t",
    select: "t.id AS id, t.title AS title, t.state AS state, t.submitted_by AS submitted_by, t.created_at AS created_at",
    kindColumn: "t.state",
    actorColumn: "t.submitted_by",
    timeColumn: "t.created_at",
    ids: (r) => ({ task: r.id as number }),
  },
  decisions: {
    from: "decision_log d",
    select: "d.id AS id, d.task_id AS task_id, d.kind AS kind, d.summary AS summary, d.created_at AS created_at",
    kindColumn: "d.kind",
    timeColumn: "d.created_at",
    ids: (r) => ({ decision: r.id as number, task: r.task_id as number | null }),
  },
  threads: {
    from: "threads th JOIN thread_messages m ON m.thread_id = th.id",
    select:
      "th.id AS thread_id, th.task_id AS task_id, th.kind AS kind, m.author AS author, m.content AS content, m.created_at AS created_at",
    kindColumn: "th.kind",
    actorColumn: "m.author",
    timeColumn: "m.created_at",
    ids: (r) => ({ task: r.task_id as number | null }),
  },
};

/** Alias carrying project_id for each entity's FROM clause. */
const PROJECT_ALIAS: Record<MetaQuery["entity"], string> = {
  tasks: "t",
  decisions: "d",
  threads: "th",
};

/** Normalize a time bound to epoch ms; refuse anything unparseable. */
function toEpochMs(v: string | number, label: string): number {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new MetaQueryError(`invalid ${label}: not a finite timestamp`);
    return v;
  }
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) throw new MetaQueryError(`invalid ${label}: not an ISO-8601 date`);
  return ms;
}

/**
 * Run one escape-hatch query. Parses at the boundary (throws MetaQueryError on
 * any refusal), then executes a whitelisted parameterized statement scoped to
 * `projectId` (server-supplied, never from the descriptor) and row-capped.
 */
export async function runMetaQuery(
  db: Db,
  projectId: string,
  raw: unknown,
): Promise<MetaQueryResult> {
  const parsed = metaQuerySchema.safeParse(raw);
  if (!parsed.success) {
    // .strict() surfaces a smuggled `sql`/`project_id`/write key as an
    // "unrecognized_keys" issue — refuse the whole query rather than guess.
    throw new MetaQueryError(`rejected at capability boundary: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  const q = parsed.data;
  const spec = ENTITIES[q.entity];

  const where: string[] = [`${PROJECT_ALIAS[q.entity]}.project_id = ?`];
  const params: SqlValue[] = [projectId];

  if (q.kind !== undefined) {
    if (!spec.kindColumn) throw new MetaQueryError(`entity '${q.entity}' has no kind dimension`);
    where.push(`${spec.kindColumn} = ?`);
    params.push(q.kind);
  }
  if (q.actor !== undefined) {
    if (!spec.actorColumn) throw new MetaQueryError(`entity '${q.entity}' has no actor dimension`);
    where.push(`${spec.actorColumn} = ?`);
    params.push(q.actor);
  }
  if (q.since !== undefined) {
    where.push(`${spec.timeColumn} >= ?`);
    params.push(toEpochMs(q.since, "since"));
  }
  if (q.until !== undefined) {
    where.push(`${spec.timeColumn} <= ?`);
    params.push(toEpochMs(q.until, "until"));
  }

  const limit = Math.min(Math.max(1, q.limit ?? META_QUERY_DEFAULT_LIMIT), META_QUERY_ROW_CAP);
  params.push(limit);

  const sql =
    `SELECT ${spec.select} FROM ${spec.from} WHERE ${where.join(" AND ")} ` +
    `ORDER BY ${spec.timeColumn} DESC, ${PROJECT_ALIAS[q.entity]}.id DESC LIMIT ?`;

  const rows = await db.prepare(sql).all<Record<string, SqlValue>>(...params);

  if (q.entity === "threads") {
    for (const r of rows) {
      const c = r.content;
      if (typeof c === "string" && c.length > THREAD_CONTENT_CAP) r.content = `${c.slice(0, THREAD_CONTENT_CAP)}…`;
    }
  }

  const taskIds = new Set<number>();
  const decisionIds = new Set<number>();
  for (const r of rows) {
    const { task, decision } = spec.ids(r);
    if (task != null) taskIds.add(task);
    if (decision != null) decisionIds.add(decision);
  }

  return { entity: q.entity, rows, taskIds: [...taskIds], decisionIds: [...decisionIds] };
}
