import { spawnSync } from "node:child_process";
import { describe, it, expect } from "vitest";
import { cliInstallCommand, cliChannel, RELEASE_MISSING_MESSAGE } from "../src/cli-install.js";

describe("cliInstallCommand", () => {
  it("defaults to the pre-release GitHub tarball channel", () => {
    expect(cliChannel({})).toBe("github-release");
    const cmd = cliInstallCommand({});
    expect(cmd).toContain("gh release download cli-latest -R recallnet/memracer");
    expect(cmd).toContain("npm i -g /tmp/mzr.tgz");
  });

  it("explains a missing release and skips the npm step", () => {
    const cmd = cliInstallCommand({});
    expect(cmd).toContain(RELEASE_MISSING_MESSAGE);
    expect(cmd).toMatch(/\|\| \{ echo ".*" >&2; false; \} && npm i -g/);
    const run = spawnSync("sh", ["-c", cmd.replace(/^gh release download [^|]*/, "false ")], { encoding: "utf8" });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("build the CLI from source");
    expect(run.stdout).not.toContain("npm");
  });

  it("switches to public npm when MEMRACER_CLI_CHANNEL=npm", () => {
    expect(cliChannel({ MEMRACER_CLI_CHANNEL: "npm" })).toBe("npm");
    expect(cliInstallCommand({ MEMRACER_CLI_CHANNEL: "npm" })).toBe("npm install -g @recall/memracer");
  });
});
