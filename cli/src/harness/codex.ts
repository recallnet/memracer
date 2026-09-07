import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import type { HarnessWriter, Runner, SeatConfig } from "./index.js";
import { appendGitignore } from "./gitignore.js";

type Ensure = (folder: string, line: string) => Promise<void>;

/** Codex reads `$CODEX_HOME/config.toml`, defaulting to `~/.codex`. */
function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

/**
 * Codex writer. Codex loads a project-scoped `.codex/config.toml` from the seat
 * folder, and streamable-HTTP MCP servers carry their bearer token inline via
 * `http_headers` — so we write the token there, matching claude/grok (one seat
 * = one folder, no runtime env var). Codex will only load a project config once
 * the folder is trusted, so we also stamp `[projects."<folder>"] trust_level =
 * "trusted"` into the global config. `.codex/` is gitignored to keep the token
 * out of the repo. Any stale global `mcp_servers` entry pointing at this same
 * URL (the old env-var design that failed to launch) is removed.
 */
export const codexWriter: HarnessWriter & {
  write(seat: SeatConfig, run?: Runner, ensure?: Ensure): Promise<void>;
} = {
  id: "codex",
  bin: "codex",
  async write(seat: SeatConfig, _run?: Runner, ensure: Ensure = appendGitignore): Promise<void> {
    const projectDir = join(seat.folder, ".codex");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, "config.toml"),
      stringify({
        mcp_servers: {
          [seat.name]: {
            url: seat.url,
            http_headers: { Authorization: `Bearer ${seat.token}` },
          },
        },
      }),
      { mode: 0o600 },
    );
    await ensure(seat.folder, ".codex/");

    const home = codexHome();
    const globalPath = join(home, "config.toml");
    const global: Record<string, unknown> = existsSync(globalPath)
      ? (parse(readFileSync(globalPath, "utf8")) as Record<string, unknown>)
      : {};

    const projects = { ...((global.projects as Record<string, unknown>) ?? {}) };
    projects[seat.folder] = {
      ...((projects[seat.folder] as Record<string, unknown>) ?? {}),
      trust_level: "trusted",
    };
    global.projects = projects;

    const servers = global.mcp_servers as Record<string, { url?: string }> | undefined;
    if (servers && typeof servers === "object") {
      for (const [name, cfg] of Object.entries(servers)) {
        if (cfg && typeof cfg === "object" && cfg.url === seat.url) delete servers[name];
      }
      if (Object.keys(servers).length === 0) delete global.mcp_servers;
    }

    await mkdir(home, { recursive: true });
    await writeFile(globalPath, stringify(global), { mode: 0o600 });
  },
  locate(seat: SeatConfig): string {
    return `${join(seat.folder, ".codex", "config.toml")} (token inline, gitignored)`;
  },
};
