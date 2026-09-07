import type { HarnessWriter, Runner, SeatConfig } from "./index.js";

/**
 * Claude Code writer. `claude mcp add ... --scope local` writes a private,
 * path-keyed entry (~/.claude.json keyed by cwd), so the run's cwd is the seat
 * folder. The token lands in Claude's own private config, not the repo.
 */
export const claudeWriter: HarnessWriter = {
  id: "claude",
  bin: "claude",
  async write(seat: SeatConfig, run: Runner): Promise<void> {
    const result = await run(
      "claude",
      [
        "mcp",
        "add",
        seat.name,
        "--transport",
        "http",
        seat.url,
        "--header",
        `Authorization: Bearer ${seat.token}`,
        "--scope",
        "local",
      ],
      { cwd: seat.folder },
    );
    if (result.code !== 0) {
      throw new Error(`claude mcp add failed (exit ${result.code}): ${result.stderr}`);
    }
  },
  locate(seat: SeatConfig): string {
    return `Claude Code local scope for ${seat.folder} (~/.claude.json)`;
  },
};
