import { describe, expect, it, vi } from "vitest";
import { runSeatAdd, type SeatAddDeps } from "../src/commands/seat-add.js";
import type { RedeemedSeat } from "../src/api.js";
import type { HarnessWriter } from "../src/harness/index.js";

const claude: HarnessWriter = { id: "claude", bin: "claude", write: async () => undefined, locate: () => "" };

function seatFor(role: string): RedeemedSeat {
  return {
    key: "mzr_live_x",
    keyId: "k1",
    project: "proj-1",
    projectId: "proj-1",
    projectName: "Memracer",
    role,
    mcpUrl: "https://memracer.com/mcp",
  };
}

function deps(over: Partial<SeatAddDeps> = {}): {
  deps: SeatAddDeps;
  logs: string[];
  seatFolder: ReturnType<typeof vi.fn>;
  provision: ReturnType<typeof vi.fn>;
  mintEnrollment: ReturnType<typeof vi.fn>;
} {
  const logs: string[] = [];
  const seatFolder = vi.fn(async () => "/repo/.mcr/coder-42");
  const provision = vi.fn(async (a: { token: string }) => seatFor("coder"));
  const mintEnrollment = vi.fn(async () => ({ token: "minted-enroll-tok" }));
  return {
    logs,
    seatFolder,
    provision,
    mintEnrollment,
    deps: {
      detect: async () => [claude],
      seatFolder,
      provision,
      redeem: async () => seatFor("coder"),
      register: async () => {},
      credential: () => null,
      mintEnrollment,
      baseUrl: () => "https://memracer.com",
      cwd: () => "/repo",
      log: (m) => logs.push(m),
      ...over,
    },
  };
}

describe("runSeatAdd", () => {
  it("worker role gets an isolated worktree that provision uses as its folder", async () => {
    const { deps: d, seatFolder, provision, logs } = deps();
    await runSeatAdd({ role: "coder", token: "tok" }, d);
    expect(seatFolder).toHaveBeenCalledWith({ role: "coder", repo: "/repo", role_is_worker: true });
    expect(provision.mock.calls[0]![0]).toMatchObject({ folder: "/repo/.mcr/coder-42", token: "tok" });
    expect(logs.join("\n")).toContain("cd /repo/.mcr/coder-42 && claude");
  });

  it("human role provisions in the repo itself (non-worker)", async () => {
    const seatFolder = vi.fn(async () => "/repo");
    const provision = vi.fn(async (_a: { token: string }) => seatFor("human"));
    const { deps: d } = deps({ seatFolder, provision });
    await runSeatAdd({ role: "human", token: "tok" }, d);
    expect(seatFolder).toHaveBeenCalledWith({ role: "human", repo: "/repo", role_is_worker: false });
    expect(provision.mock.calls[0]![0]).toMatchObject({ folder: "/repo" });
  });

  it("mints its own enrollment (no --token) when logged in, using the credential's baseUrl", async () => {
    const { deps: d, mintEnrollment, provision } = deps({
      credential: () => ({ baseUrl: "https://mem.internal", token: "op_secret" }),
    });
    await runSeatAdd({ role: "coder", project: "acme" }, d);
    expect(mintEnrollment).toHaveBeenCalledWith("https://mem.internal", "op_secret", "acme", "coder");
    // the minted enrollment token flows into provision, against the credential's baseUrl
    expect(provision.mock.calls[0]![0]).toMatchObject({
      baseUrl: "https://mem.internal",
      token: "minted-enroll-tok",
    });
  });

  it("requires --project when logged in", async () => {
    const { deps: d } = deps({ credential: () => ({ baseUrl: "https://mem.internal", token: "op_secret" }) });
    await expect(runSeatAdd({ role: "coder" }, d)).rejects.toThrow(/--project/);
  });

  it("requires --token when logged out", async () => {
    const { deps: d } = deps();
    await expect(runSeatAdd({ role: "coder" }, d)).rejects.toThrow(/Not logged in/);
  });
});
