import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { buildAuthOptions } from "../src/auth/instance.js";

describe("GitHub account linking emails", () => {
  it("allows different emails and does not update user info on link", () => {
    const db = openDb(":memory:");
    const handle = db.authDatabase();
    expect(handle).toBeTruthy();
    const options = buildAuthOptions(db, handle!);
    const linking = (options as { account?: { accountLinking?: Record<string, unknown> } }).account
      ?.accountLinking;
    expect(linking?.allowDifferentEmails).toBe(true);
    expect(linking?.trustedProviders).toEqual(["github"]);
    // updateUserInfoOnLink must not be true — preserves memracer user.email
    expect(linking?.updateUserInfoOnLink).not.toBe(true);
  });
});

describe("production auth signing configuration", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(["", "   "])("rejects a missing production signing secret (%j)", (secret) => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BETTER_AUTH_SECRET", secret);
    const db = openDb(":memory:");
    expect(() => buildAuthOptions(db, db.authDatabase()!)).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("rejects a missing Railway signing secret even without NODE_ENV", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("RAILWAY_ENVIRONMENT", "production");
    vi.stubEnv("BETTER_AUTH_SECRET", "");
    const db = openDb(":memory:");
    expect(() => buildAuthOptions(db, db.authDatabase()!)).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("uses the explicitly configured production secret", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BETTER_AUTH_SECRET", "production-test-signing-key-at-least-32-characters");
    const db = openDb(":memory:");
    expect(buildAuthOptions(db, db.authDatabase()!).secret).toBe(process.env.BETTER_AUTH_SECRET);
  });
});
