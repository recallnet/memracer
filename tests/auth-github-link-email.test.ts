import { describe, expect, it } from "vitest";
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
