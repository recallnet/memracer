import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { seatFolder } from "../src/worktree.js";

const ok = async (_cmd: string, _args: string[], _opts: { cwd: string }) => ({
  code: 0,
  stdout: "",
  stderr: "",
});

describe("seatFolder", () => {
  it("human/non-worker seat returns the repo and never calls git", async () => {
    const git = vi.fn(ok);
    const out = await seatFolder({ role: "human", repo: "/repo", role_is_worker: false }, git);
    expect(out).toBe("/repo");
    expect(git).not.toHaveBeenCalled();
  });

  it("worker seat creates a .mcr worktree and returns its path", async () => {
    const repo = await mkdtemp(join(tmpdir(), "mcr-repo-"));
    const git = vi.fn(ok);
    const out = await seatFolder({ role: "coder", repo, role_is_worker: true }, git);
    expect(out).toMatch(new RegExp(`^${repo}/\\.mcr/coder-\\d+$`));
    expect(git).toHaveBeenCalledTimes(1);
    const [cmd, args] = git.mock.calls[0]!;
    expect(cmd).toBe("git");
    expect(args.slice(0, 3)).toEqual(["worktree", "add", out]);
    expect(args).toContain("-b");
  });

  it("throws when git worktree add fails", async () => {
    const git = vi.fn(async () => ({ code: 1, stdout: "", stderr: "already exists" }));
    await expect(
      seatFolder({ role: "coder", repo: "/repo", role_is_worker: true }, git),
    ).rejects.toThrow(/worktree add failed/);
  });
});
