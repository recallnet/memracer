// CLI login loopback (D3). The operator runs `memracer login`, which opens the
// browser to the authorize endpoint. The signed-in session is exchanged for a
// short-lived, single-use login code delivered to a 127.0.0.1 redirect; the CLI
// then trades that code for an identity-wide OPERATOR token (not a project seat).
//
// Login codes are ephemeral by design — an in-memory Map with a 120s TTL is
// enough. A server restart mid-login just means the operator re-runs `login`.
import { randomBytes } from "node:crypto";
import type express from "express";
import type { Request, Response } from "express";
import type { Db } from "./db.js";

/** Login codes live only long enough to bounce through the browser and back. */
const LOGIN_CODE_TTL_MS = 120_000;

interface LoginCode {
  userId: string;
  expiresAt: number;
}

export interface CliAuthDeps {
  db: Db;
  /** Resolve the signed-in browser session, or 401-terminate the request. */
  sessionUserOr401: (
    req: Request,
    res: Response,
  ) => Promise<{ userId: string; name: string; email: string | null } | null>;
  /** Mint an identity-wide operator API key for a user; returns its plaintext. */
  mintOperatorKey: (userId: string) => Promise<{ token: string }>;
}

/**
 * A redirect_uri is accepted only when it targets the loopback interface over
 * plain http — the CLI's own ephemeral server. This is the gate that stops an
 * attacker from redirecting a freshly minted login code to a host they control.
 */
export function isLoopbackRedirect(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:") return false;
  return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
}

/** The paste-flow page: shows the single-use login code for the operator to copy. */
function loginCodePage(code: string): string {
  const safe = code.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]!));
  return (
    "<!doctype html><meta charset=utf-8><title>memracer login</title>" +
    "<body style=\"font:16px system-ui;max-width:34rem;margin:4rem auto;padding:0 1rem\">" +
    "<h1>memracer login</h1>" +
    "<p>Paste this code back into your terminal to finish signing in the CLI. " +
    "It is single-use and expires in about 2 minutes.</p>" +
    `<pre style="font-size:1.3rem;background:#111;color:#eee;padding:1rem;border-radius:8px;user-select:all;overflow-x:auto">${safe}</pre>` +
    "<p style=\"color:#666\">Then return to your terminal — you can close this tab.</p></body>"
  );
}

/** Register the CLI login: authorize (session → code, paste or loopback) + token (code → operator key). */
export function registerCliAuth(app: express.Express, deps: CliAuthDeps): void {
  const codes = new Map<string, LoginCode>();

  function prune(): void {
    const now = Date.now();
    for (const [code, entry] of codes) {
      if (entry.expiresAt < now) codes.delete(code);
    }
  }

  // Browser hits this already signed in; we mint a login code. Default is the
  // PASTE flow: render the code for the operator to copy into their terminal —
  // it works everywhere, including remote/SSH/tailnet machines where the CLI and
  // the browser are on different hosts (a loopback redirect can't reach the CLI
  // there). A loopback redirect_uri is still honored for same-machine callers.
  app.get("/api/cli/authorize", async (req, res) => {
    const user = await deps.sessionUserOr401(req, res);
    if (!user) return;
    prune();
    const code = randomBytes(24).toString("base64url");
    codes.set(code, { userId: user.userId, expiresAt: Date.now() + LOGIN_CODE_TTL_MS });
    const redirectUri = typeof req.query.redirect_uri === "string" ? req.query.redirect_uri : "";
    if (redirectUri) {
      if (!isLoopbackRedirect(redirectUri)) {
        res.status(400).json({ error: "redirect_uri must be a http://127.0.0.1 or http://localhost address" });
        return;
      }
      const state = typeof req.query.state === "string" ? req.query.state : "";
      const separator = redirectUri.includes("?") ? "&" : "?";
      const location = `${redirectUri}${separator}code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
      res.redirect(302, location);
      return;
    }
    res.status(200).type("html").send(loginCodePage(code));
  });

  // The CLI exchanges the code (single-use) for an operator token. Delete on
  // lookup so a replay of the same code always fails.
  app.post("/api/cli/token", async (req, res) => {
    prune();
    const code = typeof req.body?.code === "string" ? req.body.code : "";
    const entry = code ? codes.get(code) : undefined;
    if (entry) codes.delete(code);
    if (!entry || entry.expiresAt < Date.now()) {
      res.status(400).json({ error: "invalid or expired login code" });
      return;
    }
    const { token } = await deps.mintOperatorKey(entry.userId);
    res.json({ token, userId: entry.userId });
  });
}
