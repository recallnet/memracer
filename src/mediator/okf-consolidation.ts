import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { Db } from "../db.js";
import {
  mapMarkdownProse,
  normalizeMarkdownHref,
  parseLinks,
  reciprocalGaps,
} from "./okf-links.js";
import {
  type MemoryDocInput,
  MemoryStore,
  validateMemoryDoc,
} from "./memory.js";
import {
  type MemorySnapshot,
  type SnapshotDoc,
  snapshotProjectMemory,
  snapshotsEquivalent,
} from "./okf-migration.js";

const PLAN_VERSION = 1 as const;
const MARKDOWN_CONCEPT_LINK_RE = /(\]\()([^)]+?\.md(?:[?#][^)]*)?)(\))/g;
const SYSTEM_OWNED_PATHS = new Set(["questions/open-questions.md"]);

export interface SourceConsolidationPreservation {
  /** Verbatim durable assertions from this source that must occur in target. */
  claims: string[];
  /** Extra provenance lines beyond this source's automatically preserved Citations section. */
  citations?: string[];
  /** Non-durable citation lines intentionally dropped, each with a reviewable reason. */
  omitCitations?: { citation: string; reason: string }[];
  /** Explicit legacy href → canonical source-path aliases reviewed for this source. */
  linkAliases?: Record<string, string>;
}

export interface ConsolidationPreservation {
  /** Exact per-source coverage; every sourcePath needs one entry. */
  bySource: Record<string, SourceConsolidationPreservation>;
}

export interface ConsolidationOperationInput {
  /** Existing concepts whose claims/citations this target reads. May overlap another operation. */
  sourcePaths: string[];
  /** Sources this operation owns and removes. Defaults to sourcePaths; use [] for the read-only half of a split. */
  removePaths?: string[];
  /** The reviewed semantic result. The engine never invents or summarizes claims. */
  target: MemoryDocInput;
  preserve: ConsolidationPreservation;
  /** Decode and remove a legacy literal `---\\n...\\n---` body prefix. */
  sanitizeEscapedFrontmatter?: boolean;
}

export interface ConsolidationSpec {
  projectId: string;
  /** Task whose reviewed migration is recorded in the durable memory log. */
  auditTaskId: number;
  /** Exact existing paths accounted for by source-to-target operations. */
  sourceManifest: string[];
  /** Exact final concept paths, including protected system-owned concepts. */
  expectedResultPaths: string[];
  operations: ConsolidationOperationInput[];
}

export interface PlannedConsolidationOperation {
  sourcePaths: string[];
  removePaths: string[];
  targetPath: string;
  sourceCoverage: Record<string, SourceConsolidationPreservation>;
  sanitizeEscapedFrontmatter: boolean;
}

export interface ProjectMemoryConsolidationPlan {
  version: typeof PLAN_VERSION;
  projectId: string;
  auditTaskId: number;
  createdAt: number;
  sourceWatermark: string;
  resultWatermark: string;
  snapshot: MemorySnapshot;
  sourceManifest: string[];
  expectedResultPaths: string[];
  operations: PlannedConsolidationOperation[];
  candidateDocs: SnapshotDoc[];
  removedPaths: string[];
  linkRewrites: number;
  reciprocalLinksAdded: number;
}

export interface ConsolidationRunResult {
  status: "dry_run" | "applied" | "already_applied";
  projectId: string;
  sourceWatermark: string;
  resultWatermark: string;
  conceptsBefore: number;
  conceptsAfter: number;
  removedPaths: string[];
  linkRewrites: number;
  reciprocalLinksAdded: number;
  snapshot: MemorySnapshot;
}

export class StaleConsolidationPlanError extends Error {
  constructor(expected: string, actual: string) {
    super(`memory changed after consolidation planning (expected ${expected}, found ${actual}); refusing to replace`);
    this.name = "StaleConsolidationPlanError";
  }
}

function canonicalDocs(docs: SnapshotDoc[]): string {
  for (const doc of docs) {
    if (!Number.isSafeInteger(doc.updated_at)) {
      throw new Error(`memory doc ${doc.path || "<unknown>"} has an invalid updated_at`);
    }
  }
  return JSON.stringify(
    [...docs]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((doc) => ({
        path: doc.path,
        type: doc.type,
        title: doc.title,
        description: doc.description,
        tags: [...doc.tags],
        body: doc.body,
        updated_at: doc.updated_at,
      })),
  );
}

/** Stable digest of every concept byte that affects a consolidation. */
export function memoryDocsWatermark(docs: SnapshotDoc[]): string {
  return createHash("sha256").update(canonicalDocs(docs)).digest("hex");
}

/** Portable recovery JSON; parsing it is part of every planning preflight. */
export function serializeRecoverySnapshot(snapshot: MemorySnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

export function parseRecoverySnapshot(text: string): MemorySnapshot {
  const parsed = JSON.parse(text) as Partial<MemorySnapshot>;
  if (
    typeof parsed.project_id !== "string"
    || typeof parsed.taken_at !== "number"
    || !Array.isArray(parsed.docs)
    || !Array.isArray(parsed.log)
  ) {
    throw new Error("invalid project-memory recovery snapshot");
  }
  for (const doc of parsed.docs) {
    if (!doc || typeof doc !== "object" || !Number.isSafeInteger((doc as { updated_at?: unknown }).updated_at)) {
      throw new Error("invalid project-memory recovery snapshot: every memory doc requires a safe integer updated_at");
    }
  }
  for (const row of parsed.log) {
    if (
      !row || typeof row !== "object"
      || !Number.isSafeInteger((row as { id?: unknown }).id)
      || typeof (row as { entry?: unknown }).entry !== "string"
      || !Number.isSafeInteger((row as { created_at?: unknown }).created_at)
      || ((row as { task_id?: unknown }).task_id !== null && !Number.isSafeInteger((row as { task_id?: unknown }).task_id))
    ) {
      throw new Error("invalid project-memory recovery snapshot: every memory_log row requires its original integer id");
    }
  }
  return parsed as MemorySnapshot;
}

function compact(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function containsText(haystack: string, needle: string): boolean {
  return compact(haystack).includes(compact(needle));
}

function hrefPath(href: string): string {
  const raw = href.trim().replace(/^<|>$/g, "");
  const cut = raw.search(/[?#]/);
  return cut < 0 ? raw : raw.slice(0, cut);
}

function hrefSuffix(href: string): string {
  const raw = href.trim().replace(/^<|>$/g, "");
  const cut = raw.search(/[?#]/);
  return cut < 0 ? "" : raw.slice(cut);
}

function resolveKnownHref(
  fromPath: string,
  href: string,
  knownPaths: Set<string>,
  options: { allowLegacyRootPaths?: boolean; aliases?: ReadonlyMap<string, string> } = {},
): string | null {
  const raw = hrefPath(href);
  const alias = options.aliases?.get(raw);
  if (alias && knownPaths.has(alias)) return alias;
  const normalized = normalizeMarkdownHref(fromPath, href);
  if (normalized && knownPaths.has(normalized)) return normalized;
  if (options.allowLegacyRootPaths === false) return null;
  if (!raw.startsWith("/") && !raw.startsWith("../")) {
    const legacy = posix.normalize(raw);
    if (knownPaths.has(legacy)) return legacy;
  }
  return null;
}

function relativeHref(fromPath: string, toPath: string, rooted = false): string {
  if (rooted) return `/${toPath}`;
  const relative = posix.relative(posix.dirname(fromPath), toPath);
  return relative || posix.basename(toPath);
}

/** Rewrite links to absorbed concepts while preserving labels and anchors. */
export function rewriteConsolidatedMarkdownLinks(
  body: string,
  fromPath: string,
  redirects: ReadonlyMap<string, string>,
  knownPaths: ReadonlySet<string>,
  outputFromPath = fromPath,
  aliases: ReadonlyMap<string, string> = new Map(),
): { body: string; rewrites: number } {
  let rewrites = 0;
  const rewritten = mapMarkdownProse(body, (prose) => prose.replace(
    MARKDOWN_CONCEPT_LINK_RE,
    (whole: string, open: string, href: string, close: string) => {
      const resolved = resolveKnownHref(fromPath, href, new Set(knownPaths), { aliases });
      const target = resolved ? redirects.get(resolved) : undefined;
      if (!target || (target === resolved && outputFromPath === fromPath)) return whole;
      rewrites += 1;
      const next = `${relativeHref(outputFromPath, target, href.trim().startsWith("/"))}${hrefSuffix(href)}`;
      return `${open}${next}${close}`;
    },
  ));
  return { body: rewritten, rewrites };
}

/** Remove the known legacy artifact only when a manifest opts into it. */
export function sanitizeLiteralEscapedFrontmatter(body: string): string {
  const leading = body.match(/^\s*/)?.[0] ?? "";
  const rest = body.slice(leading.length);
  if (!rest.startsWith("---\\n")) return body;
  const decoded = rest.replace(/\\r\\n|\\n/g, "\n");
  const without = decoded.replace(/^---\n[\s\S]*?\n---(?:\n|$)/, "");
  if (without === decoded) throw new Error("literal escaped frontmatter is missing its closing delimiter");
  return `${leading}${without.replace(/^\s+/, "")}`;
}

function citationLines(body: string): string[] {
  const lines = body.split("\n");
  const heading = lines.findIndex((line) => /^#{1,6}\s+Citations\s*$/i.test(line.trim()));
  if (heading < 0) return [];
  const level = lines[heading].trim().match(/^#+/)![0].length;
  const out: string[] = [];
  for (const line of lines.slice(heading + 1)) {
    if (line.trim() === "---") break;
    const nextHeading = line.trim().match(/^(#{1,6})\s+/);
    if (nextHeading && nextHeading[1].length <= level) break;
    if (nextHeading) continue;
    const value = line.trim().replace(/^[-*]\s+/, "");
    if (value) out.push(value);
  }
  return out;
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function assertSourceCoverage(
  targetPath: string,
  sourcePaths: string[],
  coverage: Record<string, SourceConsolidationPreservation> | undefined,
): void {
  if (!coverage || typeof coverage !== "object" || Array.isArray(coverage)) {
    throw new Error(`consolidation into ${targetPath} requires per-source preservation coverage`);
  }
  const expected = sortedUnique(sourcePaths);
  const actual = Object.keys(coverage).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(`consolidation into ${targetPath} must cover every source exactly (expected=${expected.join(",")}; actual=${actual.join(",")})`);
  }
  for (const sourcePath of expected) {
    const item = coverage[sourcePath];
    if (!item || !Array.isArray(item.claims) || item.claims.length === 0) {
      throw new Error(`consolidation into ${targetPath} requires at least one preserved claim from ${sourcePath}`);
    }
    if (item.citations !== undefined && !Array.isArray(item.citations)) {
      throw new Error(`consolidation into ${targetPath} has invalid citations for ${sourcePath}`);
    }
    if (item.omitCitations !== undefined && !Array.isArray(item.omitCitations)) {
      throw new Error(`consolidation into ${targetPath} has invalid citation omissions for ${sourcePath}`);
    }
    if (item.linkAliases !== undefined && (!item.linkAliases || typeof item.linkAliases !== "object" || Array.isArray(item.linkAliases))) {
      throw new Error(`consolidation into ${targetPath} has invalid link aliases for ${sourcePath}`);
    }
    for (const omission of item.omitCitations ?? []) {
      if (!omission || typeof omission.citation !== "string" || !omission.citation.trim() || typeof omission.reason !== "string" || !omission.reason.trim()) {
        throw new Error(`consolidation into ${targetPath} requires a citation and reason for every omission from ${sourcePath}`);
      }
    }
  }
}

function verifyOperationPreservation(
  operation: PlannedConsolidationOperation,
  original: ReadonlyMap<string, SnapshotDoc>,
  candidate: ReadonlyMap<string, SnapshotDoc>,
  redirects: ReadonlyMap<string, string>,
): void {
  assertSourceCoverage(operation.targetPath, operation.sourcePaths, operation.sourceCoverage);
  const target = candidate.get(operation.targetPath);
  if (!target) throw new Error(`consolidation target is absent from candidate bundle: ${operation.targetPath}`);
  const knownPaths = new Set(original.keys());
  for (const sourcePath of operation.sourcePaths) {
    const rawSource = original.get(sourcePath);
    if (!rawSource) throw new Error(`source concept not found in plan snapshot: ${sourcePath}`);
    const source = operation.sanitizeEscapedFrontmatter
      ? { ...rawSource, body: sanitizeLiteralEscapedFrontmatter(rawSource.body) }
      : rawSource;
    const coverage = operation.sourceCoverage[sourcePath];
    const aliases = new Map(Object.entries(coverage.linkAliases ?? {}));
    for (const [href, canonicalPath] of aliases) {
      if (!href.trim() || !knownPaths.has(canonicalPath)) {
        throw new Error(`invalid reviewed link alias in ${sourcePath}: ${href} -> ${canonicalPath}`);
      }
    }
    for (const claim of sortedUnique(coverage.claims)) {
      if (!containsText(source.body, claim)) {
        throw new Error(`preserved claim is absent from source ${sourcePath} for ${target.path}: ${claim}`);
      }
      const expected = rewriteConsolidatedMarkdownLinks(claim, source.path, redirects, knownPaths, target.path, aliases).body;
      if (!containsText(target.body, expected)) throw new Error(`target ${target.path} drops preserved claim from ${sourcePath}: ${claim}`);
    }

    const extracted = citationLines(source.body);
    const omissions = coverage.omitCitations ?? [];
    for (const omission of omissions) {
      if (!extracted.some((citation) => compact(citation) === compact(omission.citation))) {
        throw new Error(`citation omission is absent from source ${sourcePath}: ${omission.citation}`);
      }
    }
    for (const citation of coverage.citations ?? []) {
      if (!containsText(source.body, citation)) {
        throw new Error(`preserved citation is absent from source ${sourcePath}: ${citation}`);
      }
    }
    const required = sortedUnique([
      ...extracted.filter((citation) => !omissions.some((omission) => compact(omission.citation) === compact(citation))),
      ...(coverage.citations ?? []),
    ]);
    for (const citation of required) {
      const expected = rewriteConsolidatedMarkdownLinks(citation, source.path, redirects, knownPaths, target.path, aliases).body;
      if (!containsText(target.body, expected)) throw new Error(`target ${target.path} drops citation from ${sourcePath}: ${citation}`);
    }
  }
}

function asInput(doc: SnapshotDoc): MemoryDocInput {
  return {
    path: doc.path,
    type: doc.type,
    title: doc.title,
    description: doc.description,
    tags: doc.tags,
    body: doc.body,
  };
}

function validateCandidateDocs(docs: SnapshotDoc[]): void {
  const byPath = new Map<string, SnapshotDoc>();
  for (const doc of docs) {
    if (!Number.isSafeInteger(doc.updated_at)) throw new Error(`${doc.path}: updated_at must be a safe integer`);
    if (byPath.has(doc.path)) throw new Error(`duplicate candidate path: ${doc.path}`);
    byPath.set(doc.path, doc);
  }
  for (const doc of docs) {
    const verdict = validateMemoryDoc(asInput(doc));
    if (!verdict.ok) throw new Error(`${doc.path}: ${verdict.reason}`);
  }
  const virtualIndexes = new Set(["index.md"]);
  for (const doc of docs) {
    const parts = doc.path.split("/").slice(0, -1);
    for (let depth = 1; depth <= parts.length; depth += 1) {
      virtualIndexes.add(`${parts.slice(0, depth).join("/")}/index.md`);
    }
  }
  const knownPaths = new Set([...byPath.keys(), ...virtualIndexes]);
  for (const doc of docs) {
    for (const href of parseLinks(doc.body).hrefs) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) continue;
      if (!resolveKnownHref(doc.path, href, knownPaths, { allowLegacyRootPaths: false })) {
        throw new Error(`${doc.path}: unresolved concept href ${href}`);
      }
    }
  }
  const gaps = reciprocalGaps(docs, { allowLegacyRootPaths: false });
  if (gaps.length > 0) {
    throw new Error(`candidate bundle has reciprocal-link gaps: ${gaps.map((gap) => `${gap.from}->${gap.to}`).join(", ")}`);
  }
}

function addReciprocalLinks(
  docs: SnapshotDoc[],
  updatedAt: number,
  protectedPaths: ReadonlySet<string>,
): { docs: SnapshotDoc[]; added: number } {
  const gaps = reciprocalGaps(docs, { allowLegacyRootPaths: false });
  if (gaps.length === 0) return { docs, added: 0 };
  const byPath = new Map(docs.map((doc) => [doc.path, { ...doc, tags: [...doc.tags] }]));
  const additions = new Map<string, string[]>();
  for (const gap of gaps) {
    if (protectedPaths.has(gap.to)) {
      throw new Error(`system-owned ${gap.to} would require a reciprocal-link rewrite from ${gap.from}`);
    }
    const from = byPath.get(gap.from)!;
    const label = from.title.replace(/[\[\]]/g, "");
    const bullet = `- [${label}](${relativeHref(gap.to, gap.from)})`;
    const list = additions.get(gap.to) ?? [];
    list.push(bullet);
    additions.set(gap.to, list);
  }
  for (const [path, bullets] of [...additions].sort(([a], [b]) => a.localeCompare(b))) {
    const doc = byPath.get(path)!;
    doc.body = `${doc.body.trimEnd()}\n\n# Consolidation links\n\n${[...new Set(bullets)].sort().join("\n")}\n`;
    doc.updated_at = updatedAt;
  }
  const next = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  const remaining = reciprocalGaps(next, { allowLegacyRootPaths: false });
  if (remaining.length > 0) {
    throw new Error(`could not close reciprocal links: ${remaining.map((gap) => `${gap.from}->${gap.to}`).join(", ")}`);
  }
  return { docs: next, added: gaps.length };
}

function assertSpec(spec: ConsolidationSpec): void {
  if (!spec || typeof spec.projectId !== "string" || !spec.projectId.trim()) throw new Error("projectId is required");
  if (!Number.isSafeInteger(spec.auditTaskId) || spec.auditTaskId <= 0) throw new Error("a positive auditTaskId is required");
  if (!Array.isArray(spec.sourceManifest) || spec.sourceManifest.length === 0) throw new Error("sourceManifest is required");
  if (!Array.isArray(spec.expectedResultPaths) || spec.expectedResultPaths.length === 0) throw new Error("expectedResultPaths is required");
  if (new Set(spec.sourceManifest).size !== spec.sourceManifest.length) throw new Error("sourceManifest contains duplicates");
  if (new Set(spec.expectedResultPaths).size !== spec.expectedResultPaths.length) throw new Error("expectedResultPaths contains duplicates");
  if (!Array.isArray(spec.operations) || spec.operations.length === 0) throw new Error("at least one consolidation operation is required");
  for (const operation of spec.operations) {
    if (!Array.isArray(operation.sourcePaths) || operation.sourcePaths.length < 1) {
      throw new Error("each consolidation operation requires at least one sourcePath");
    }
    if (operation.removePaths !== undefined && !Array.isArray(operation.removePaths)) throw new Error("removePaths must be an array");
    if (!operation.target || !Array.isArray(operation.target.tags)) throw new Error("each operation requires a complete target concept");
    if (SYSTEM_OWNED_PATHS.has(operation.target.path)) {
      throw new Error(`system-owned concept cannot be a consolidation target: ${operation.target.path}`);
    }
    assertSourceCoverage(operation.target.path, operation.sourcePaths, operation.preserve?.bySource);
  }
}

/** Build the exact candidate bundle without mutating project memory. */
export async function planProjectMemoryConsolidation(
  db: Db,
  spec: ConsolidationSpec,
): Promise<ProjectMemoryConsolidationPlan> {
  assertSpec(spec);
  const snapshot = await snapshotProjectMemory(db, spec.projectId);
  const auditTask = await db.prepare("SELECT id FROM tasks WHERE id=? AND project_id=?").get<{ id: number }>(spec.auditTaskId, spec.projectId);
  if (!auditTask) throw new Error(`audit task ${spec.auditTaskId} does not belong to project ${spec.projectId}`);
  const recovery = parseRecoverySnapshot(serializeRecoverySnapshot(snapshot));
  if (
    recovery.project_id !== snapshot.project_id
    || recovery.taken_at !== snapshot.taken_at
    || !snapshotsEquivalent(snapshot, recovery)
  ) {
    throw new Error("recovery snapshot did not round-trip; refusing to plan consolidation");
  }

  const original = new Map(snapshot.docs.map((doc) => [doc.path, doc]));
  const operations = spec.operations
    .map((operation) => ({
      ...operation,
      sourcePaths: [...new Set(operation.sourcePaths)].sort(),
      removePaths: [...new Set(operation.removePaths ?? operation.sourcePaths)].sort(),
    }))
    .sort((a, b) => a.target.path.localeCompare(b.target.path));
  const consumed = new Set<string>();
  const targetPaths = new Set<string>();
  const redirects = new Map<string, string>();
  for (const operation of operations) {
    if (operation.sourcePaths.length < 1) throw new Error(`operation into ${operation.target.path} needs a source`);
    if (SYSTEM_OWNED_PATHS.has(operation.target.path)) {
      throw new Error(`system-owned concept cannot be a consolidation target: ${operation.target.path}`);
    }
    if (targetPaths.has(operation.target.path)) throw new Error(`duplicate target path: ${operation.target.path}`);
    targetPaths.add(operation.target.path);
    for (const sourcePath of operation.sourcePaths) {
      if (!original.has(sourcePath)) throw new Error(`source concept not found: ${sourcePath}`);
    }
    for (const sourcePath of operation.removePaths) {
      if (!operation.sourcePaths.includes(sourcePath)) throw new Error(`removed path is not a read source for ${operation.target.path}: ${sourcePath}`);
      if (SYSTEM_OWNED_PATHS.has(sourcePath)) throw new Error(`system-owned concept cannot be consolidated: ${sourcePath}`);
      if (consumed.has(sourcePath)) throw new Error(`source concept is removed by multiple operations: ${sourcePath}`);
      consumed.add(sourcePath);
      redirects.set(sourcePath, operation.target.path);
    }
    if (original.has(operation.target.path) && !consumed.has(operation.target.path)) {
      throw new Error(`target ${operation.target.path} exists but is not included in its removePaths`);
    }
  }
  const declaredSources = [...new Set(spec.sourceManifest)].sort();
  const removedSources = [...consumed].sort();
  if (JSON.stringify(declaredSources) !== JSON.stringify(removedSources)) {
    throw new Error(`sourceManifest does not match removal ownership (manifest=${declaredSources.join(",")}; removed=${removedSources.join(",")})`);
  }
  const expectedSources = snapshot.docs
    .map((doc) => doc.path)
    .filter((path) => !SYSTEM_OWNED_PATHS.has(path))
    .sort();
  if (JSON.stringify(declaredSources) !== JSON.stringify(expectedSources)) {
    throw new Error(`sourceManifest must account for every non-system concept (expected=${expectedSources.join(",")}; manifest=${declaredSources.join(",")})`);
  }
  for (const targetPath of targetPaths) {
    if (consumed.has(targetPath) && redirects.get(targetPath) !== targetPath) {
      throw new Error(`target ${targetPath} is consumed by another consolidation operation`);
    }
  }

  const knownPaths = new Set(original.keys());
  const updatedAt = Math.max(0, ...snapshot.docs.map((doc) => doc.updated_at)) + 1;
  let linkRewrites = 0;
  const candidate: SnapshotDoc[] = [];
  for (const doc of snapshot.docs) {
    if (consumed.has(doc.path)) continue;
    const rewritten = rewriteConsolidatedMarkdownLinks(doc.body, doc.path, redirects, knownPaths);
    if (SYSTEM_OWNED_PATHS.has(doc.path) && rewritten.rewrites > 0) {
      throw new Error(`system-owned ${doc.path} would require a link rewrite`);
    }
    linkRewrites += rewritten.rewrites;
    candidate.push({
      ...doc,
      tags: [...doc.tags],
      body: rewritten.body,
      updated_at: rewritten.rewrites > 0 ? updatedAt : doc.updated_at,
    });
  }

  const plannedOperations: PlannedConsolidationOperation[] = [];
  for (const operation of operations) {
    const sources = operation.sourcePaths.map((path) => {
      const source = original.get(path)!;
      return operation.sanitizeEscapedFrontmatter
        ? { ...source, body: sanitizeLiteralEscapedFrontmatter(source.body) }
        : source;
    });
    const targetBody = operation.sanitizeEscapedFrontmatter
      ? sanitizeLiteralEscapedFrontmatter(operation.target.body)
      : operation.target.body;
    const targetRewrite = rewriteConsolidatedMarkdownLinks(
      targetBody,
      operation.target.path,
      redirects,
      knownPaths,
    );
    linkRewrites += targetRewrite.rewrites;
    const target: SnapshotDoc = {
      ...operation.target,
      tags: [...new Set(operation.target.tags)].sort(),
      body: targetRewrite.body,
      updated_at: updatedAt,
    };

    candidate.push(target);
    const planned: PlannedConsolidationOperation = {
      sourcePaths: [...operation.sourcePaths],
      removePaths: [...operation.removePaths],
      targetPath: target.path,
      sourceCoverage: structuredClone(operation.preserve.bySource),
      sanitizeEscapedFrontmatter: operation.sanitizeEscapedFrontmatter === true,
    };
    verifyOperationPreservation(
      planned,
      original,
      new Map([[target.path, target]]),
      redirects,
    );
    plannedOperations.push(planned);
  }

  candidate.sort((a, b) => a.path.localeCompare(b.path));
  const reciprocal = addReciprocalLinks(candidate, updatedAt, SYSTEM_OWNED_PATHS);
  validateCandidateDocs(reciprocal.docs);
  const actualResultPaths = reciprocal.docs.map((doc) => doc.path).sort();
  const expectedResultPaths = [...new Set(spec.expectedResultPaths)].sort();
  if (JSON.stringify(actualResultPaths) !== JSON.stringify(expectedResultPaths)) {
    throw new Error(`expectedResultPaths does not match candidate bundle (expected=${expectedResultPaths.join(",")}; actual=${actualResultPaths.join(",")})`);
  }

  return {
    version: PLAN_VERSION,
    projectId: spec.projectId,
    auditTaskId: spec.auditTaskId,
    createdAt: snapshot.taken_at,
    sourceWatermark: memoryDocsWatermark(snapshot.docs),
    resultWatermark: memoryDocsWatermark(reciprocal.docs),
    snapshot,
    sourceManifest: declaredSources,
    expectedResultPaths,
    operations: plannedOperations,
    candidateDocs: reciprocal.docs,
    removedPaths: [...consumed].filter((path) => !targetPaths.has(path)).sort(),
    linkRewrites,
    reciprocalLinksAdded: reciprocal.added,
  };
}

function verifyPlan(plan: ProjectMemoryConsolidationPlan): void {
  if (plan.version !== PLAN_VERSION || !plan.projectId || !Number.isSafeInteger(plan.auditTaskId) || plan.auditTaskId <= 0) {
    throw new Error("unsupported consolidation plan");
  }
  if (plan.snapshot.project_id !== plan.projectId) throw new Error("plan snapshot belongs to a different project");
  const recovered = parseRecoverySnapshot(serializeRecoverySnapshot(plan.snapshot));
  if (!snapshotsEquivalent(plan.snapshot, recovered)) throw new Error("plan recovery snapshot does not round-trip");
  if (memoryDocsWatermark(plan.snapshot.docs) !== plan.sourceWatermark) throw new Error("plan source watermark does not match its snapshot");
  if (memoryDocsWatermark(plan.candidateDocs) !== plan.resultWatermark) throw new Error("plan result watermark does not match its candidate bundle");
  if (new Set(plan.sourceManifest).size !== plan.sourceManifest.length) throw new Error("plan source manifest contains duplicates");
  if (new Set(plan.expectedResultPaths).size !== plan.expectedResultPaths.length) throw new Error("plan result manifest contains duplicates");
  const snapshotPaths = new Set(plan.snapshot.docs.map((doc) => doc.path));
  const expectedSources = plan.snapshot.docs.map((doc) => doc.path).filter((path) => !SYSTEM_OWNED_PATHS.has(path)).sort();
  if (JSON.stringify(expectedSources) !== JSON.stringify([...plan.sourceManifest].sort())) {
    throw new Error("plan source manifest does not account for every non-system snapshot concept");
  }
  const targetPaths = new Set<string>();
  const owned = new Set<string>();
  const redirects = new Map<string, string>();
  for (const operation of plan.operations) {
    if (SYSTEM_OWNED_PATHS.has(operation.targetPath)) {
      throw new Error(`system-owned concept cannot be a consolidation target: ${operation.targetPath}`);
    }
    if (targetPaths.has(operation.targetPath)) throw new Error(`duplicate plan target path: ${operation.targetPath}`);
    targetPaths.add(operation.targetPath);
    if (!plan.candidateDocs.some((doc) => doc.path === operation.targetPath)) throw new Error(`plan target is absent: ${operation.targetPath}`);
    if (new Set(operation.sourcePaths).size !== operation.sourcePaths.length) throw new Error(`plan sourcePaths contain duplicates for ${operation.targetPath}`);
    if (new Set(operation.removePaths).size !== operation.removePaths.length) throw new Error(`plan removePaths contain duplicates for ${operation.targetPath}`);
    for (const sourcePath of operation.sourcePaths) {
      if (!snapshotPaths.has(sourcePath)) throw new Error(`plan source is absent from snapshot: ${sourcePath}`);
    }
    for (const path of operation.removePaths) {
      if (!operation.sourcePaths.includes(path)) throw new Error(`plan removes ${path} without source coverage`);
      if (SYSTEM_OWNED_PATHS.has(path)) throw new Error(`plan removes system-owned concept: ${path}`);
      if (owned.has(path)) throw new Error(`plan source is removed by multiple operations: ${path}`);
      owned.add(path);
      redirects.set(path, operation.targetPath);
    }
    if (snapshotPaths.has(operation.targetPath) && !operation.removePaths.includes(operation.targetPath)) {
      throw new Error(`plan target ${operation.targetPath} exists without owning its replacement`);
    }
  }
  const removed = [...owned].sort();
  if (JSON.stringify(removed) !== JSON.stringify([...plan.sourceManifest].sort())) throw new Error("plan source manifest is not fully owned by operations");
  for (const targetPath of targetPaths) {
    if (owned.has(targetPath) && redirects.get(targetPath) !== targetPath) throw new Error(`plan target ${targetPath} is consumed by another operation`);
  }
  const expectedRemovedPaths = [...owned].filter((path) => !targetPaths.has(path)).sort();
  if (JSON.stringify(expectedRemovedPaths) !== JSON.stringify([...plan.removedPaths].sort())) throw new Error("plan removedPaths summary is inconsistent");
  const resultPaths = plan.candidateDocs.map((doc) => doc.path).sort();
  if (JSON.stringify(resultPaths) !== JSON.stringify([...plan.expectedResultPaths].sort())) throw new Error("plan result path manifest does not match candidate bundle");
  const ownedCandidatePaths = [
    ...targetPaths,
    ...plan.snapshot.docs.map((doc) => doc.path).filter((path) => SYSTEM_OWNED_PATHS.has(path)),
  ].sort();
  if (JSON.stringify(resultPaths) !== JSON.stringify(ownedCandidatePaths)) {
    throw new Error("plan candidate bundle contains a path that is not owned by an operation or protected system state");
  }
  for (const path of SYSTEM_OWNED_PATHS) {
    const before = plan.snapshot.docs.find((doc) => doc.path === path);
    const after = plan.candidateDocs.find((doc) => doc.path === path);
    if (before && JSON.stringify(before) !== JSON.stringify(after)) throw new Error(`system-owned ${path} changed in consolidation plan`);
  }
  const original = new Map(plan.snapshot.docs.map((doc) => [doc.path, doc]));
  const candidate = new Map(plan.candidateDocs.map((doc) => [doc.path, doc]));
  for (const operation of plan.operations) {
    verifyOperationPreservation(operation, original, candidate, redirects);
  }
  validateCandidateDocs(plan.candidateDocs);
}

async function assertAuditTask(db: Db, plan: ProjectMemoryConsolidationPlan): Promise<void> {
  const task = await db.prepare("SELECT id FROM tasks WHERE id=? AND project_id=?").get<{ id: number }>(plan.auditTaskId, plan.projectId);
  if (!task) throw new Error(`audit task ${plan.auditTaskId} does not belong to project ${plan.projectId}`);
}

function result(
  plan: ProjectMemoryConsolidationPlan,
  status: ConsolidationRunResult["status"],
  recoverySnapshot: MemorySnapshot = plan.snapshot,
): ConsolidationRunResult {
  return {
    status,
    projectId: plan.projectId,
    sourceWatermark: plan.sourceWatermark,
    resultWatermark: plan.resultWatermark,
    conceptsBefore: plan.snapshot.docs.length,
    conceptsAfter: plan.candidateDocs.length,
    removedPaths: [...plan.removedPaths],
    linkRewrites: plan.linkRewrites,
    reciprocalLinksAdded: plan.reciprocalLinksAdded,
    snapshot: recoverySnapshot,
  };
}

/**
 * Check or atomically apply a saved plan. Dry-run is the default. Reapplying
 * the exact plan is a no-op; any third watermark is refused.
 */
export async function executeProjectMemoryConsolidation(
  db: Db,
  plan: ProjectMemoryConsolidationPlan,
  options: { apply?: boolean; recoverySnapshot?: MemorySnapshot } = {},
): Promise<ConsolidationRunResult> {
  verifyPlan(plan);
  await assertAuditTask(db, plan);
  const current = await snapshotProjectMemory(db, plan.projectId);
  const currentWatermark = memoryDocsWatermark(current.docs);
  if (currentWatermark === plan.resultWatermark) return result(plan, "already_applied", current);
  if (currentWatermark !== plan.sourceWatermark) throw new StaleConsolidationPlanError(plan.sourceWatermark, currentWatermark);
  if (!options.apply) return result(plan, "dry_run");

  // An apply-time snapshot, not the older planning snapshot, is the rollback
  // artifact. It includes log rows written after planning and is also the
  // exact artifact the CLI persists and passes back here after reading it.
  const recoverySnapshot = options.recoverySnapshot ?? current;
  if (recoverySnapshot.project_id !== plan.projectId) throw new Error("apply recovery snapshot belongs to a different project");
  if (memoryDocsWatermark(recoverySnapshot.docs) !== plan.sourceWatermark) {
    throw new Error("apply recovery snapshot does not contain the planned source docs");
  }
  if (!snapshotsEquivalent(recoverySnapshot, current)) {
    throw new Error("memory changed after the apply recovery snapshot was captured; refusing to replace");
  }

  await db.transaction(async () => {
    if (db.dialect === "postgres") await db.exec("LOCK TABLE memory_docs, memory_log IN EXCLUSIVE MODE");
    const locked = await snapshotProjectMemory(db, plan.projectId);
    const lockedWatermark = memoryDocsWatermark(locked.docs);
    if (lockedWatermark !== plan.sourceWatermark) throw new StaleConsolidationPlanError(plan.sourceWatermark, lockedWatermark);
    if (!snapshotsEquivalent(recoverySnapshot, locked)) {
      throw new Error("memory changed after the apply recovery snapshot was verified; refusing to replace");
    }
    await assertAuditTask(db, plan);

    await db.prepare("DELETE FROM memory_docs WHERE project_id=?").run(plan.projectId);
    const insert = db.prepare(
      `INSERT INTO memory_docs (project_id, path, type, title, description, tags, body, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const doc of plan.candidateDocs) {
      await insert.run(
        plan.projectId,
        doc.path,
        doc.type,
        doc.title,
        doc.description,
        JSON.stringify(doc.tags),
        doc.body,
        doc.updated_at,
      );
    }
    const validation = await new MemoryStore(db).validateBundle(plan.projectId);
    if (!validation.ok || !validation.graph_consistent) {
      throw new Error(`post-replace bundle validation failed: ${[...validation.errors, ...validation.reciprocal_gaps.map((gap) => `${gap.from}->${gap.to}`)].join(", ")}`);
    }
    const persisted = await snapshotProjectMemory(db, plan.projectId);
    const persistedWatermark = memoryDocsWatermark(persisted.docs);
    if (persistedWatermark !== plan.resultWatermark) {
      throw new Error(`persisted result does not match reviewed plan (expected ${plan.resultWatermark}, found ${persistedWatermark})`);
    }
    await db
      .prepare("INSERT INTO memory_log (project_id, entry, task_id, created_at) VALUES (?, ?, ?, ?)")
      .run(
        plan.projectId,
        `consolidated ${plan.removedPaths.length} concept(s) into ${plan.operations.map((operation) => operation.targetPath).join(", ")} @${plan.sourceWatermark.slice(0, 12)}`,
        plan.auditTaskId,
        Date.now(),
      );
  });

  return result(plan, "applied", recoverySnapshot);
}
