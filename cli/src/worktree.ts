import type { Runner } from "./harness/index.js";
import { appendGitignore } from "./harness/gitignore.js";

/**
 * Where a seat's harness config should live. A human (non-worker) seat runs in
 * the repo itself. A worker seat gets an isolated git worktree under
 * `<repo>/.mcr/<role>-<n>` on its own branch, so parallel coders never share a
 * checkout. `.mcr/` is added to the repo's .gitignore so the worktrees (and any
 * config they carry) stay out of version control.
 */
export async function seatFolder(
  a: { role: string; repo: string; role_is_worker: boolean },
  git: Runner,
): Promise<string> {
  if (!a.role_is_worker) return a.repo;
  const suffix = `${a.role}-${Math.floor(Date.now() / 1000) % 100000}`;
  const dir = `${a.repo}/.mcr/${suffix}`;
  const res = await git("git", ["worktree", "add", dir, "-b", suffix], { cwd: a.repo });
  if (res.code !== 0) {
    throw new Error(`git worktree add failed (exit ${res.code}): ${res.stderr}`);
  }
  await appendGitignore(a.repo, ".mcr/");
  return dir;
}
