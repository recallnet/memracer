import type { HarnessWriter, Runner, SeatConfig } from "./index.js";
import { appendGitignore } from "./gitignore.js";

type Ensure = (folder: string, line: string) => Promise<void>;

/**
 * Grok writer. `grok mcp add ... -s project` writes ./.grok/config.toml, which
 * grok commits by default — and the seat key lives in that file. So after
 * writing, append `.grok/` to the folder's .gitignore to keep the token out of
 * version control.
 */
export const grokWriter: HarnessWriter & {
  write(seat: SeatConfig, run: Runner, ensure?: Ensure): Promise<void>;
} = {
  id: "grok",
  bin: "grok",
  async write(seat: SeatConfig, run: Runner, ensure: Ensure = appendGitignore): Promise<void> {
    const result = await run(
      "grok",
      [
        "mcp",
        "add",
        seat.name,
        seat.url,
        "-t",
        "http",
        "-H",
        `Authorization: Bearer ${seat.token}`,
        "-s",
        "project",
      ],
      { cwd: seat.folder },
    );
    if (result.code !== 0) {
      throw new Error(`grok mcp add failed (exit ${result.code}): ${result.stderr}`);
    }
    await ensure(seat.folder, ".grok/");
  },
  locate(seat: SeatConfig): string {
    return `${seat.folder}/.grok/config.toml (gitignored)`;
  },
};
