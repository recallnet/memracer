import type { RedeemedSeat } from "./api.js";
import type { HarnessWriter } from "./harness/index.js";
import type { SeatRecord } from "./registry.js";
import { runProcess } from "./proc.js";
import { writeSeatEnv } from "./seat-env.js";

export interface ProvisionArgs {
  baseUrl: string;
  token: string;
  folder: string;
  harness: HarnessWriter;
  redeem: (baseUrl: string, token: string) => Promise<RedeemedSeat>;
  register: (rec: SeatRecord) => Promise<void>;
  /** Write the seat env file (Fix B). Injectable for tests; defaults to the real writer. */
  writeSeatEnv?: (folder: string, seat: RedeemedSeat) => Promise<void>;
}

/**
 * Redeem an enrollment into a seat, write the harness config for `folder`, and
 * record the seat locally. Codex seats carry a unique per-seat server name (a
 * carryover from its old global config; harmless now that it writes a
 * folder-scoped config); Claude/Grok scope by folder and reuse the plain
 * "memracer" name. The seat secret is never written to the registry — each
 * harness stores it inline in its own (gitignored) config.
 */
export async function provisionSeat(a: ProvisionArgs): Promise<RedeemedSeat> {
  const seat = await a.redeem(a.baseUrl, a.token);
  const serverName =
    a.harness.id === "codex" ? `memracer_${seat.role}_${seat.keyId.slice(0, 4)}` : "memracer";
  const writeRes = await a.harness.write(
    { name: serverName, url: seat.mcpUrl, token: seat.key, folder: a.folder },
    runProcess,
  );
  await a.register({
    project: seat.projectId,
    role: seat.role,
    folder: a.folder,
    harness: a.harness.id,
    keyId: seat.keyId,
    envVar: (writeRes as { envVar?: string } | void)?.envVar,
  });
  // Drop a seat env file (URL + seat token) so an agent in this folder can make
  // its own memracer calls without scraping ~/.memracer/credentials.json.
  await (a.writeSeatEnv ?? writeSeatEnv)(a.folder, seat);
  return seat;
}
