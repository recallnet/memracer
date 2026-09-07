import type { Command } from "commander";
import { baseUrlFromEnv, mintEnrollment, redeemEnrollment, type RedeemedSeat } from "../api.js";
import { detectHarnesses } from "../harness/detect.js";
import type { HarnessWriter } from "../harness/index.js";
import { Registry, type SeatRecord } from "../registry.js";
import { provisionSeat } from "../provision.js";
import { runProcess } from "../proc.js";
import { seatFolder } from "../worktree.js";
import { CredentialStore, type Credential } from "../credentials.js";
import { pickHarness } from "./enroll.js";
import { registerSeatManage } from "./seat-manage.js";

export interface SeatAddDeps {
  detect: () => Promise<HarnessWriter[]>;
  seatFolder: (a: { role: string; repo: string; role_is_worker: boolean }) => Promise<string>;
  provision: typeof provisionSeat;
  redeem: (baseUrl: string, token: string) => Promise<RedeemedSeat>;
  register: (rec: SeatRecord) => Promise<void>;
  /** The stored operator credential, or null when logged out. */
  credential: () => Credential | null;
  /** Mint an enrollment as the operator (used when a credential exists). */
  mintEnrollment: (baseUrl: string, operatorToken: string, project: string, role: string) => Promise<{ token: string }>;
  baseUrl: () => string;
  cwd: () => string;
  log: (msg: string) => void;
}

/**
 * Add a seat for a role. When the operator is logged in (a stored credential),
 * the CLI mints its own enrollment for `--project` — no dashboard round-trip and
 * no `--token`. Logged out, it falls back to a `--token` minted in the dashboard.
 */
export async function runSeatAdd(
  opts: { role: string; project?: string; token?: string; harness?: string },
  deps: SeatAddDeps,
): Promise<void> {
  const harness = pickHarness(await deps.detect(), opts.harness);
  const credential = deps.credential();
  let token = opts.token;
  let baseUrl = deps.baseUrl();
  if (credential) {
    if (!opts.project) throw new Error("--project <id> is required to mint a seat when logged in");
    baseUrl = credential.baseUrl;
    const enrollment = await deps.mintEnrollment(baseUrl, credential.token, opts.project, opts.role);
    token = enrollment.token;
  }
  if (!token) {
    throw new Error("Not logged in — run `memracer login`, or pass --token <enrollToken> from the dashboard");
  }
  const roleIsWorker = opts.role !== "human";
  const folder = await deps.seatFolder({ role: opts.role, repo: deps.cwd(), role_is_worker: roleIsWorker });
  const seat = await deps.provision({
    baseUrl,
    token,
    folder,
    harness,
    redeem: deps.redeem,
    register: deps.register,
  });
  const where = roleIsWorker ? `isolated worktree ${folder}` : folder;
  deps.log(`✓ ${seat.role} seat for ${seat.projectName} landed in ${where} via ${harness.id}`);
  deps.log(`  Launch it: cd ${folder} && ${harness.bin}`);
}

export function registerSeat(program: Command): void {
  const seat = program.command("seat").description("Manage local seats");
  registerSeatManage(seat);
  seat
    .command("add <role>")
    .description("Add a seat for a role (workers get an isolated worktree)")
    .option("--project <id>", "project to mint the seat in (required when logged in)")
    .option("--token <enrollToken>", "enrollment token minted in the dashboard (when logged out)")
    .option("--harness <id>", "harness to configure (claude, grok, codex)")
    .action(async (role: string, options: { project?: string; token?: string; harness?: string }) => {
      await runSeatAdd(
        { role, project: options.project, token: options.token, harness: options.harness },
        {
          detect: () => detectHarnesses(),
          seatFolder: (a) => seatFolder(a, runProcess),
          provision: provisionSeat,
          redeem: redeemEnrollment,
          register: (r) => Promise.resolve(new Registry().add(r)),
          credential: () => new CredentialStore().load(),
          mintEnrollment: (b, t, p, r) => mintEnrollment(b, t, p, r),
          baseUrl: () => baseUrlFromEnv(),
          cwd: () => process.cwd(),
          log: (m) => console.log(m),
        },
      );
    });
}
