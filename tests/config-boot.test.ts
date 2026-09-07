import { describe, expect, it, vi } from "vitest";
import {
  assertBootConfig,
  loadBootConfig,
  loadGithubConfig,
  validateBootConfig,
} from "../src/config.js";

describe("loadGithubConfig", () => {
  it("reports canVerifyPr when TOKEN is set", () => {
    const g = loadGithubConfig({ MEMRACER_GITHUB_TOKEN: "ghp_x" });
    expect(g.hasPat).toBe(true);
    expect(g.canVerifyPr).toBe(true);
    expect(g.hasAppAuth).toBe(false);
  });

  it("reports canVerifyPr when App ID + private key are set", () => {
    const g = loadGithubConfig({
      MEMRACER_GITHUB_APP_ID: "123",
      MEMRACER_GITHUB_APP_PRIVATE_KEY: "-----BEGIN KEY-----\nabc\n-----END KEY-----",
    });
    expect(g.hasAppAuth).toBe(true);
    expect(g.canVerifyPr).toBe(true);
    expect(g.hasPat).toBe(false);
  });

  it("treats empty strings as absent", () => {
    const g = loadGithubConfig({
      MEMRACER_GITHUB_TOKEN: "  ",
      MEMRACER_GITHUB_APP_ID: "",
      MEMRACER_GITHUB_WEBHOOK_SECRET: "\t",
    });
    expect(g.token).toBeNull();
    expect(g.canVerifyPr).toBe(false);
    expect(g.hasWebhook).toBe(false);
  });
});

describe("validateBootConfig", () => {
  it("fatals when no verification path and mediator is not fake", () => {
    const v = validateBootConfig(loadBootConfig({ MEMRACER_MEDIATOR_DRIVER: "openrouter" }));
    expect(v.fatals.length).toBe(1);
    expect(v.fatals[0]).toMatch(/MEMRACER_GITHUB_TOKEN/);
    expect(v.fatals[0]).toMatch(/MEMRACER_GITHUB_APP_ID/);
    expect(v.fatals[0]).toMatch(/DONE-gating will refuse all completions/);
  });

  it("skips fatal under fake mediator (local/test boot)", () => {
    const v = validateBootConfig(loadBootConfig({ MEMRACER_MEDIATOR_DRIVER: "fake" }));
    expect(v.fatals).toEqual([]);
  });

  it("warns on partial App pair", () => {
    const v = validateBootConfig(
      loadBootConfig({
        MEMRACER_MEDIATOR_DRIVER: "fake",
        MEMRACER_GITHUB_APP_ID: "42",
      }),
    );
    expect(v.warnings.some((w) => /PRIVATE_KEY/.test(w) && /disabled/i.test(w))).toBe(true);
  });

  it("warns when App auth and webhook secret are absent", () => {
    const v = validateBootConfig(
      loadBootConfig({
        MEMRACER_MEDIATOR_DRIVER: "fake",
        MEMRACER_GITHUB_TOKEN: "ghp_x",
      }),
    );
    expect(v.fatals).toEqual([]);
    expect(v.warnings.some((w) => /APP_ID/.test(w) && /installation tokens disabled/i.test(w))).toBe(
      true,
    );
    expect(v.warnings.some((w) => /WEBHOOK_SECRET/.test(w) && /webhook settlements disabled/i.test(w))).toBe(
      true,
    );
  });

  it("is quiet when App + webhook fully configured", () => {
    const v = validateBootConfig(
      loadBootConfig({
        MEMRACER_GITHUB_APP_ID: "1",
        MEMRACER_GITHUB_APP_PRIVATE_KEY: "k",
        MEMRACER_GITHUB_WEBHOOK_SECRET: "s",
      }),
    );
    expect(v.fatals).toEqual([]);
    expect(v.warnings).toEqual([]);
  });
});

describe("assertBootConfig", () => {
  it("exits non-zero on fatals after printing them", () => {
    const error = vi.fn();
    const warn = vi.fn();
    const exit = vi.fn();
    assertBootConfig(loadBootConfig({}), { error, warn, exit });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("[boot-config] FATAL:"));
    expect(error.mock.calls[0][0]).toMatch(/DONE-gating will refuse all completions/);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("only warns when credentials exist but optional paths are off", () => {
    const error = vi.fn();
    const warn = vi.fn();
    const exit = vi.fn();
    assertBootConfig(loadBootConfig({ MEMRACER_GITHUB_TOKEN: "ghp_x" }), { error, warn, exit });
    expect(exit).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(warn.mock.calls.length).toBeGreaterThan(0);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("WARNING"))).toBe(true);
  });
});
