import { closeSync, fchmodSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/** The operator credential minted by `memracer login`: an identity-wide token. */
export interface Credential {
  /** The memracer origin the token authenticates against (no trailing slash). */
  baseUrl: string;
  /** The operator token — a better-auth apikey tagged { type: "operator" }. */
  token: string;
}

const DEFAULT_FILE = join(homedir(), ".memracer", "credentials.json");

/**
 * A JSON-file store for the operator credential. Written 0600 (the token is a
 * long-lived secret), pretty-printed, with the parent directory created on
 * demand. A missing or malformed file reads as "logged out" (null).
 */
export class CredentialStore {
  constructor(private readonly file: string = DEFAULT_FILE) {}

  load(): Credential | null {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object") return null;
      const { baseUrl, token } = parsed as Partial<Credential>;
      if (typeof baseUrl !== "string" || typeof token !== "string") return null;
      return { baseUrl, token };
    } catch {
      return null;
    }
  }

  save(cred: Credential): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const file = openSync(this.file, "w", 0o600);
    try {
      // Creation mode does not tighten an existing file. Restrict before writing.
      fchmodSync(file, 0o600);
      writeFileSync(file, `${JSON.stringify(cred, null, 2)}\n`);
    } finally {
      closeSync(file);
    }
  }

  clear(): void {
    try {
      rmSync(this.file);
    } catch {
      // already gone — clearing a logged-out store is a no-op
    }
  }
}
