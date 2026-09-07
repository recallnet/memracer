import type { Command } from "commander";
import type { RunResult, Runner } from "../harness/index.js";
import { Registry, type SeatRecord } from "../registry.js";
import { runProcess } from "../proc.js";

/**
 * How to verify a seat's MCP entry still exists in its harness config. We can
 * only re-assert non-secret config: the registry never stores the seat secret
 * (Claude/Grok wrote it into their own config; Codex reads it from env), so
 * `update` is a health/report pass, not a re-write. It reconstructs the server
 * name the way provisioning did (Codex names are per-seat) and asks the harness.
 */
function harnessCheck(rec: SeatRecord): { bin: string; args: string[]; verify: (r: RunResult) => boolean } {
  const serverName =
    rec.harness === "codex" ? `memracer_${rec.role}_${rec.keyId.slice(0, 4)}` : "memracer";
  if (rec.harness === "claude") {
    return { bin: "claude", args: ["mcp", "get", serverName], verify: (r) => r.code === 0 };
  }
  if (rec.harness === "grok") {
    return { bin: "grok", args: ["mcp", "list"], verify: (r) => r.code === 0 && r.stdout.includes(serverName) };
  }
  return { bin: "codex", args: ["mcp", "list"], verify: (r) => r.code === 0 && r.stdout.includes(serverName) };
}

export interface UpdateDeps {
  list: () => SeatRecord[];
  run: Runner;
  log: (msg: string) => void;
}

export async function runUpdate(deps: UpdateDeps): Promise<void> {
  const records = deps.list();
  if (records.length === 0) {
    deps.log("No seats configured.");
    return;
  }
  for (const rec of records) {
    const check = harnessCheck(rec);
    const result = await deps.run(check.bin, check.args, { cwd: rec.folder });
    const ok = check.verify(result);
    deps.log(`${ok ? "OK     " : "MISSING"}  ${rec.harness}  ${rec.role}  ${rec.folder}`);
  }
}

export function registerUpdate(program: Command): void {
  program
    .command("update")
    .description("Verify each configured seat's MCP config is still healthy")
    .action(async () => {
      await runUpdate({
        list: () => new Registry().list(),
        run: runProcess,
        log: (m) => console.log(m),
      });
    });
}
