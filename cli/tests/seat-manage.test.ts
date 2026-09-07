import { describe, expect, it, vi } from "vitest";
import { runSeatLs, runSeatRevoke, type SeatManageDeps } from "../src/commands/seat-manage.js";
import type { Seat } from "../src/api.js";
import type { Credential } from "../src/credentials.js";

const OP: Credential = { baseUrl: "https://mem.internal", token: "op_secret" };

function seat(over: Partial<Seat> = {}): Seat {
  return { id: "k1", name: "laptop", type: "human", createdAt: 1, lastUsedAt: 2, ...over };
}

function deps(over: Partial<SeatManageDeps> = {}): {
  deps: SeatManageDeps;
  logs: string[];
  listSeats: ReturnType<typeof vi.fn>;
  revokeSeat: ReturnType<typeof vi.fn>;
} {
  const logs: string[] = [];
  const listSeats = vi.fn(async () => [seat()]);
  const revokeSeat = vi.fn(async () => undefined);
  return {
    logs,
    listSeats,
    revokeSeat,
    deps: {
      credential: () => OP,
      listSeats,
      revokeSeat,
      log: (m) => logs.push(m),
      ...over,
    },
  };
}

describe("runSeatLs", () => {
  it("lists the operator's seats as a table, calling listSeats with the credential", async () => {
    const { deps: d, logs } = deps();
    d.listSeats = vi.fn(async () => [
      seat({ id: "k1", name: "laptop", type: "human" }),
      seat({ id: "k2", name: "fleet", type: "coder" }),
    ]);
    await runSeatLs({ project: "acme" }, d);
    expect(d.listSeats).toHaveBeenCalledWith("https://mem.internal", "op_secret", "acme");
    const out = logs.join("\n");
    expect(out).toContain("k1");
    expect(out).toContain("laptop");
    expect(out).toContain("k2");
    expect(out).toContain("coder");
  });

  it("requires a stored credential, else errors with a login hint", async () => {
    const { deps: d } = deps({ credential: () => null });
    await expect(runSeatLs({ project: "acme" }, d)).rejects.toThrow(/memracer login/);
  });

  it("requires --project", async () => {
    const { deps: d } = deps();
    await expect(runSeatLs({}, d)).rejects.toThrow(/--project/);
  });
});

describe("runSeatRevoke", () => {
  it("resolves a seat NAME to its id and revokes it", async () => {
    const { deps: d, revokeSeat, logs } = deps({
      listSeats: vi.fn(async () => [seat({ id: "k9", name: "old-laptop" })]),
    });
    await runSeatRevoke({ seat: "old-laptop", project: "acme" }, d);
    expect(revokeSeat).toHaveBeenCalledWith("https://mem.internal", "op_secret", "acme", "k9");
    expect(logs.join("\n")).toContain("revoked old-laptop (k9)");
  });

  it("accepts a seat id directly", async () => {
    const { deps: d, revokeSeat } = deps({
      listSeats: vi.fn(async () => [seat({ id: "k9", name: "old-laptop" })]),
    });
    await runSeatRevoke({ seat: "k9", project: "acme" }, d);
    expect(revokeSeat).toHaveBeenCalledWith("https://mem.internal", "op_secret", "acme", "k9");
  });

  it("refuses an ambiguous NAME that matches multiple seats — asks for the id", async () => {
    const { deps: d, revokeSeat } = deps({
      listSeats: vi.fn(async () => [seat({ id: "k1", name: "dup" }), seat({ id: "k2", name: "dup" })]),
    });
    await expect(runSeatRevoke({ seat: "dup", project: "acme" }, d)).rejects.toThrow(/id/i);
    expect(revokeSeat).not.toHaveBeenCalled();
  });

  it("errors when no seat matches", async () => {
    const { deps: d } = deps({ listSeats: vi.fn(async () => [seat({ id: "k1", name: "laptop" })]) });
    await expect(runSeatRevoke({ seat: "ghost", project: "acme" }, d)).rejects.toThrow(/no seat/i);
  });

  it("requires a stored credential, else errors with a login hint", async () => {
    const { deps: d } = deps({ credential: () => null });
    await expect(runSeatRevoke({ seat: "x", project: "acme" }, d)).rejects.toThrow(/memracer login/);
  });

  it("requires --project", async () => {
    const { deps: d } = deps();
    await expect(runSeatRevoke({ seat: "x" }, d)).rejects.toThrow(/--project/);
  });
});
