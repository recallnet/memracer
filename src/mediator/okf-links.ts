// OKF concept link resolution: turn a concept body's [[wikilinks]] and
// markdown `.md` hrefs into navigable links, and compute the reverse
// (backlinks). Pure functions over concept metadata — no db, no HTTP — so the
// dashboard Knowledge view and its tests share one source of truth.
import { posix } from "node:path";

export interface LinkableDoc {
  path: string;
  title: string;
  body: string;
}

export interface ConceptLink {
  path: string;
  title: string;
}

export interface MarkdownLinkTarget {
  href: string;
  path: string;
}

export interface ResolvedLinks {
  links: ConceptLink[]; // outbound: concepts this body references
  backlinks: ConceptLink[]; // inbound: concepts whose body references this one
}

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;
// CommonMark inline-link destination plus optional quoted/parenthesized title.
// Angle brackets permit whitespace in the destination. Query/fragment bytes
// stay attached for callers that rewrite links, while titles never do.
const HREF_RE = /\]\(\s*(<[^>\n]+>|[^\s<>()]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^\)\n]*\)))?\s*\)/g;

interface TextRange {
  start: number;
  end: number;
}

function markdownCodeRanges(markdown: string): TextRange[] {
  const fenced: TextRange[] = [];
  const indented: TextRange[] = [];
  let offset = 0;
  let open: { start: number; marker: string } | null = null;
  for (const lineWithBreak of markdown.match(/.*(?:\n|$)/g) ?? []) {
    if (!lineWithBreak) continue;
    const line = lineWithBreak.replace(/\n$/, "");
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
    const closingMarker = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/)?.[1];
    if (!open && marker) {
      open = { start: offset, marker };
    } else if (
      open
      && closingMarker?.[0] === open.marker[0]
      && closingMarker.length >= open.marker.length
    ) {
      fenced.push({ start: open.start, end: offset + lineWithBreak.length });
      open = null;
    }
    if (/^(?: {4,}| {0,3}\t)/.test(line)) {
      indented.push({ start: offset, end: offset + lineWithBreak.length });
    }
    offset += lineWithBreak.length;
  }
  if (open) fenced.push({ start: open.start, end: markdown.length });

  // Merge block ranges before scanning inline code. Indented lines inside a
  // fence are one protected range, not overlapping slices that could expose
  // bytes to mapMarkdownProse.
  const blocks = [...fenced, ...indented]
    .sort((a, b) => a.start - b.start)
    .reduce<TextRange[]>((merged, range) => {
      const previous = merged.at(-1);
      if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
      else merged.push({ ...range });
      return merged;
    }, []);
  const ranges = [...blocks];
  let cursor = 0;
  let blockIndex = 0;
  while (cursor < markdown.length) {
    const block = blocks[blockIndex];
    if (block && cursor >= block.start) {
      cursor = block.end;
      blockIndex += 1;
      continue;
    }
    if (markdown[cursor] !== "`") {
      cursor += 1;
      continue;
    }
    let width = 1;
    while (markdown[cursor + width] === "`") width += 1;
    const closing = markdown.indexOf("`".repeat(width), cursor + width);
    if (closing < 0 || (block && closing >= block.start)) {
      cursor += width;
      continue;
    }
    ranges.push({ start: cursor, end: closing + width });
    cursor = closing + width;
  }
  ranges.sort((a, b) => a.start - b.start);
  return ranges;
}

/** Apply a transform only to prose, preserving fenced and inline code bytes. */
export function mapMarkdownProse(markdown: string, transform: (prose: string) => string): string {
  const ranges = markdownCodeRanges(markdown);
  const out: string[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) out.push(transform(markdown.slice(cursor, range.start)));
    out.push(markdown.slice(range.start, range.end));
    cursor = range.end;
  }
  if (cursor < markdown.length) out.push(transform(markdown.slice(cursor)));
  return out.join("");
}

/** Extract the raw [[wikilink]] targets and `.md` hrefs from a concept body. */
export function parseLinks(body: string): { wikilinks: string[]; hrefs: string[] } {
  const wikilinks: string[] = [];
  const hrefs: string[] = [];
  mapMarkdownProse(body, (prose) => {
    for (const m of prose.matchAll(WIKILINK_RE)) wikilinks.push(m[1].trim());
    for (const m of prose.matchAll(HREF_RE)) {
      const href = m[1].trim();
      if (hrefPath(href).endsWith(".md")) hrefs.push(href);
    }
    return prose;
  });
  return { wikilinks, hrefs };
}

/** kebab stem of a path: "decisions/rate-limit.md" -> "rate-limit". */
function stem(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.replace(/\.md$/, "");
}

/** Strip an anchor/query from a markdown concept href without decoding it. */
function hrefPath(href: string): string {
  const raw = renderedHref(href);
  const cut = raw.search(/[?#]/);
  return cut < 0 ? raw : raw.slice(0, cut);
}

/** React Markdown exposes angle-bracket destinations without their delimiters. */
function renderedHref(href: string): string {
  return href.trim().replace(/^<|>$/g, "");
}

/**
 * Resolve an OKF markdown href. A leading slash starts at the bundle root;
 * other hrefs are relative to the concept containing them. Escapes and URL
 * schemes are not concept links.
 */
export function normalizeMarkdownHref(fromPath: string, href: string): string | null {
  const raw = hrefPath(href);
  if (!raw.endsWith(".md") || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//")) return null;
  const joined = raw.startsWith("/")
    ? posix.normalize(raw.slice(1))
    : posix.normalize(posix.join(posix.dirname(fromPath), raw));
  if (!joined || joined === ".." || joined.startsWith("../") || posix.isAbsolute(joined)) return null;
  return joined;
}

/** Existing project memory sometimes used bundle-root bytes without `/`. */
function legacyBundlePath(href: string): string | null {
  const raw = hrefPath(href);
  if (raw.startsWith("/") || raw === ".." || raw.startsWith("../") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
  const normalized = posix.normalize(raw);
  return normalized === ".." || normalized.startsWith("../") ? null : normalized;
}

function resolvedMarkdownPath(
  fromDoc: LinkableDoc,
  byPath: Map<string, LinkableDoc>,
  href: string,
  options: { allowLegacyRootPaths?: boolean },
): string | null {
  const normalized = normalizeMarkdownHref(fromDoc.path, href);
  const legacy = options.allowLegacyRootPaths === true ? legacyBundlePath(href) : null;
  // Canonical relative resolution wins. The exact-path fallback keeps old
  // seeded memory navigable until a consolidation rewrites its href bytes.
  return (normalized ? byPath.get(normalized)?.path : undefined)
    ?? (legacy ? byPath.get(legacy)?.path : undefined)
    ?? null;
}

function outboundPaths(
  fromDoc: LinkableDoc,
  docs: LinkableDoc[],
  options: { allowLegacyRootPaths?: boolean } = {},
): Set<string> {
  const byPath = new Map(docs.map((d) => [d.path, d]));
  const byTitle = new Map(docs.map((d) => [d.title.toLowerCase(), d]));
  const byStem = new Map(docs.map((d) => [stem(d.path).toLowerCase(), d]));
  const { wikilinks, hrefs } = parseLinks(fromDoc.body);
  const paths = new Set<string>();
  for (const wikilink of wikilinks) {
    const hit = byTitle.get(wikilink.toLowerCase()) ?? byStem.get(wikilink.toLowerCase());
    if (hit && hit.path !== fromDoc.path) paths.add(hit.path);
  }
  for (const href of hrefs) {
    const path = resolvedMarkdownPath(fromDoc, byPath, href, options);
    if (path && path !== fromDoc.path) paths.add(path);
  }
  return paths;
}

/**
 * Pair each rendered Markdown href with the canonical path selected by the
 * server resolver. The dashboard consumes this exact mapping rather than
 * reimplementing OKF path semantics in the browser.
 */
export function resolveMarkdownLinkTargets(docs: LinkableDoc[], targetPath: string): MarkdownLinkTarget[] {
  const byPath = new Map(docs.map((doc) => [doc.path, doc]));
  const target = byPath.get(targetPath);
  if (!target) return [];

  const targets: MarkdownLinkTarget[] = [];
  const seen = new Set<string>();
  for (const href of parseLinks(target.body).hrefs) {
    const path = resolvedMarkdownPath(target, byPath, href, { allowLegacyRootPaths: true });
    if (!path || path === target.path) continue;
    const rendered = renderedHref(href);
    const key = `${rendered}\0${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ href: rendered, path });
  }
  return targets;
}

/**
 * Resolve one concept's outbound links and inbound backlinks against the full
 * project concept set. A [[wikilink]] resolves to a concept whose title (or
 * kebab path-stem) matches case-insensitively; an href resolves relative to
 * its source concept, or from the bundle root when prefixed with `/`.
 * A concept never links to itself; results are de-duplicated and path-ordered.
 */
export function resolveLinks(docs: LinkableDoc[], targetPath: string): ResolvedLinks {
  const byPath = new Map(docs.map((d) => [d.path, d]));

  const target = byPath.get(targetPath);

  const link = (path: string): ConceptLink => ({ path, title: byPath.get(path)!.title });
  const sortByPath = (a: ConceptLink, b: ConceptLink) => a.path.localeCompare(b.path);

  const links = target
    ? [...outboundPaths(target, docs, { allowLegacyRootPaths: true })].map(link).sort(sortByPath)
    : [];

  const backlinks: ConceptLink[] = [];
  for (const d of docs) {
    if (d.path === targetPath) continue;
    if (outboundPaths(d, docs, { allowLegacyRootPaths: true }).has(targetPath)) backlinks.push(link(d.path));
  }
  backlinks.sort(sortByPath);

  return { links, backlinks };
}

/** A one-directional edge: `from` links to `to`, but `to` does not link back. */
export interface ReciprocalGap {
  from: string;
  to: string;
}

/**
 * Every reciprocal-link gap in a concept set: an ordered pair (from → to) where
 * `from`'s body links `to` but `to`'s body does not link back to `from`. The
 * mediator's MAINTAIN discipline writes reciprocal links; this surfaces the
 * asymmetries it (or a reviewer) should close so the Knowledge graph's edges are
 * bidirectional rather than dangling. Pure over concept metadata, path-ordered.
 */
export function reciprocalGaps(
  docs: LinkableDoc[],
  options: { allowLegacyRootPaths?: boolean } = {},
): ReciprocalGap[] {
  const out = new Map(docs.map((d) => [d.path, outboundPaths(d, docs, options)]));
  const gaps: ReciprocalGap[] = [];
  for (const d of docs) {
    for (const to of out.get(d.path)!) {
      if (!out.get(to)?.has(d.path)) gaps.push({ from: d.path, to });
    }
  }
  gaps.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  return gaps;
}
