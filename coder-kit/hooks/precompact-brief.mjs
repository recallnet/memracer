// coder-kit/hooks/precompact-brief.mjs — implementation behind
// precompact-brief.sh. Runs as a SessionStart(compact) hook: after compaction
// it re-injects the task brief so acceptance criteria survive the summary.

import { readFileSync } from "node:fs";

// Drain stdin (the SessionStart hook input) so Claude Code never sees EPIPE;
// the payload itself isn't needed — the brief lives on disk.
for await (const _chunk of process.stdin) {
  // discard
}

const file = process.env.MEMRACER_TASK_FILE;
if (!file) process.exit(0);

let brief;
try {
  brief = JSON.parse(readFileSync(file, "utf8"));
} catch {
  process.exit(0); // missing or unreadable brief: fail open
}

const context = [
  `The active memracer task brief (context was just compacted; this restates the task verbatim, and the full brief JSON is on disk at ${file}):`,
  "",
  `Task ${brief.id}: ${brief.title}`,
  "",
  brief.body ?? "",
].join("\n");

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context },
  }),
);
process.exit(0);
