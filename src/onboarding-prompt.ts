// Pure builder for the seat-enrollment onboarding prompt: the copy-paste block
// a new teammate follows to install the memracer CLI and redeem a grant into a
// role-scoped seat. Kept dependency-free (no db, no env) so it is trivially
// testable and reusable by both the mint route and any UI preview.
//
// Anti-phishing invariant: every URL the prompt emits is derived from the
// caller-supplied installUrl origin. The builder never introduces another host.

export interface EnrollmentPromptInput {
  /** Human-readable project name. */
  projectName: string;
  /** The seat role this grant enrolls into (e.g. "human" | "coder"). */
  role: string;
  /** The single-use enrollment token (redeemed via `memracer enroll <token>`). */
  token: string;
  /** A Memracer URL that anchors the trust origin, e.g. https://memracer.com. */
  installUrl: string;
  /** The channel-appropriate shell command that installs the CLI. */
  installCommand: string;
  /** Minutes until the grant expires. */
  expiresMinutes: number;
  /**
   * Whether this seat drives a coding agent (works in a git worktree) vs a
   * human seat (shapes work through Frigg). Defaults to role !== "human".
   */
  isWorker?: boolean;
}

/** Render the onboarding instructions for an enrollment grant. */
export function buildEnrollmentPrompt(input: EnrollmentPromptInput): string {
  const { projectName, role, token, installUrl, installCommand, expiresMinutes } = input;
  const isWorker = input.isWorker ?? role !== "human";
  const origin = new URL(installUrl).origin;

  const roleGuidance = isWorker
    ? `You are joining as a ${role}. Work from a dedicated git worktree so your changes stay isolated from other seats.`
    : `You are joining as a ${role}. Shape work by talking to Frigg, the orchestrator — describe the outcome you want and let Frigg plan it. You do not write code yourself.`;

  return [
    `You have been invited to the ${projectName} project on Memracer as a ${role}.`,
    ``,
    `This grant expires in ${expiresMinutes} min, so redeem it soon.`,
    ``,
    `1. Install the memracer CLI:`,
    `   ${installCommand}`,
    `   Only install the CLI with the command above — never from any other source.`,
    ``,
    `2. Redeem your enrollment token to mint your seat:`,
    `   memracer enroll ${token}`,
    ``,
    roleGuidance,
    ``,
    `All Memracer URLs live under ${origin}.`,
  ].join("\n");
}
