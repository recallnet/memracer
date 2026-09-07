import { describe, expect, it } from "vitest";
import {
  LEGACY_PUBLIC_ORIGIN,
  PRIMARY_MCP_URL,
  PRIMARY_PUBLIC_ORIGIN,
  isLegacyPublicHost,
  resolvePublicUrl,
  trustedAuthOrigins,
} from "../src/public-hosts.js";

describe("public hosts", () => {
  it("defaults production-ish boots to memracer.com", () => {
    expect(resolvePublicUrl({ NODE_ENV: "production" })).toBe(PRIMARY_PUBLIC_ORIGIN);
    expect(resolvePublicUrl({ RAILWAY_ENVIRONMENT: "production" })).toBe(PRIMARY_PUBLIC_ORIGIN);
    expect(resolvePublicUrl({})).toBe("http://localhost:3000");
  });

  it("honors MEMRACER_PUBLIC_URL over defaults", () => {
    expect(resolvePublicUrl({ MEMRACER_PUBLIC_URL: "https://memracer.recall.net/" })).toBe(
      LEGACY_PUBLIC_ORIGIN,
    );
  });

  it("trusts both primary and legacy origins for auth", () => {
    const trusted = trustedAuthOrigins({});
    expect(trusted).toContain(PRIMARY_PUBLIC_ORIGIN);
    expect(trusted).toContain(LEGACY_PUBLIC_ORIGIN);
  });

  it("detects legacy host and primary MCP URL", () => {
    expect(isLegacyPublicHost("memracer.recall.net")).toBe(true);
    expect(isLegacyPublicHost("memracer.com")).toBe(false);
    expect(PRIMARY_MCP_URL).toBe("https://memracer.com/mcp");
  });
});
