import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Command } from "commander";
import { baseUrlFromEnv } from "../api.js";
import { CredentialStore } from "../credentials.js";

type DoFetch = typeof fetch;

/**
 * Exchange a login code for an operator token and store it. Factored out of the
 * command plumbing so it is unit-testable with a fake fetch + a tmp store.
 */
export async function completeLogin(
  baseUrl: string,
  code: string,
  store: CredentialStore,
  doFetch: DoFetch = fetch,
): Promise<void> {
  const res = await doFetch(`${baseUrl}/api/cli/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const body = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
  if (!res.ok || !body.token) {
    throw new Error(body.error ?? `login failed (HTTP ${res.status})`);
  }
  store.save({ baseUrl, token: body.token });
}

/** Best-effort open a URL in the operator's browser. Printing is the reliable path. */
function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(cmd, [url], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // headless / no browser — the printed URL is the fallback
  }
}

/** Read one line (the pasted code) from stdin. Injectable for tests. */
function promptLine(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

export interface LoginDeps {
  baseUrl: () => string;
  store: CredentialStore;
  open: (url: string) => void;
  log: (msg: string) => void;
  prompt: (question: string) => Promise<string>;
  doFetch?: DoFetch;
}

/**
 * Paste-code login. The operator opens the authorize URL (already signed in),
 * the browser shows a single-use code, and they paste it back here. No loopback
 * server and no shared localhost, so it works the same on a laptop, over SSH,
 * or on a tailnet box — anywhere the CLI and the browser aren't the same host.
 */
export async function runLogin(deps: LoginDeps): Promise<void> {
  const baseUrl = deps.baseUrl();
  const authorizeUrl = `${baseUrl}/api/cli/authorize`;
  deps.log("Open this URL in your browser (you're already signed in), approve, and paste the code it shows:");
  deps.log(`  ${authorizeUrl}`);
  deps.open(authorizeUrl);
  const code = (await deps.prompt("Paste code: ")).trim();
  if (!code) throw new Error("no code entered");
  await completeLogin(baseUrl, code, deps.store, deps.doFetch);
  deps.log("Logged in.");
}

export function registerLogin(program: Command): void {
  program
    .command("login")
    .description("Log in to memracer and store an operator credential for the CLI")
    .action(async () => {
      await runLogin({
        baseUrl: () => baseUrlFromEnv(),
        store: new CredentialStore(),
        open: (url) => openBrowser(url),
        log: (m) => console.log(m),
        prompt: (q) => promptLine(q),
      });
    });
}
