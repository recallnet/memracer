// A2: the pure onboarding-prompt builder. Given an enrollment grant it renders
// the copy-paste instructions a new teammate follows to install the CLI and
// redeem their token. It must never reference a host other than the install
// origin (anti-phishing), and it steers workers to a worktree, humans to Frigg.
import { describe, expect, it } from "vitest";
import { buildEnrollmentPrompt } from "../src/onboarding-prompt.js";

const base = {
  projectName: "Memracer",
  token: "mzr_enrl_abc123",
  installUrl: "https://memracer.com",
  installCommand: "gh release download cli-latest -R recallnet/memracer -p '*.tgz' -O /tmp/mzr.tgz && npm i -g /tmp/mzr.tgz",
  expiresMinutes: 15,
};

describe("buildEnrollmentPrompt", () => {
  it("renders the project, role, redeem command, install url and expiry", () => {
    const out = buildEnrollmentPrompt({ ...base, role: "coder" });
    expect(out).toContain("Memracer");
    expect(out).toContain("coder");
    expect(out).toContain("memracer enroll mzr_enrl_abc123");
    expect(out).toContain("gh release download cli-latest -R recallnet/memracer");
    expect(out).toContain("https://memracer.com");
    expect(out).toContain("15 min");
    expect(out).toContain("Only install the CLI with the command above");
  });

  it("only ever references the install origin (no other host)", () => {
    const out = buildEnrollmentPrompt({ ...base, role: "coder" });
    const urls = out.match(/https?:\/\/[^\s)"']+/g) ?? [];
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url.startsWith("https://memracer.com")).toBe(true);
    }
  });

  it("tells a worker (coder) to use a worktree", () => {
    const out = buildEnrollmentPrompt({ ...base, role: "coder" });
    expect(out).toContain("worktree");
  });

  it("tells a human to talk to Frigg, not to use a worktree", () => {
    const out = buildEnrollmentPrompt({ ...base, role: "human" });
    expect(out).toContain("Frigg");
    expect(out).not.toContain("worktree");
  });

  it("honors an explicit isWorker override", () => {
    const forcedWorker = buildEnrollmentPrompt({ ...base, role: "human", isWorker: true });
    expect(forcedWorker).toContain("worktree");
    const forcedHuman = buildEnrollmentPrompt({ ...base, role: "coder", isWorker: false });
    expect(forcedHuman).toContain("Frigg");
  });
});
