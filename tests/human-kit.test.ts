// tests/human-kit.test.ts — content contract for the human onboarding kit.
// The kit teaches a teammate's Claude Code session the memracer protocol:
// gather evidence from the repo they sit in, submit via human_submit with
// repo inference, and surface open questions at session start via
// human_status. These tests pin the load-bearing content so the kit cannot
// silently drift from the server's actual tool surface (src/tools.ts).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KIT = path.join(ROOT, "human-kit");
const SKILL_PATH = path.join(KIT, "skills", "memracer-protocol", "SKILL.md");
const SNIPPET_PATH = path.join(KIT, "CLAUDE.md-snippet");
const README_PATH = path.join(KIT, "README.md");
const SETTINGS_PATH = path.join(KIT, "settings.json");

// Evidence kinds accepted by human_submit's evidenceSchema in src/tools.ts.
const EVIDENCE_KINDS = ["code", "stacktrace", "log", "link", "research"];

function read(p: string): string {
  return readFileSync(p, "utf8");
}

describe("human-kit skill", () => {
  it("has frontmatter with a name and a trigger-rich description", () => {
    const skill = read(SKILL_PATH);
    expect(skill.startsWith("---\n")).toBe(true);
    const frontmatter = skill.split("---")[1];
    expect(frontmatter).toMatch(/name:\s*memracer-protocol/);
    const desc = /description:\s*(.+)/.exec(frontmatter)?.[1] ?? "";
    // The skill must fire on vague verbal ideas — the description carries the
    // triggers, since the user will never name a tool.
    expect(desc.length).toBeGreaterThan(100);
    expect(desc).toMatch(/idea/i);
    expect(desc).toMatch(/bug|issue|problem/i);
  });

  it("teaches evidence gathering with the server's exact evidence kinds", () => {
    const skill = read(SKILL_PATH);
    expect(skill).toMatch(/file:line/);
    expect(skill).toMatch(/snippet/i);
    expect(skill).toMatch(/stack trace/i);
    expect(skill).toMatch(/git rev-parse HEAD/);
    for (const kind of EVIDENCE_KINDS) {
      expect(skill).toContain(`\`${kind}\``);
    }
  });

  it("teaches repo inference and the human_submit call", () => {
    const skill = read(SKILL_PATH);
    expect(skill).toContain("human_submit");
    expect(skill).toMatch(/git remote/);
    expect(skill).toMatch(/owner\/name/);
    expect(skill).toMatch(/base_sha/);
    // Report back what the server returned, not just "done".
    expect(skill).toMatch(/task id/i);
    expect(skill).toMatch(/grooming/i);
    expect(skill).toMatch(/acceptance criteria/i);
  });

  it("teaches session-start status and answering open questions", () => {
    const skill = read(SKILL_PATH);
    expect(skill).toContain("human_status");
    expect(skill).toContain("human_answer");
    expect(skill).toMatch(/session start|start of a session|first .*(message|turn)/i);
    expect(skill).toMatch(/open\s+questions?/i);
    expect(skill).toContain("attention alerts");
    expect(skill).toMatch(/does not mean\s+a coder crashed/i);
  });
});

describe("human-kit CLAUDE.md snippet", () => {
  it("carries the session-start and idea-to-submission protocol", () => {
    const snippet = read(SNIPPET_PATH);
    expect(snippet).toContain("human_status");
    expect(snippet).toContain("human_submit");
    expect(snippet).toMatch(/open\s+questions?/i);
    expect(snippet).toMatch(/evidence/i);
    expect(snippet).toMatch(/file:line/);
    // The user shares ideas in plain language; the session acts unprompted.
    expect(snippet).toMatch(/without\s+(the\s+user\s+)?(naming|mentioning|being asked)/i);
  });
});

describe("human-kit README", () => {
  it("covers connection, skill, SessionStart hook, and snippet setup", () => {
    const readme = read(README_PATH);
    expect(readme).toMatch(/claude mcp add --transport http/);
    expect(readme).toMatch(/skills\/memracer-protocol/);
    expect(readme).toMatch(/\.claude\/skills/);
    expect(readme).toMatch(/CLAUDE\.md/);
    expect(readme).toContain("MEMRACER_URL");
    expect(readme).toContain("MEMRACER_TOKEN");
    expect(readme).toContain("terminal-notifier");
    expect(readme).toContain("osascript");
    expect(readme).toMatch(/not server push/i);
  });
});

describe("human-kit SessionStart wiring", () => {
  it("runs the host-owned status/notification hook at SessionStart", () => {
    const settings = JSON.parse(read(SETTINGS_PATH));
    const hook = settings.hooks.SessionStart[0].hooks[0];
    expect(hook.type).toBe("command");
    expect(hook.command).toContain("sessionstart-status.sh");
    expect(hook.timeout).toBeGreaterThanOrEqual(15);
  });
});
