export interface MergeTaskSnapshot {
  id: number;
  title: string;
  body: string;
  evidencePaths: string[];
}

export type MergeSafetyVerdict =
  | { allowed: true; reason: "exact_duplicate" }
  | { allowed: false; reason: "same_task" | "scope_mismatch" | "weak_overlap" };

const PROMPT_LABELS = new Set([
  "acceptance",
  "constraints",
  "evidence",
  "goal",
  "invariants",
  "outcome",
  "pointers",
  "verification",
  "verify",
]);

const STOP_WORDS = new Set([
  "a", "about", "an", "and", "are", "as", "at", "be", "before", "by",
  "criteria", "for", "from", "has", "have", "in", "into", "is", "it",
  "its", "of", "on", "or", "out", "should", "than", "that", "the", "their",
  "this", "through", "to", "was", "were", "will", "with", "would",
  // Workflow and repository vocabulary cannot establish duplicate identity.
  "acceptance", "change", "changes", "fix", "implementation", "implement",
  "md", "mediator", "memracer", "project", "prompt", "src", "task", "tasks",
  "ts", "update", "work", "working",
  ...PROMPT_LABELS,
]);

const PATH_IN_TEXT = /(?:^|[\s(<"'`])((?:\.?[\p{L}\p{N}_-]+\/)+[\p{L}\p{N}_.-]+)(?=$|[\s>)"'`,;:!?])/gimu;

function canonicalText(value: string): string {
  return value
    .normalize("NFKC")
    .replaceAll("≥", ">=")
    .replaceAll("≤", "<=")
    .replaceAll("≠", "!=")
    .replace(/\r\n?/gu, "\n")
    .replace(
      /^[ \t]*(?:outcome|goal)[ \t]*:[ \t]*/gimu,
      "",
    )
    // Normalize only one unambiguous sentence-ending full stop. Repeated dots
    // and ellipses can signal intentionally unfinished or distinct intent.
    // Every other character, including internal whitespace, remains exact.
    .replace(/(?<![.。｡])[.。｡](?=[ \t]*(?:\n|$))/gu, "");
}

function meaningfulTokens(snapshot: MergeTaskSnapshot): Set<string> {
  const tokens = canonicalText(`${snapshot.title}\n${snapshot.body}`).match(/[\p{L}\p{N}_]+/gu) ?? [];
  return new Set(tokens
    // Single-character numerals and identifiers can be the entire product
    // discriminator (OAuth 1 vs OAuth 2, API v1 vs v2). Stop words decide only
    // whether any meaningful identity exists; exact comparison stays lossless.
    .filter((token) => !STOP_WORDS.has(token.toLocaleLowerCase("en-US"))));
}

function pathScope(rawPath: string): string | null {
  const normalized = rawPath.normalize("NFKC").replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.includes("://")) return null;
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === "..")) return null;
  // Preserve the full, case-sensitive repository identity. Compatibility is
  // introduced only by an explicitly named directory prefix, never by
  // collapsing sibling files to a common inferred owner.
  return segments.join("/");
}

function scopes(snapshot: MergeTaskSnapshot): Set<string> {
  const paths = [...snapshot.evidencePaths];
  for (const text of [snapshot.title, snapshot.body]) {
    for (const match of text.matchAll(PATH_IN_TEXT)) paths.push(match[1]);
  }
  return new Set(paths.map(pathScope).filter((scope): scope is string => scope !== null));
}

function scopeCompatible(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function scopesCoverEachOther(left: Set<string>, right: Set<string>): boolean {
  const coveredBy = (subjects: Set<string>, candidates: Set<string>) =>
    [...subjects].every((subject) => [...candidates].some((candidate) => scopeCompatible(subject, candidate)));
  return coveredBy(left, right) && coveredBy(right, left);
}

export function classifyTaskMerge(
  source: MergeTaskSnapshot,
  target: MergeTaskSnapshot,
): MergeSafetyVerdict {
  if (source.id === target.id) return { allowed: false, reason: "same_task" };

  const sourceScopes = scopes(source);
  const targetScopes = scopes(target);
  if (sourceScopes.size > 0 && targetScopes.size > 0 && !scopesCoverEachOther(sourceScopes, targetScopes)) {
    return { allowed: false, reason: "scope_mismatch" };
  }

  const sourceTokens = meaningfulTokens(source);
  const targetTokens = meaningfulTokens(target);
  if (sourceTokens.size === 0 || targetTokens.size === 0) {
    return { allowed: false, reason: "weak_overlap" };
  }

  if (
    canonicalText(source.title) === canonicalText(target.title)
    && canonicalText(source.body) === canonicalText(target.body)
  ) {
    return { allowed: true, reason: "exact_duplicate" };
  }
  return { allowed: false, reason: "weak_overlap" };
}

/** Minimal async db surface used by the misattribution guard. */
export interface CollisionDb {
  prepare(sql: string): { all<T>(...params: unknown[]): Promise<T[]> };
}

/**
 * Misattribution guard (root defense for the groom content-bleed bug): return
 * the id of a DIFFERENT live task in the project whose content the proposed
 * (title, body) canonically duplicates, or null when it is genuinely its own.
 *
 * The model can regurgitate a keyword-adjacent neighbor's verbatim body onto
 * the task being groomed/updated. Reusing the exact-duplicate classifier across
 * live tasks catches that at the write boundary: a groomed task should never end
 * up canonically identical to a different existing task. A genuine duplicate is
 * the merge/close path's job, never a silent content swap.
 */
export async function findContentCollision(
  db: CollisionDb,
  projectId: string,
  excludeId: number,
  title: string,
  body: string,
): Promise<number | null> {
  const others = await db
    .prepare("SELECT id, title, body FROM tasks WHERE project_id=? AND id<>? AND state<>'DONE'")
    .all<{ id: number; title: string; body: string }>(projectId, excludeId);
  const proposed: MergeTaskSnapshot = { id: excludeId, title, body, evidencePaths: [] };
  for (const other of others) {
    const verdict = classifyTaskMerge(proposed, {
      id: other.id, title: other.title, body: other.body, evidencePaths: [],
    });
    if (verdict.allowed) return other.id;
  }
  return null;
}
