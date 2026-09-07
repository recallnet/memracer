// tests/dashboard-copy-gate.test.ts
//
// Acceptance-criterion-8 copy gate (#87 C): user-visible dashboard copy must
// never leak dev-ese. This scans the shipped front-end sources for a fixed set
// of forbidden patterns and fails on any hit, so the regression is caught in CI
// rather than by a human reading the running UI.
//
// The scan strips comments first (a pattern inside a code comment is not
// user-visible) and honours a small, EXPLICIT allowlist that distinguishes an
// intentional data-key from leaked copy — every allowlist entry is justified
// inline. The gate rejects the five listed strings by default.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";

const PUBLIC = fileURLToPath(new URL("../src/dashboard/public/", import.meta.url));
const WEB = fileURLToPath(new URL("../src/dashboard/web/", import.meta.url));

/** The strings that must never reach a user-visible dashboard surface. */
const FORBIDDEN = ["human_answer(", "raw JSON", "Thought for", "lease_expired", "Claude session"];

/**
 * Explicit allowlist: a forbidden substring is tolerated only in these exact
 * longer contexts, each a non-rendered data key rather than copy.
 */
const ALLOWED_CONTEXTS: { pattern: string; context: string; why: string }[] = [
  {
    pattern: "lease_expired",
    context: "lease_expired:",
    why: "OUTCOME_COLORS/OUTCOME_LABELS object key — mirrors the backend attempt-outcome enum; a humanized label ('lease expired') is what actually renders.",
  },
];

/** Strip JS (// and /* *​/) and HTML (<!-- -->) comments so only live copy is scanned. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ") // keep http:// intact via the [^:] guard
    .replace(/<!--[\s\S]*?-->/g, " ");
}

function offendingLines(src: string, pattern: string): string[] {
  const hits: string[] = [];
  for (const line of src.split("\n")) {
    let from = line.indexOf(pattern);
    while (from !== -1) {
      const allowed = ALLOWED_CONTEXTS.some(
        (a) => a.pattern === pattern && line.includes(a.context) && line.slice(from).startsWith(a.context),
      );
      if (!allowed) {
        hits.push(line.trim());
        break;
      }
      from = line.indexOf(pattern, from + pattern.length);
    }
  }
  return hits;
}

describe("dashboard copy gate (#87)", () => {
  const webFiles = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return webFiles(path);
    return [".ts", ".tsx", ".html"].includes(extname(entry.name)) ? [path] : [];
  });
  const files = [join(PUBLIC, "signin.html"), join(PUBLIC, "join.html"), ...webFiles(WEB)];

  for (const file of files) {
    it(`${file.slice(process.cwd().length + 1)} carries no dev-ese in user-visible copy`, () => {
      const src = stripComments(readFileSync(file, "utf8"));
      for (const pattern of FORBIDDEN) {
        const hits = offendingLines(src, pattern);
        expect(hits, `forbidden copy "${pattern}" in ${file}:\n  ${hits.join("\n  ")}`).toEqual([]);
      }
    });
  }
});
