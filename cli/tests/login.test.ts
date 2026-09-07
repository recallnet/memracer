import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeLogin, runLogin } from "../src/commands/login.js";
import { CredentialStore } from "../src/credentials.js";

const dirs: string[] = [];
function tmpStore(): CredentialStore {
  const dir = mkdtempSync(join(tmpdir(), "mzr-login-"));
  dirs.push(dir);
  return new CredentialStore(join(dir, "credentials.json"));
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("completeLogin", () => {
  it("exchanges the code and stores the operator token against the base URL", async () => {
    const store = tmpStore();
    const doFetch = vi.fn(async () =>
      new Response(JSON.stringify({ token: "op_secret", userId: "u1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await completeLogin("https://memracer.com", "code-123", store, doFetch as unknown as typeof fetch);

    expect(doFetch).toHaveBeenCalledWith(
      "https://memracer.com/api/cli/token",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ code: "code-123" }) }),
    );
    expect(store.load()).toEqual({ baseUrl: "https://memracer.com", token: "op_secret" });
  });

  it("throws and stores nothing when the exchange fails", async () => {
    const store = tmpStore();
    const doFetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "invalid or expired login code" }), { status: 400 }),
    );
    await expect(
      completeLogin("https://memracer.com", "bad", store, doFetch as unknown as typeof fetch),
    ).rejects.toThrow(/invalid or expired login code/);
    expect(store.load()).toBeNull();
  });
});

describe("runLogin (paste flow)", () => {
  it("shows the authorize URL, reads the pasted code, and stores the token — no loopback", async () => {
    const store = tmpStore();
    const logs: string[] = [];
    const opened: string[] = [];
    const doFetch = vi.fn(async () =>
      new Response(JSON.stringify({ token: "op_secret", userId: "u1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await runLogin({
      baseUrl: () => "https://memracer.com",
      store,
      open: (url) => opened.push(url),
      log: (m) => logs.push(m),
      prompt: async () => "  pasted-code  ",
      doFetch: doFetch as unknown as typeof fetch,
    });
    expect(opened).toContain("https://memracer.com/api/cli/authorize");
    expect(logs.join("\n")).toContain("/api/cli/authorize");
    expect(doFetch).toHaveBeenCalledWith(
      "https://memracer.com/api/cli/token",
      expect.objectContaining({ body: JSON.stringify({ code: "pasted-code" }) }),
    );
    expect(store.load()).toMatchObject({ token: "op_secret" });
    expect(logs).toContain("Logged in.");
  });
});
