import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HarnessWriter } from "./index.js";
import { claudeWriter } from "./claude.js";
import { grokWriter } from "./grok.js";
import { codexWriter } from "./codex.js";

const execFileAsync = promisify(execFile);

/** All harness writers the CLI knows how to configure. */
export const ALL_WRITERS: HarnessWriter[] = [claudeWriter, grokWriter, codexWriter];

/** Resolves an executable via `command -v`, returning its path or null. */
export type Which = (bin: string) => Promise<string | null>;

/** The real PATH lookup. `command -v` is a shell builtin, so run it via `sh -c`
 * (a proper single shell arg) rather than execFile+args+shell, which Node
 * deprecates (DEP0190). `bin` comes from the fixed ALL_WRITERS allowlist. */
export const realWhich: Which = async (bin: string): Promise<string | null> => {
  try {
    const { stdout } = await execFileAsync("/bin/sh", ["-c", `command -v ${bin}`]);
    const path = stdout.trim();
    return path.length > 0 ? path : null;
  } catch {
    return null;
  }
};

/** The writers whose harness binary resolves on this machine. */
export async function detectHarnesses(which: Which = realWhich): Promise<HarnessWriter[]> {
  const found: HarnessWriter[] = [];
  for (const writer of ALL_WRITERS) {
    if (await which(writer.bin)) found.push(writer);
  }
  return found;
}
