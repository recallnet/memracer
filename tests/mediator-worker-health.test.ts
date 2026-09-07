// Error-surfacing suite for MediatorWorker (#82). The swallow-and-retry model
// is unchanged — these tests assert that a *persistently* failing sweep/drain
// tick becomes visible through status() and escalates once, while a transient
// one-off stays quiet.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db.js";
import { MediatorWorker, type EscalationSignal } from "../src/mediator/worker.js";
import { openTestDb } from "./helpers/db.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pollUntil(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() >= deadline) throw new Error("condition not met in time");
    await sleep(5);
  }
}

let active: MediatorWorker | undefined;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Silence + observe the rate-limited failure log.
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  active?.stop();
  active = undefined;
  errSpy.mockRestore();
});

describe("MediatorWorker status() defaults", () => {
  it("reports a healthy shape before any tick", async () => {
    const db = await openTestDb();
    const worker = new MediatorWorker(db);
    const s = worker.status();
    expect(s).toEqual({
      inFlight: 0,
      sweepErrors: { count: 0, lastMessage: null, lastAt: null, escalated: false },
      drainErrors: { count: 0, lastMessage: null, lastAt: null, escalated: false },
    });
  });
});

describe("MediatorWorker sweep error surfacing", () => {
  it("increments the consecutive-failure counter and surfaces it through status()", async () => {
    const db = await openTestDb();
    const worker = new MediatorWorker(db, { tickMs: 10, consecutiveErrorThreshold: 5 });
    active = worker;
    worker.registerSweep(async () => {
      throw new Error("sweep boom");
    });
    worker.start();
    await pollUntil(() => worker.status().sweepErrors.count >= 2);
    const s = worker.status().sweepErrors;
    expect(s.count).toBeGreaterThanOrEqual(2);
    expect(s.lastMessage).toBe("sweep boom");
    expect(typeof s.lastAt).toBe("number");
    expect(s.escalated).toBe(false); // below threshold
  });

  it("resets the streak to 0 on the next successful tick (transient stays quiet)", async () => {
    const db = await openTestDb();
    const worker = new MediatorWorker(db, { tickMs: 10, consecutiveErrorThreshold: 5 });
    active = worker;
    let fail = true;
    worker.registerSweep(async () => {
      if (fail) throw new Error("blip");
    });
    worker.start();
    await pollUntil(() => worker.status().sweepErrors.count >= 1);
    fail = false;
    await pollUntil(() => worker.status().sweepErrors.count === 0);
    expect(worker.status().sweepErrors.escalated).toBe(false);
  });

  it("escalates exactly once at the threshold: callback + event + status flag", async () => {
    const db = await openTestDb();
    const signals: EscalationSignal[] = [];
    const worker = new MediatorWorker(db, {
      tickMs: 10,
      consecutiveErrorThreshold: 3,
      onEscalation: (sig) => signals.push(sig),
    });
    active = worker;
    const events: EscalationSignal[] = [];
    worker.onEscalate((sig) => events.push(sig));
    worker.registerSweep(async () => {
      throw new Error("persistent");
    });
    worker.start();
    await pollUntil(() => worker.status().sweepErrors.escalated);
    // let several more failing ticks run to prove escalation does not re-fire
    await sleep(60);

    expect(worker.status().sweepErrors.escalated).toBe(true);
    expect(worker.status().sweepErrors.count).toBeGreaterThanOrEqual(3);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toEqual({ source: "sweep", message: "persistent", count: 3 });
    expect(events).toHaveLength(1);
    // Rate-limited log: once on the first failure, once on the threshold crossing.
    const sweepLogs = errSpy.mock.calls.filter((c) => String(c[0]).includes("sweep failing"));
    expect(sweepLogs).toHaveLength(2);
  });

  it("a changed error message restarts the streak", async () => {
    const db = await openTestDb();
    const worker = new MediatorWorker(db, { tickMs: 10, consecutiveErrorThreshold: 5 });
    active = worker;
    let message = "A";
    worker.registerSweep(async () => {
      throw new Error(message);
    });
    worker.start();
    await pollUntil(() => worker.status().sweepErrors.count >= 2);
    message = "B";
    await pollUntil(() => worker.status().sweepErrors.lastMessage === "B");
    const s = worker.status().sweepErrors;
    expect(s.lastMessage).toBe("B");
    // the streak restarted, so it is well below the earlier A-count
    expect(s.count).toBeLessThan(5);
    expect(s.escalated).toBe(false);
  });
});

describe("MediatorWorker drain error surfacing", () => {
  it("records a claim failure without downing the process", async () => {
    // A db whose transaction (the claim path) always rejects.
    const db = {
      transaction: async () => {
        throw new Error("db down");
      },
      prepare: () => ({
        get: async () => undefined,
        all: async () => [],
        run: async () => ({ changes: 0 }),
      }),
    } as unknown as Db;
    const worker = new MediatorWorker(db, { tickMs: 10, consecutiveErrorThreshold: 5 });
    active = worker;
    worker.start();
    await pollUntil(() => worker.status().drainErrors.count >= 1);
    const s = worker.status().drainErrors;
    expect(s.lastMessage).toBe("db down");
    expect(typeof s.lastAt).toBe("number");
  });
});
