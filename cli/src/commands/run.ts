import { spawn } from "node:child_process";
import type { Command } from "commander";
import { Registry, type SeatRecord } from "../registry.js";

/** The record for `role` whose folder is `cwd` or the nearest ancestor of it. */
export function findSeat(records: SeatRecord[], role: string, cwd: string): SeatRecord | undefined {
  return records
    .filter((r) => r.role === role && (cwd === r.folder || cwd.startsWith(`${r.folder}/`)))
    .sort((a, b) => b.folder.length - a.folder.length)[0];
}

export interface RunDeps {
  list: () => SeatRecord[];
  cwd: () => string;
  env: NodeJS.ProcessEnv;
  spawn: (cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => Promise<number>;
}

/**
 * Launch a child process under a seat's identity. Header-based seats
 * (Claude/Grok) already carry their auth in config, so we just spawn. A Codex
 * seat reads its token from an env var that is NOT stored in the registry, so
 * `run` requires the token via MEMRACER_SEAT_TOKEN or --token and injects it
 * into the child's environment. Returns the child's exit code.
 */
export async function runRun(
  opts: { role: string; cmd: string[]; token?: string },
  deps: RunDeps,
): Promise<number> {
  if (opts.cmd.length === 0) {
    throw new Error("Nothing to run: pass the command after `--`, e.g. `memracer run coder -- claude`.");
  }
  const seat = findSeat(deps.list(), opts.role, deps.cwd());
  if (!seat) {
    throw new Error(`No ${opts.role} seat configured for ${deps.cwd()}.`);
  }
  const env: NodeJS.ProcessEnv = { ...deps.env };
  if (seat.envVar) {
    const token = opts.token ?? deps.env.MEMRACER_SEAT_TOKEN;
    if (!token) {
      throw new Error(
        `This ${seat.harness} seat reads its token from ${seat.envVar}, which the CLI does not store. ` +
          "Set MEMRACER_SEAT_TOKEN or pass --token <seatKey>.",
      );
    }
    env[seat.envVar] = token;
  }
  const [cmd, ...args] = opts.cmd;
  return deps.spawn(cmd!, args, { env });
}

function spawnInherit(cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "inherit", env: opts.env });
    child.on("close", (code) => resolve(code ?? 0));
    child.on("error", () => resolve(127));
  });
}

export function registerRun(program: Command): void {
  program
    .command("run <role> [command...]")
    .description("Launch a command under a seat's identity (env injection for codex seats)")
    .option("--token <seatKey>", "seat key for codex seats (or set MEMRACER_SEAT_TOKEN)")
    .action(async (role: string, command: string[], options: { token?: string }) => {
      const code = await runRun(
        { role, cmd: command, token: options.token },
        {
          list: () => new Registry().list(),
          cwd: () => process.cwd(),
          env: process.env,
          spawn: spawnInherit,
        },
      );
      process.exit(code);
    });
}
