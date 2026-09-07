import { execFile } from "node:child_process";
import type { RunResult } from "./harness/index.js";

/**
 * Run a child process, capturing exit code + output. Never rejects: a non-zero
 * exit (or a spawn failure) resolves with the captured code so callers branch on
 * `code` rather than on a thrown error.
 */
export function runProcess(
  cmd: string,
  args: string[],
  opts: { cwd: string },
): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: opts.cwd }, (error, stdout, stderr) => {
      const err = error as (NodeJS.ErrnoException & { code?: number | string }) | null;
      const code = err == null ? 0 : typeof err.code === "number" ? err.code : 1;
      resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}
