import { describe, expect, it, vi } from "vitest";
import { runWait, parseAvailable, type Wake, type WaitContext, type WaitDeps } from "../src/commands/wait.js";

const CTX: WaitContext = { baseUrl: "https://memracer.com", token: "tok", project: "memracer", role: "coder" };

/**
 * Wire runWait deps around a scripted depth sequence (for the initial check and
 * any HTTP re-checks) and a scripted `awaitChange` that yields Wake values and
 * advances a fake clock (so --timeout is testable) while recording its args.
 */
function deps(opts: {
  depths?: number[];
  wakes?: Wake[];
  context?: WaitContext | null;
  stepMs?: number;
}) {
  let t = 0;
  const depths = [...(opts.depths ?? [])];
  const wakes = [...(opts.wakes ?? [])];
  const stepMs = opts.stepMs ?? 1_000;
  const context = opts.context === undefined ? CTX : opts.context;
  const logs: string[] = [];
  const awaitCalls: Array<{ url: string; token: string; maxWaitMs: number }> = [];
  const queueDepth = vi.fn(async () => (depths.length > 1 ? depths.shift()! : depths[0] ?? 0));
  const awaitChange = vi.fn(async (url: string, token: string, maxWaitMs: number): Promise<Wake> => {
    awaitCalls.push({ url, token, maxWaitMs });
    t += stepMs;
    return wakes.length > 0 ? wakes.shift()! : "recheck";
  });
  const d: WaitDeps = {
    context: () => context,
    queueDepth: queueDepth as unknown as WaitDeps["queueDepth"],
    awaitChange: awaitChange as unknown as WaitDeps["awaitChange"],
    now: () => t,
    log: (m) => logs.push(m),
  };
  return { d, logs, queueDepth, awaitChange, awaitCalls };
}

describe("runWait (push)", () => {
  it("exits 0 immediately when work is already queued, never subscribing", async () => {
    const { d, logs, awaitChange } = deps({ depths: [5] });
    expect(await runWait({}, d)).toBe(0);
    expect(logs).toContain("work available: 5");
    expect(awaitChange).not.toHaveBeenCalled();
  });

  it("exits 0 on a pushed queue count without any follow-up depth request", async () => {
    const { d, logs, queueDepth, awaitChange } = deps({ depths: [0], wakes: [{ available: 3 }] });
    expect(await runWait({}, d)).toBe(0);
    expect(logs).toContain("work available: 3");
    expect(awaitChange).toHaveBeenCalledTimes(1);
    expect(queueDepth).toHaveBeenCalledTimes(1); // only the initial catch-up check
  });

  it("keeps waiting on a pushed zero, then exits when a later push brings work", async () => {
    const { d, logs, awaitChange } = deps({ depths: [0], wakes: [{ available: 0 }, { available: 2 }] });
    expect(await runWait({}, d)).toBe(0);
    expect(logs).toContain("work available: 2");
    expect(awaitChange).toHaveBeenCalledTimes(2);
  });

  it("falls back to an HTTP re-check when the server only says 'recheck'", async () => {
    const { d, logs, queueDepth } = deps({ depths: [0, 0, 4], wakes: ["recheck", "recheck"] });
    expect(await runWait({}, d)).toBe(0);
    expect(logs).toContain("work available: 4");
    expect(queueDepth).toHaveBeenCalledTimes(3); // initial + two re-checks
  });

  it("subscribes to the project events URL with role, token and a wait cap", async () => {
    const { d, awaitCalls } = deps({ depths: [0], wakes: [{ available: 1 }] });
    await runWait({}, d);
    expect(awaitCalls[0]!.url).toBe("https://memracer.com/api/p/memracer/events?role=coder");
    expect(awaitCalls[0]!.token).toBe("tok");
    expect(awaitCalls[0]!.maxWaitMs).toBeGreaterThan(0);
  });

  it("--timeout gives up non-zero when no push brings work in the window", async () => {
    const { d, logs } = deps({ depths: [0], wakes: [{ available: 0 }], stepMs: 10_000 });
    expect(await runWait({ timeout: 25 }, d)).toBe(1);
    expect(logs).toContain("no work within 25s");
  });

  it("passes the remaining time to the deadline as the wait cap", async () => {
    const { d, awaitCalls } = deps({ depths: [0], wakes: [{ available: 0 }, { available: 0 }, { available: 0 }], stepMs: 10_000 });
    await runWait({ timeout: 100 }, d);
    expect(awaitCalls[0]!.maxWaitMs).toBe(100_000);
    expect(awaitCalls[1]!.maxWaitMs).toBe(90_000);
  });

  it("--once checks once: 0 with work, non-zero without, never subscribing", async () => {
    const hit = deps({ depths: [2] });
    expect(await runWait({ once: true }, hit.d)).toBe(0);
    expect(hit.awaitChange).not.toHaveBeenCalled();
    expect(hit.logs).toContain("work available: 2");

    const miss = deps({ depths: [0] });
    expect(await runWait({ once: true }, miss.d)).toBe(1);
    expect(miss.awaitChange).not.toHaveBeenCalled();
  });

  it("overrides context project/role with explicit opts", async () => {
    const { d, queueDepth, awaitCalls } = deps({ depths: [0], wakes: [{ available: 1 }] });
    await runWait({ project: "other", role: "human" }, d);
    expect(queueDepth).toHaveBeenCalledWith("https://memracer.com", "tok", "other", "human");
    expect(awaitCalls[0]!.url).toBe("https://memracer.com/api/p/other/events?role=human");
  });

  it("errors when there is no credential or seat env", async () => {
    const { d } = deps({ depths: [1], context: null });
    await expect(runWait({}, d)).rejects.toThrow(/login|seat/i);
  });

  it("errors when no project can be resolved", async () => {
    const { d } = deps({ depths: [1], context: { baseUrl: "https://memracer.com", token: "tok" } });
    await expect(runWait({}, d)).rejects.toThrow(/project/i);
  });
});

describe("parseAvailable", () => {
  it("reads the available count and defaults to 0 on junk", () => {
    expect(parseAvailable('{"role":"coder","available":7}')).toBe(7);
    expect(parseAvailable('{"role":"coder"}')).toBe(0);
    expect(parseAvailable("not json")).toBe(0);
  });
});
