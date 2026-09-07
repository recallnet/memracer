/**
 * Normalize a concept body before it enters memory storage or rendering.
 *
 * Some mediator writes accidentally supplied a complete rendered OKF concept
 * (including YAML frontmatter) as the body, with newlines JSON-escaped a
 * second time. The store owns concept metadata and composes frontmatter when
 * it renders, so a leading frontmatter block is always an artifact here.
 *
 * This function is deliberately pure and idempotent so the write gate,
 * startup repair, and read-side renderer can share exactly one rule.
 */
const ESCAPED_NEWLINE = /\\r\\n|\\n/g;

/**
 * Literal backslash-newline text is valid inside prose, JSON, regexes, and
 * code examples. Decode it only when the complete one-line value has enough
 * Markdown structure to prove that its line separators were escaped as a
 * serialization artifact.
 */
function isDoubleEncodedMarkdown(body: string): boolean {
  if (/[\r\n]/.test(body) || !body.includes("\\n")) return false;
  const decoded = body.replace(ESCAPED_NEWLINE, "\n");
  const escapedBreaks = body.match(ESCAPED_NEWLINE)?.length ?? 0;

  // The production incident supplied a complete rendered OKF concept.
  if (/^---[ \t]*\n[\s\S]*?\n---[ \t]*(?:\n|$)/.test(decoded)) return true;

  // Also recover a frontmatter-free Markdown blob when multiple escaped
  // separators expose line-level Markdown. A lone token or JSON/regex string
  // remains byte-identical because its intent is ambiguous.
  return escapedBreaks >= 2 && /^(?:#{1,6}[ \t]+|[-*+][ \t]+|\d+\.[ \t]+|```|~~~)/.test(decoded);
}

export function normalizeMemoryBody(body: string): string {
  const decoded = isDoubleEncodedMarkdown(body) ? body.replace(ESCAPED_NEWLINE, "\n") : body;
  const frontmatter = decoded.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  // A pair of thematic breaks is ordinary Markdown, not frontmatter. Require
  // at least one plain YAML mapping key before removing the delimited block.
  if (!frontmatter || !/^[A-Za-z_][A-Za-z0-9_-]*:(?:[ \t]|$)/m.test(frontmatter[1])) return decoded;

  const withoutFrontmatter = decoded.slice(frontmatter[0].length);
  // A conventional blank line separates frontmatter from Markdown content.
  // Consume at most that one separator; preserve all other body whitespace.
  if (withoutFrontmatter.startsWith("\r\n")) return withoutFrontmatter.slice(2);
  return withoutFrontmatter.startsWith("\n") ? withoutFrontmatter.slice(1) : withoutFrontmatter;
}
