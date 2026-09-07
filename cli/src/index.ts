import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { registerEnroll } from "./commands/enroll.js";
import { registerLogin } from "./commands/login.js";
import { registerSeat } from "./commands/seat-add.js";
import { registerPs } from "./commands/ps.js";
import { registerUpdate } from "./commands/update.js";
import { registerRun } from "./commands/run.js";
import { registerWait } from "./commands/wait.js";

export function buildProgram(): Command {
  const program = new Command();
  program.name("memracer").description("memracer CLI");
  registerEnroll(program);
  registerLogin(program);
  registerSeat(program);
  registerPs(program);
  registerUpdate(program);
  registerRun(program);
  registerWait(program);
  return program;
}

/**
 * True when this module is the process entrypoint. A global install exposes the
 * bin as a SYMLINK (npm's global bin, or ~/.local/bin), so `process.argv[1]` is
 * the symlink path while `import.meta.url` is the resolved real path — a raw
 * string compare never matches and the CLI silently does nothing. Resolve both
 * through realpath so the symlinked bin is recognized as main.
 */
function invokedAsMain(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsMain()) {
  buildProgram().parseAsync(process.argv).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
