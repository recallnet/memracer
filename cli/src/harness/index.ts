/** A configured seat: an MCP endpoint + seat key, scoped to a folder. */
export interface SeatConfig {
  /** The MCP server name registered in the harness config, e.g. "memracer". */
  name: string;
  /** The one MCP URL, e.g. https://memracer.com/mcp. */
  url: string;
  /** The seat key (bearer token). */
  token: string;
  /** The folder the harness config is scoped to (a worktree / seat dir). */
  folder: string;
}

/** The result of invoking a harness CLI. */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a harness CLI with args in a working directory. */
export type Runner = (
  cmd: string,
  args: string[],
  opts: { cwd: string },
) => Promise<RunResult>;

/** Writes an MCP seat into one harness's config format. */
export interface HarnessWriter {
  id: "claude" | "grok" | "codex";
  /** The executable this harness ships, resolved via PATH for detection. */
  bin: string;
  /**
   * Register the seat. Codex returns the env-var carrying its token (never
   * written to disk); Claude and Grok write the token to config and return void.
   */
  write(seat: SeatConfig, run: Runner): Promise<void | { envVar: string; token: string }>;
  /** A human-readable pointer to where the config lives. */
  locate(seat: SeatConfig): string;
}
