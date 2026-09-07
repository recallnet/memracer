import { describe, expect, it, vi } from "vitest";
import { runRun, findSeat, type RunDeps } from "../src/commands/run.js";
import type { SeatRecord } from "../src/registry.js";

const codex: SeatRecord = { project: "p", role: "coder", folder: "/wt", harness: "codex", keyId: "k2", envVar: "MEMRACER_TOKEN_X" };
const claude: SeatRecord = { project: "p", role: "human", folder: "/repo", harness: "claude", keyId: "k1" };

function deps(over: { records: SeatRecord[]; cwd?: string; env?: NodeJS.ProcessEnv }): {
  deps: RunDeps;
  spawn: ReturnType<typeof makeSpawn>;
} {
  const spawn = makeSpawn();
  return {
    spawn,
    deps: {
      list: () => over.records,
      cwd: () => over.cwd ?? "/wt",
      env: over.env ?? {},
      spawn,
    },
  };
}

function makeSpawn() {
  return vi.fn(async (_cmd: string, _args: string[], _opts: { env: NodeJS.ProcessEnv }) => 0);
}

describe("findSeat", () => {
  it("matches the nearest ancestor folder for the role", () => {
    const parent: SeatRecord = { ...claude, folder: "/wt" };
    const child: SeatRecord = { ...claude, folder: "/wt/sub" };
    expect(findSeat([parent, child], "human", "/wt/sub/x")).toBe(child);
  });
});

describe("runRun", () => {
  it("injects the seat token into the child env var for a codex seat", async () => {
    const { deps: d, spawn } = deps({ records: [codex], env: { MEMRACER_SEAT_TOKEN: "mzr_live_secret" } });
    const code = await runRun({ role: "coder", cmd: ["codex", "exec"] }, d);
    expect(code).toBe(0);
    expect(spawn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawn.mock.calls[0]!;
    expect(cmd).toBe("codex");
    expect(args).toEqual(["exec"]);
    expect(opts.env.MEMRACER_TOKEN_X).toBe("mzr_live_secret");
  });

  it("accepts --token over the env for a codex seat", async () => {
    const { deps: d, spawn } = deps({ records: [codex] });
    await runRun({ role: "coder", cmd: ["codex"], token: "from_flag" }, d);
    expect(spawn.mock.calls[0]![2].env.MEMRACER_TOKEN_X).toBe("from_flag");
  });

  it("throws when a codex seat has no token available", async () => {
    const { deps: d } = deps({ records: [codex] });
    await expect(runRun({ role: "coder", cmd: ["codex"] }, d)).rejects.toThrow(/MEMRACER_SEAT_TOKEN/);
  });

  it("just spawns for a header-based seat (no token needed)", async () => {
    const { deps: d, spawn } = deps({ records: [claude], cwd: "/repo" });
    await runRun({ role: "human", cmd: ["claude", "--foo"] }, d);
    const [cmd, args, opts] = spawn.mock.calls[0]!;
    expect(cmd).toBe("claude");
    expect(args).toEqual(["--foo"]);
    expect(opts.env.MEMRACER_TOKEN_X).toBeUndefined();
  });

  it("throws when no seat matches the role/cwd", async () => {
    const { deps: d } = deps({ records: [claude], cwd: "/elsewhere" });
    await expect(runRun({ role: "coder", cmd: ["x"] }, d)).rejects.toThrow(/No coder seat/);
  });

  it("throws when no command is given", async () => {
    const { deps: d } = deps({ records: [claude], cwd: "/repo" });
    await expect(runRun({ role: "human", cmd: [] }, d)).rejects.toThrow(/Nothing to run/);
  });
});
