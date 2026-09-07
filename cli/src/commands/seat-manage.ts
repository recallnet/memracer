import type { Command } from "commander";
import { listSeats, revokeSeat, type Seat } from "../api.js";
import { CredentialStore, type Credential } from "../credentials.js";

export interface SeatManageDeps {
  /** The stored operator credential, or null when logged out. */
  credential: () => Credential | null;
  listSeats: (baseUrl: string, operatorToken: string, project: string) => Promise<Seat[]>;
  revokeSeat: (baseUrl: string, operatorToken: string, project: string, keyId: string) => Promise<void>;
  log: (msg: string) => void;
}

function requireCredential(deps: SeatManageDeps): Credential {
  const credential = deps.credential();
  if (!credential) {
    throw new Error("Not logged in — run: memracer login");
  }
  return credential;
}

function requireProject(project: string | undefined): string {
  if (!project) {
    throw new Error("--project <id> is required");
  }
  return project;
}

function lastUsed(seat: Seat): string {
  return seat.lastUsedAt ? new Date(seat.lastUsedAt).toISOString() : "never";
}

/**
 * `seat ls` — list the operator's OWN seats on a project. Needs a stored
 * credential (the server scopes the result to its owner).
 */
export async function runSeatLs(opts: { project?: string }, deps: SeatManageDeps): Promise<void> {
  const credential = requireCredential(deps);
  const project = requireProject(opts.project);
  const seats = await deps.listSeats(credential.baseUrl, credential.token, project);
  if (seats.length === 0) {
    deps.log("No seats. Add one with `memracer seat add <role> --project " + project + "`.");
    return;
  }
  deps.log(["id", "role", "name", "lastUsed"].join("  "));
  for (const seat of seats) {
    deps.log([seat.id, seat.type, seat.name, lastUsed(seat)].join("  "));
  }
}

/**
 * `seat revoke <seat>` — revoke one of the operator's OWN seats. `<seat>` is a
 * key id OR an exact name; an ambiguous name (multiple matches) is rejected in
 * favor of the unambiguous id.
 */
export async function runSeatRevoke(
  opts: { seat: string; project?: string; yes?: boolean },
  deps: SeatManageDeps,
): Promise<void> {
  const credential = requireCredential(deps);
  const project = requireProject(opts.project);
  const seats = await deps.listSeats(credential.baseUrl, credential.token, project);
  const byId = seats.find((s) => s.id === opts.seat);
  let target = byId;
  if (!target) {
    const byName = seats.filter((s) => s.name === opts.seat);
    if (byName.length > 1) {
      const ids = byName.map((s) => `  ${s.id}  ${s.type}  ${s.name}`).join("\n");
      throw new Error(`"${opts.seat}" matches ${byName.length} seats — re-run with the id:\n${ids}`);
    }
    target = byName[0];
  }
  if (!target) {
    throw new Error(`no seat matching "${opts.seat}" on ${project}`);
  }
  await deps.revokeSeat(credential.baseUrl, credential.token, project, target.id);
  deps.log(`revoked ${target.name} (${target.id})`);
}

/** Attach `ls` and `revoke` under an existing `seat` command. */
export function registerSeatManage(seat: Command): void {
  const wire = (): SeatManageDeps => ({
    credential: () => new CredentialStore().load(),
    listSeats: (b, t, p) => listSeats(b, t, p),
    revokeSeat: (b, t, p, k) => revokeSeat(b, t, p, k),
    log: (m) => console.log(m),
  });
  seat
    .command("ls")
    .description("List your seats on a project")
    .option("--project <id>", "project whose seats to list")
    .action(async (options: { project?: string }) => {
      await runSeatLs({ project: options.project }, wire());
    });
  seat
    .command("revoke <seat>")
    .description("Revoke one of your seats (by key id or exact name)")
    .option("--project <id>", "project the seat belongs to")
    .option("--yes", "skip confirmation")
    .action(async (seatArg: string, options: { project?: string; yes?: boolean }) => {
      await runSeatRevoke({ seat: seatArg, project: options.project, yes: options.yes }, wire());
    });
}
