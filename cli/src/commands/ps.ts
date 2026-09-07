import type { Command } from "commander";
import { baseUrlFromEnv, seatsLive, type SeatLive } from "../api.js";
import { Registry, type SeatRecord } from "../registry.js";
import { CredentialStore } from "../credentials.js";

export interface PsDeps {
  list: () => SeatRecord[];
  seatsLive: (baseUrl: string, projectId: string, token?: string) => Promise<SeatLive[]>;
  baseUrl: () => string;
  operatorToken: () => string | undefined;
  log: (msg: string) => void;
}

/**
 * List the local seat registry, one block per project, annotating each seat's
 * server-side liveness. Liveness is fetched when the operator is logged in (a
 * stored credential) or MEMRACER_OPERATOR_TOKEN is set; otherwise every seat
 * shows "—" (unknown). A fetch failure degrades to "—" rather than aborting.
 */
export async function runPs(deps: PsDeps): Promise<void> {
  const records = deps.list();
  if (records.length === 0) {
    deps.log("No seats configured. Run `memracer enroll <token>` to add one.");
    return;
  }
  const token = deps.operatorToken();
  const byProject = new Map<string, SeatRecord[]>();
  for (const r of records) {
    const bucket = byProject.get(r.project) ?? [];
    bucket.push(r);
    byProject.set(r.project, bucket);
  }
  for (const [projectId, recs] of byProject) {
    let live: Map<string, boolean> | null = null;
    if (token) {
      try {
        const seats = await deps.seatsLive(deps.baseUrl(), projectId, token);
        live = new Map(seats.map((s) => [s.keyId, s.live]));
      } catch {
        live = null;
      }
    }
    deps.log(projectId);
    for (const r of recs) {
      const status = live == null ? "—" : live.get(r.keyId) ? "●live" : "○idle";
      deps.log(`  ${r.folder}  ${r.role}  ${r.harness}  ${status}`);
    }
  }
}

export function registerPs(program: Command): void {
  program
    .command("ps")
    .description("List local seats and their liveness")
    .action(async () => {
      const credential = new CredentialStore().load();
      await runPs({
        list: () => new Registry().list(),
        seatsLive: (b, p, t) => seatsLive(b, p, undefined, t),
        baseUrl: () => credential?.baseUrl ?? baseUrlFromEnv(),
        operatorToken: () => credential?.token ?? process.env.MEMRACER_OPERATOR_TOKEN,
        log: (m) => console.log(m),
      });
    });
}
