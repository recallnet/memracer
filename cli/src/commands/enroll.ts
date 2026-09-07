import type { Command } from "commander";
import { baseUrlFromEnv, redeemEnrollment, type RedeemedSeat } from "../api.js";
import { detectHarnesses } from "../harness/detect.js";
import type { HarnessWriter } from "../harness/index.js";
import { Registry, type SeatRecord } from "../registry.js";
import { provisionSeat } from "../provision.js";

/** Choose the harness to configure: an explicit `--harness`, else the sole one. */
export function pickHarness(found: HarnessWriter[], requested?: string): HarnessWriter {
  if (found.length === 0) {
    throw new Error("No supported harness found (claude, grok, codex).");
  }
  if (requested) {
    const match = found.find((h) => h.id === requested);
    if (!match) {
      throw new Error(
        `Harness "${requested}" not detected. Found: ${found.map((h) => h.id).join(", ")}`,
      );
    }
    return match;
  }
  if (found.length === 1) return found[0]!;
  throw new Error(
    `Multiple harnesses found — pass --harness <${found.map((h) => h.id).join("|")}>`,
  );
}

export interface EnrollDeps {
  detect: () => Promise<HarnessWriter[]>;
  provision: typeof provisionSeat;
  redeem: (baseUrl: string, token: string) => Promise<RedeemedSeat>;
  register: (rec: SeatRecord) => Promise<void>;
  baseUrl: () => string;
  cwd: () => string;
  log: (msg: string) => void;
}

export async function runEnroll(
  opts: { token: string; harness?: string },
  deps: EnrollDeps,
): Promise<void> {
  const folder = deps.cwd();
  const harness = pickHarness(await deps.detect(), opts.harness);
  const seat = await deps.provision({
    baseUrl: deps.baseUrl(),
    token: opts.token,
    folder,
    harness,
    redeem: deps.redeem,
    register: deps.register,
  });
  deps.log(`✓ ${seat.role} seat connected to ${seat.projectName} via ${harness.id}`);
  deps.log("  Reconnect the MCP server in your harness to pick up the new seat.");
  if (harness.id === "codex") {
    deps.log(
      `  Codex is configured for this folder (.codex/config.toml, gitignored). ` +
        `Just run \`codex\` here — no env var, no wrapper.`,
    );
  }
}

export function registerEnroll(program: Command): void {
  program
    .command("enroll <token>")
    .description("Redeem an enrollment token to mint a seat key")
    .option("--harness <id>", "harness to configure (claude, grok, codex)")
    .action(async (token: string, options: { harness?: string }) => {
      await runEnroll(
        { token, harness: options.harness },
        {
          detect: () => detectHarnesses(),
          provision: provisionSeat,
          redeem: redeemEnrollment,
          register: (r) => Promise.resolve(new Registry().add(r)),
          baseUrl: () => baseUrlFromEnv(),
          cwd: () => process.cwd(),
          log: (m) => console.log(m),
        },
      );
    });
}
