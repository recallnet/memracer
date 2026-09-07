import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, last4OfSecret } from "../src/secrets.js";

const env = { BETTER_AUTH_SECRET: "test-secret-key-for-byok-envelope-32b" };

describe("secrets envelope", () => {
  it("encrypts and decrypts with last4 only for display", () => {
    const secret = "sk-or-v1-abcdefghijklmnop";
    const enc = encryptSecret(secret, env);
    expect(enc.last4).toBe("mnop");
    expect(enc.ciphertext).not.toContain(secret);
    expect(decryptSecret(enc, env)).toBe(secret);
    expect(last4OfSecret(secret)).toBe("mnop");
  });

  it("fails closed without a master key", () => {
    expect(() => encryptSecret("sk-test", {})).toThrow(/MEMRACER_SECRETS_KEY|BETTER_AUTH_SECRET/);
  });

  it("rejects empty secrets", () => {
    expect(() => encryptSecret("  ", env)).toThrow(/non-empty/);
  });
});
