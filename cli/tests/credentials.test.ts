import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore } from "../src/credentials.js";

const dirs: string[] = [];
function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "mzr-cred-"));
  dirs.push(dir);
  return join(dir, "nested", "credentials.json");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("CredentialStore", () => {
  it("returns null before anything is saved", () => {
    expect(new CredentialStore(tmpFile()).load()).toBeNull();
  });

  it("saves then loads a credential, creating parent dirs, at mode 0600", () => {
    const file = tmpFile();
    const store = new CredentialStore(file);
    store.save({ baseUrl: "https://memracer.com", token: "op_secret" });
    expect(store.load()).toEqual({ baseUrl: "https://memracer.com", token: "op_secret" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("clears the stored credential back to logged-out", () => {
    const store = new CredentialStore(tmpFile());
    store.save({ baseUrl: "https://memracer.com", token: "op_secret" });
    store.clear();
    expect(store.load()).toBeNull();
    // clearing an already-empty store is a no-op, not a throw
    expect(() => store.clear()).not.toThrow();
  });

  it("treats a malformed file as logged out", () => {
    const file = tmpFile();
    const store = new CredentialStore(file);
    store.save({ baseUrl: "x", token: "y" });
    writeFileSync(file, "{ not json");
    expect(store.load()).toBeNull();
  });
});
