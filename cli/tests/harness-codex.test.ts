import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, readFile, rm, mkdir, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { codexWriter } from "../src/harness/codex.js";
import type { SeatConfig } from "../src/harness/index.js";

// The codex writer touches the real filesystem (project + global config), so
// we point it at throwaway dirs: a temp seat folder and a temp CODEX_HOME.
let root: string;
let seat: SeatConfig;
let prevCodexHome: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "codex-writer-"));
  prevCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(root, "codex-home");
  seat = {
    name: "memracer_coder_ab12",
    url: "https://memracer.com/mcp",
    token: "mzr_live_x",
    folder: join(root, "wt", "coder"),
  };
  await mkdir(seat.folder, { recursive: true });
});

afterEach(async () => {
  if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = prevCodexHome;
  await rm(root, { recursive: true, force: true });
});

async function readGlobal(): Promise<Record<string, any>> {
  return parse(await readFile(join(process.env.CODEX_HOME!, "config.toml"), "utf8")) as Record<
    string,
    any
  >;
}

describe("codexWriter", () => {
  it("writes the project config with the token inline and returns void", async () => {
    const result = await codexWriter.write(seat);
    expect(result).toBeUndefined();

    const cfg = parse(await readFile(join(seat.folder, ".codex", "config.toml"), "utf8")) as any;
    expect(cfg.mcp_servers.memracer_coder_ab12).toEqual({
      url: "https://memracer.com/mcp",
      http_headers: { Authorization: "Bearer mzr_live_x" },
    });
  });

  it("gitignores .codex/ so the token never lands in the repo", async () => {
    await codexWriter.write(seat);
    const ignore = await readFile(join(seat.folder, ".gitignore"), "utf8");
    expect(ignore).toMatch(/^\.codex\/$/m);
  });

  it("trusts the seat folder in the global config so codex loads the project config", async () => {
    await codexWriter.write(seat);
    const global = await readGlobal();
    expect(global.projects[seat.folder]).toEqual({ trust_level: "trusted" });
  });

  it("preserves unrelated projects and settings already in the global config", async () => {
    const home = process.env.CODEX_HOME!;
    await mkdir(home, { recursive: true });
    await writeFile(
      join(home, "config.toml"),
      ['model = "o3"', "", '[projects."/other/repo"]', 'trust_level = "trusted"', ""].join("\n"),
    );
    await codexWriter.write(seat);
    const global = await readGlobal();
    expect(global.model).toBe("o3");
    expect(global.projects["/other/repo"]).toEqual({ trust_level: "trusted" });
    expect(global.projects[seat.folder]).toEqual({ trust_level: "trusted" });
  });

  it("removes a stale global mcp_servers entry for this URL (the old env-var design)", async () => {
    const home = process.env.CODEX_HOME!;
    await mkdir(home, { recursive: true });
    await writeFile(
      join(home, "config.toml"),
      [
        "[mcp_servers.memracer_coder_ab12]",
        'url = "https://memracer.com/mcp"',
        'bearer_token_env_var = "MEMRACER_TOKEN_MEMRACER_CODER_AB12"',
        "",
        "[mcp_servers.some_other]",
        'url = "https://example.com/mcp"',
        "",
      ].join("\n"),
    );
    await codexWriter.write(seat);
    const global = await readGlobal();
    expect(global.mcp_servers.memracer_coder_ab12).toBeUndefined();
    expect(global.mcp_servers.some_other).toEqual({ url: "https://example.com/mcp" });
  });

  it("repairs permissions when updating existing project and global config", async () => {
    await codexWriter.write(seat);
    const projectFile = join(seat.folder, ".codex", "config.toml");
    const globalFile = join(process.env.CODEX_HOME!, "config.toml");
    await chmod(projectFile, 0o644);
    await chmod(globalFile, 0o644);
    await codexWriter.write({ ...seat, token: "replacement-test-token" });
    expect((await stat(projectFile)).mode & 0o777).toBe(0o600);
    expect((await stat(globalFile)).mode & 0o777).toBe(0o600);
  });

  it("writes the config files 0600 (they carry a live token / trust grant)", async () => {
    await codexWriter.write(seat);
    const proj = await stat(join(seat.folder, ".codex", "config.toml"));
    const glob = await stat(join(process.env.CODEX_HOME!, "config.toml"));
    expect(proj.mode & 0o777).toBe(0o600);
    expect(glob.mode & 0o777).toBe(0o600);
  });
});
