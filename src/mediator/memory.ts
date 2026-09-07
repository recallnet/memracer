import type { Db } from "../db.js";
import { normalizeMemoryBody } from "./memory-body.js";
import { reciprocalGaps, type ReciprocalGap } from "./okf-links.js";
import { isProjectKnowledgeDomain, type ProjectKnowledgeDomain } from "./project-knowledge.js";

export interface MemoryDocInput {
  path: string;
  type: string;
  title: string;
  description: string;
  tags: string[];
  body: string;
  provenance?: MemoryProvenance;
}

export interface MemoryDoc extends MemoryDocInput {
  updated_at: number;
}

export interface MemoryProvenance {
  sourceTask?: number;
  asOf?: string;
  supersedes?: string[];
  supersededBy?: string[];
}

export interface MemoryDocSummary {
  path: string;
  type: string;
  title: string;
  description: string;
  updated_at: number;
}

export interface DigestOptions {
  /** Total digest budget in characters (default 6000). */
  maxChars?: number;
  /** Max concepts rendered in full (default 3). */
  maxConcepts?: number;
}

/** Result of rendering and checking the complete generated OKF bundle. */
export interface BundleValidationResult {
  ok: boolean;
  concepts: number;
  index_rendered: boolean;
  graph_consistent: boolean;
  reciprocal_gaps: ReciprocalGap[];
  errors: string[];
}

/** Summary of an idempotent, cross-project startup body repair. */
export interface MemoryBodyRepairResult {
  scanned: number;
  repaired: number;
}

const PATH_RE = /^[a-z0-9-]+(\/[a-z0-9-]+)*\.md$/;
const isReservedPath = (path: string) => path === "index.md" || path === "log.md" || path.endsWith("/index.md") || path.endsWith("/log.md");

/** YAML scalar via JSON string encoding — valid YAML, no injection. */
const yamlStr = (s: string) => JSON.stringify(s);

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

/** Structural body templates per type (the authoring contract's skeleton). */
const DECISION_TEMPLATE = "# Context\n\n# Rationale\n\n# Status\n\n# Consequences\n\n# Citations\n";
const TYPE_TEMPLATES: Record<string, string> = {
  Decision: DECISION_TEMPLATE,
  Convention: "# Rule\n\n# Rationale\n\n# Applies to\n\n# Citations\n",
  Risk: "# Risk\n\n# Impact\n\n# Mitigation\n\n# Status\n\n# Citations\n",
  Learning: "# What we learned\n\n# Evidence\n\n# Consequence\n\n# Citations\n",
  Architecture: "# Overview\n\n# Components\n\n# Data flow\n\n# Citations\n",
  Reference: "# Summary\n\n# Details\n\n# Citations\n",
  Runbook: "# When to use\n\n# Steps\n\n# Verification\n\n# Citations\n",
};

/** An optional structural body template for known types (empty for any other type). */
export function templateFor(type: string): string {
  return TYPE_TEMPLATES[type] ?? "";
}

export interface ValidationOk {
  ok: true;
}
export interface ValidationError {
  ok: false;
  reason: string;
}
export type ValidationResult = ValidationOk | ValidationError;

/**
 * OKF conformance gate for a concept upsert. A concept has one non-empty,
 * free-form descriptive type and a kebab-case Markdown path. Generated index
 * and log paths remain server-owned. Curation quality belongs to mediator
 * guidance and evals rather than an invented OKF schema.
 */
export function validateMemoryDoc(doc: MemoryDocInput): ValidationResult {
  if (!PATH_RE.test(doc.path)) return { ok: false, reason: `invalid memory path: ${doc.path}` };
  if (isReservedPath(doc.path)) return { ok: false, reason: `reserved memory path: ${doc.path}` };
  if (doc.type.trim().length === 0) return { ok: false, reason: "memory type must be non-empty" };
  const provenance = doc.provenance;
  if (provenance?.sourceTask !== undefined && (!Number.isInteger(provenance.sourceTask) || provenance.sourceTask <= 0)) {
    return { ok: false, reason: "memory provenance source_task must be a positive integer" };
  }
  if (provenance?.asOf !== undefined && Number.isNaN(Date.parse(provenance.asOf))) {
    return { ok: false, reason: "memory provenance as_of must be an ISO-8601 timestamp" };
  }
  for (const [field, values] of [
    ["supersedes", provenance?.supersedes],
    ["superseded_by", provenance?.supersededBy],
  ] as const) {
    if (values !== undefined && (!Array.isArray(values) || values.some((value) => typeof value !== "string"))) {
      return { ok: false, reason: `memory provenance ${field} must be a string array` };
    }
  }
  return { ok: true };
}

type PersistMode = "upsert" | "create" | "update";

interface StoredProvenance {
  source_task: number | null;
  as_of: string | null;
  supersedes: string;
  superseded_by: string;
  updated_at: number;
}

function parseList(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function provenanceFromRow(row: StoredProvenance | undefined): MemoryProvenance {
  if (!row) return {};
  return {
    ...(row.source_task === null ? {} : { sourceTask: row.source_task }),
    ...(row.as_of === null ? {} : { asOf: row.as_of }),
    ...(parseList(row.supersedes).length === 0 ? {} : { supersedes: parseList(row.supersedes) }),
    ...(parseList(row.superseded_by).length === 0 ? {} : { supersededBy: parseList(row.superseded_by) }),
  };
}

/**
 * The mediator's private per-project memory: an OKF v0.1 bundle stored in
 * SQLite. Concepts live as rows; index.md and log.md are generated, never
 * stored, so the bundle is conformant by construction.
 */
export class MemoryStore {
  constructor(private readonly db: Db) {}

  async upsert(projectId: string, doc: MemoryDocInput): Promise<void> {
    await this.persist(projectId, doc, "upsert");
  }

  async create(projectId: string, doc: MemoryDocInput): Promise<void> {
    await this.persist(projectId, doc, "create");
  }

  async update(projectId: string, doc: MemoryDocInput, expectedUpdatedAt: number): Promise<void> {
    await this.persist(projectId, doc, "update", expectedUpdatedAt);
  }

  private async persist(
    projectId: string,
    doc: MemoryDocInput,
    mode: PersistMode,
    expectedUpdatedAt?: number,
  ): Promise<void> {
    const verdict = validateMemoryDoc(doc);
    if (!verdict.ok) throw new Error(verdict.reason);
    const domains = doc.tags
      .filter((tag) => tag.startsWith("domain:"))
      .map((tag) => tag.slice("domain:".length))
      .filter(isProjectKnowledgeDomain) as ProjectKnowledgeDomain[];
    const body = normalizeMemoryBody(doc.body);
    await this.db.transaction(async () => {
      const existing = await this.db.prepare(
        `SELECT source_task, as_of, supersedes, superseded_by, updated_at
           FROM memory_docs WHERE project_id=? AND path=?`,
      ).get<StoredProvenance>(projectId, doc.path);
      if (mode === "create" && existing) throw new Error(`memory concept already exists: ${doc.path}; use okf_update`);
      if (mode === "update" && !existing) throw new Error(`memory concept not found: ${doc.path}`);
      if (mode === "update" && existing!.updated_at !== expectedUpdatedAt) {
        throw new Error(`memory concept changed concurrently: ${doc.path}; read it again before updating`);
      }
      const provenance = { ...provenanceFromRow(existing), ...doc.provenance };
      if (provenance.sourceTask !== undefined) {
        // Serialize provenance publication against task merge. The merge owns
        // the same task-row lock, so a writer either lands before retargeting
        // or observes that its stale source id has already been deleted.
        const reserved = await this.db
          .prepare("UPDATE tasks SET updated_at=updated_at WHERE id=? AND project_id=? RETURNING id")
          .get<{ id: number }>(provenance.sourceTask, projectId);
        if (!reserved) {
          throw new Error(`memory provenance source task ${provenance.sourceTask} no longer exists in project ${projectId}`);
        }
      }
      const now = Math.max(Date.now(), (existing?.updated_at ?? 0) + 1);
      const params = [
        doc.type,
        doc.title,
        doc.description,
        JSON.stringify(doc.tags),
        body,
        now,
        provenance.sourceTask ?? null,
        provenance.asOf ?? null,
        JSON.stringify(provenance.supersedes ?? []),
        JSON.stringify(provenance.supersededBy ?? []),
      ] as const;
      if (!existing) {
        const inserted = await this.db.prepare(
          `INSERT INTO memory_docs
             (project_id, path, type, title, description, tags, body, updated_at,
              source_task, as_of, supersedes, superseded_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        ).run(projectId, doc.path, ...params);
        if (inserted.changes !== 1) throw new Error(`memory concept already exists: ${doc.path}; read it before updating`);
      } else if (mode === "update") {
        const updated = await this.db.prepare(
          `UPDATE memory_docs SET
             type=?, title=?, description=?, tags=?, body=?, updated_at=?,
             source_task=?, as_of=?, supersedes=?, superseded_by=?
           WHERE project_id=? AND path=? AND updated_at=?`,
        ).run(...params, projectId, doc.path, expectedUpdatedAt!);
        if (updated.changes !== 1) {
          throw new Error(`memory concept changed concurrently: ${doc.path}; read it again before updating`);
        }
      } else {
        await this.db.prepare(
          `UPDATE memory_docs SET
             type=?, title=?, description=?, tags=?, body=?, updated_at=?,
             source_task=?, as_of=?, supersedes=?, superseded_by=?
           WHERE project_id=? AND path=?`,
        ).run(...params, projectId, doc.path);
      }
      for (const domain of new Set(domains)) {
        await this.db.prepare(
          `INSERT INTO project_context_domains
             (project_id, domain, last_refreshed_at, last_checked_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (project_id, domain) DO UPDATE SET
             last_refreshed_at=excluded.last_refreshed_at`,
        ).run(projectId, domain, now, null);
      }
    });
  }

  /**
   * Repair legacy malformed bodies across every project without changing any
   * concept metadata or freshness timestamps. The body predicate is a
   * compare-and-swap guard: if another writer changes a row after the scan,
   * repair never overwrites that newer value. Normal writes pass through the
   * same normalizer, so either ordering converges on a clean body.
   */
  async repairMalformedBodies(): Promise<MemoryBodyRepairResult> {
    return this.db.transaction(async () => {
      const rows = await this.db
        .prepare("SELECT project_id, path, body FROM memory_docs ORDER BY project_id, path")
        .all<{ project_id: string; path: string; body: string }>();
      const update = this.db.prepare(
        "UPDATE memory_docs SET body=? WHERE project_id=? AND path=? AND body=?",
      );
      let repaired = 0;
      for (const row of rows) {
        const body = normalizeMemoryBody(row.body);
        if (body === row.body) continue;
        const result = await update.run(body, row.project_id, row.path, row.body);
        repaired += result.changes;
      }
      return { scanned: rows.length, repaired };
    });
  }

  async remove(projectId: string, path: string): Promise<void> {
    await this.db.prepare("DELETE FROM memory_docs WHERE project_id=? AND path=?").run(projectId, path);
  }

  async list(projectId: string): Promise<MemoryDocSummary[]> {
    return this.db
      .prepare("SELECT path, type, title, description, updated_at FROM memory_docs WHERE project_id=? ORDER BY path")
      .all<MemoryDocSummary>(projectId);
  }

  async get(projectId: string, path: string): Promise<MemoryDoc | null> {
    const row = await this.db
      .prepare(
        `SELECT path, type, title, description, tags, body, updated_at,
                source_task, as_of, supersedes, superseded_by
           FROM memory_docs WHERE project_id=? AND path=?`,
      )
      .get<Omit<MemoryDoc, "tags" | "provenance"> & { tags: string } & StoredProvenance>(projectId, path);
    if (!row) return null;
    const { source_task: _sourceTask, as_of: _asOf, supersedes: _supersedes, superseded_by: _supersededBy, ...doc } = row;
    const provenance = provenanceFromRow(row);
    return {
      ...doc,
      tags: JSON.parse(row.tags) as string[],
      ...(Object.keys(provenance).length === 0 ? {} : { provenance }),
    };
  }

  /**
   * Append a curation-log line. `taskId` attributes the entry to the task
   * whose decision triggered the curate pass (#86); omitted for entries with
   * no task context (e.g. skipped-op notices), which then belong to no task
   * timeline.
   */
  async appendLog(projectId: string, entry: string, taskId?: number): Promise<void> {
    await this.db
      .prepare("INSERT INTO memory_log (project_id, entry, task_id, created_at) VALUES (?, ?, ?, ?)")
      .run(projectId, entry, taskId ?? null, Date.now());
  }

  /** Generated index.md files for the bundle root and every concept directory. */
  async renderIndexes(projectId: string): Promise<Map<string, string>> {
    const docs = await this.list(projectId);
    const directories = new Set([""]);
    for (const doc of docs) {
      const segments = doc.path.split("/").slice(0, -1);
      for (let depth = 1; depth <= segments.length; depth += 1) directories.add(segments.slice(0, depth).join("/"));
    }
    const indexes = new Map<string, string>();
    for (const directory of [...directories].sort()) {
      const prefix = directory ? `${directory}/` : "";
      const childDirectories = [...directories]
        .filter((candidate) => candidate.startsWith(prefix) && candidate !== directory && !candidate.slice(prefix.length).includes("/"))
        .map((candidate) => candidate.slice(prefix.length));
      const concepts = docs.filter((doc) => {
        const relative = doc.path.slice(prefix.length);
        return doc.path.startsWith(prefix) && !relative.includes("/");
      });
      const sections: string[] = [];
      if (childDirectories.length > 0) {
        sections.push(`# Directories\n\n${childDirectories.map((name) => `- [${name}](${name}/) - Browse ${name} knowledge.`).join("\n")}`);
      }
      if (concepts.length > 0) {
        sections.push(`# Concepts\n\n${concepts.map((doc) => `- [${doc.title}](${doc.path.slice(prefix.length)}) - ${doc.description}`).join("\n")}`);
      }
      const frontmatter = directory === "" ? ['---\nokf_version: "0.1"\n---'] : [];
      indexes.set(directory ? `${directory}/index.md` : "index.md", [...frontmatter, ...sections].join("\n\n") + "\n");
    }
    return indexes;
  }

  /** Generated bundle-root index.md. */
  async renderIndex(projectId: string): Promise<string> {
    return (await this.renderIndexes(projectId)).get("index.md")!;
  }

  /** Full concept markdown with composed frontmatter — conformant by construction. */
  renderConcept(doc: MemoryDoc): string {
    const timestamp = new Date(doc.updated_at).toISOString();
    return [
      "---",
      `type: ${yamlStr(doc.type)}`,
      `title: ${yamlStr(doc.title)}`,
      `description: ${yamlStr(doc.description)}`,
      `tags: [${doc.tags.map(yamlStr).join(",")}]`,
      `timestamp: ${timestamp}`,
      ...(doc.provenance?.sourceTask === undefined ? [] : [`source_task: ${doc.provenance.sourceTask}`]),
      ...(doc.provenance?.asOf === undefined ? [] : [`as_of: ${yamlStr(doc.provenance.asOf)}`]),
      ...(doc.provenance?.supersedes === undefined ? [] : [`supersedes: [${doc.provenance.supersedes.map(yamlStr).join(",")}]`]),
      ...(doc.provenance?.supersededBy === undefined ? [] : [`superseded_by: [${doc.provenance.supersededBy.map(yamlStr).join(",")}]`]),
      "---",
      "",
      doc.body,
      "",
    ].join("\n");
  }

  /**
   * Bundle-level tail check for agentic curation. Individual upserts remain the
   * first gate; this makes the generated index, every rendered concept, and
   * the reciprocal-link graph observable after a multi-asset update.
   */
  async validateBundle(projectId: string): Promise<BundleValidationResult> {
    const docs = await Promise.all((await this.list(projectId)).map((summary) => this.get(projectId, summary.path)));
    const concepts = docs.filter((doc): doc is MemoryDoc => doc !== null);
    const errors: string[] = [];
    let indexesValid = true;

    const indexes = await this.renderIndexes(projectId);
    const rootIndex = indexes.get("index.md") ?? "";
    if (!rootIndex.startsWith('---\nokf_version: "0.1"\n---')) {
      indexesValid = false;
      errors.push("generated index is missing OKF v0.1 frontmatter");
    }
    for (const [path, content] of indexes) {
      if (path !== "index.md" && content.startsWith("---\n")) {
        indexesValid = false;
        errors.push(`${path}: generated directory index has frontmatter`);
      }
    }

    for (const doc of concepts) {
      const rendered = this.renderConcept(doc);
      if (!rendered.startsWith("---\n") || !rendered.includes("\n---\n")) {
        errors.push(`${doc.path}: rendered concept is missing frontmatter`);
      }
      for (const field of ["type:", "title:", "description:", "tags:", "timestamp:"]) {
        if (!rendered.includes(`\n${field}`)) errors.push(`${doc.path}: rendered concept is missing ${field.slice(0, -1)}`);
      }
    }

    // Stored projects may still carry the original seeded nested backlink
    // bytes (`core-assets.md` from inside conventions/, decisions/, risks/).
    // Keep the general project validator upgrade-compatible; consolidation
    // candidate validation opts into strict relative resolution explicitly.
    const reciprocal_gaps = reciprocalGaps(concepts, { allowLegacyRootPaths: true });
    return {
      ok: errors.length === 0,
      concepts: concepts.length,
      index_rendered: indexesValid,
      graph_consistent: reciprocal_gaps.length === 0,
      reciprocal_gaps,
      errors,
    };
  }

  /**
   * Context-pack digest: the index plus the full bodies of the concepts most
   * relevant to queryText (case-insensitive word overlap on title +
   * description + tags). Whole concepts only; a cut is noted, never silent.
   */
  async digest(projectId: string, queryText: string, opts: DigestOptions = {}): Promise<string> {
    const maxChars = opts.maxChars ?? 6000;
    const maxConcepts = opts.maxConcepts ?? 3;
    const query = words(queryText);
    const docs = await this.list(projectId);
    const pinned = docs.find((d) => d.path === "questions/open-questions.md");
    const scored: { d: MemoryDocSummary; score: number }[] = [];
    for (const d of docs) {
      if (d.path === pinned?.path) continue;
      const doc = (await this.get(projectId, d.path))!;
      const haystack = words(`${d.title} ${d.description} ${doc.tags.join(" ")}`);
      let score = 0;
      for (const w of query) if (haystack.has(w)) score++;
      if (score > 0) scored.push({ d, score });
    }
    scored.sort((a, b) => b.score - a.score || a.d.path.localeCompare(b.d.path));
    const top = [
      ...(pinned ? [{ d: pinned, score: Number.POSITIVE_INFINITY }] : []),
      ...scored.slice(0, Math.max(0, maxConcepts - (pinned ? 1 : 0))),
    ];

    const parts = [await this.renderIndex(projectId)];
    let used = parts[0].length;
    let cut = 0;
    for (const { d } of top) {
      const rendered = this.renderConcept((await this.get(projectId, d.path))!);
      if (used + rendered.length > maxChars) {
        cut++;
        continue;
      }
      parts.push(rendered);
      used += rendered.length;
    }
    if (cut > 0) parts.push(`…and ${cut} more concepts`);
    return parts.join("\n");
  }
}
