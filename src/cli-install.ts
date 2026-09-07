// How a teammate installs the memracer CLI, per release channel.
//
// On the `github-release` channel the CLI ships as a tarball asset on this
// repository's moving `cli-latest` release and `gh` downloads it with the
// caller's existing GitHub credentials. Set MEMRACER_CLI_CHANNEL=npm to point
// the install command at the published npm package instead.

export type CliChannel = "github-release" | "npm";

const GH_REPO = "recallnet/memracer";
const GH_RELEASE_TAG = "cli-latest";
const NPM_PKG = "@recall/memracer";

export function cliChannel(env: NodeJS.ProcessEnv = process.env): CliChannel {
  return env.MEMRACER_CLI_CHANNEL === "npm" ? "npm" : "github-release";
}

/** The npm package name (used at GA / by `npm i -g`). */
export function cliPackageName(): string {
  return NPM_PKG;
}

/** Printed when the moving release does not exist yet on the repository. */
export const RELEASE_MISSING_MESSAGE =
  `memracer: no ${GH_RELEASE_TAG} release found on ${GH_REPO}; build the CLI from source instead (cli/README.md)`;

/**
 * The shell command a teammate runs to install the CLI on the active channel.
 * On the github-release channel a missing release stops the chain with a
 * message that points at the source build, so the npm step never runs on an
 * absent tarball.
 */
export function cliInstallCommand(env: NodeJS.ProcessEnv = process.env): string {
  if (cliChannel(env) === "npm") return `npm install -g ${NPM_PKG}`;
  return (
    `gh release download ${GH_RELEASE_TAG} -R ${GH_REPO} -p '*.tgz' -O /tmp/mzr.tgz` +
    ` || { echo "${RELEASE_MISSING_MESSAGE}" >&2; false; }` +
    ` && npm i -g /tmp/mzr.tgz`
  );
}
