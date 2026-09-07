import { Clock, Config, ConfigProvider, Data, Effect, Logger } from "effect";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { FakeDriver } from "../src/mediator/fake.js";
import {
  MediatorDatabase,
  makeMediatorRuntime,
  runEffectPromise,
} from "../src/mediator/effect-runtime.js";
import { createApp } from "../src/server.js";
import { betterAuthReady } from "./helpers/auth.js";

class BridgeFailure extends Data.TaggedError("BridgeFailure")<{
  readonly detail: string;
}> {}

describe("mediator Effect runtime", () => {
  it("builds one runtime from overridable DB, config, clock, and logging layers", async () => {
    const db = openDb(":memory:");
    const logged = vi.fn();
    const systemClock = Clock.make();
    const clock: Clock.Clock = {
      [Clock.ClockTypeId]: Clock.ClockTypeId,
      unsafeCurrentTimeMillis: () => 1_234,
      currentTimeMillis: Effect.succeed(1_234),
      unsafeCurrentTimeNanos: () => 1_234_000_000n,
      currentTimeNanos: Effect.succeed(1_234_000_000n),
      sleep: systemClock.sleep,
    };
    const runtime = makeMediatorRuntime({
      db,
      configProvider: ConfigProvider.fromMap(new Map([["runtime_mode", "test"]])),
      clock,
      logger: Logger.make(({ message }) => logged(message)),
    });

    try {
      const observed = await runEffectPromise(runtime, Effect.gen(function* () {
        const runtimeDb = yield* MediatorDatabase;
        const mode = yield* Config.string("runtime_mode");
        const now = yield* Clock.currentTimeMillis;
        yield* Effect.logInfo("runtime-layer-override");
        return { runtimeDb, mode, now };
      }));

      expect(observed).toEqual({ runtimeDb: db, mode: "test", now: 1_234 });
      expect(logged).toHaveBeenCalledWith(expect.arrayContaining(["runtime-layer-override"]));
    } finally {
      await runtime.dispose();
      await db.close();
    }
  });

  it("preserves a typed failure across the Promise bridge", async () => {
    const db = openDb(":memory:");
    const runtime = makeMediatorRuntime({ db });
    const failure = new BridgeFailure({ detail: "kept" });

    try {
      const rejected = await runEffectPromise(runtime, Effect.fail(failure)).catch((error: unknown) => error);
      expect(rejected).toBe(failure);
      expect(rejected).toMatchObject({ _tag: "BridgeFailure", detail: "kept" });
    } finally {
      await runtime.dispose();
      await db.close();
    }
  });

  it("passes an injected runtime unchanged from createApp to MediatorWorker", async () => {
    const db = openDb(":memory:");
    await betterAuthReady(db);
    const runtime = makeMediatorRuntime({ db });

    try {
      const made = createApp(db, {
        runtime,
        driverFor: () => new FakeDriver(),
      });
      expect(made.worker.runtime).toBe(runtime);
      made.worker.stop();
    } finally {
      await runtime.dispose();
      await db.close();
    }
  });

  it("disposes a worker-owned fallback runtime exactly once", async () => {
    const db = openDb(":memory:");
    const worker = new (await import("../src/mediator/worker.js")).MediatorWorker(db, { tickMs: 10_000 });
    const dispose = vi.spyOn(worker.runtime, "dispose");
    worker.start();
    await worker.stopAndWait(500);
    await worker.stopAndWait(500);
    expect(dispose).toHaveBeenCalledOnce();
    await db.close();
  });

  it("leaves an injected runtime for its caller to dispose", async () => {
    const db = openDb(":memory:");
    const runtime = makeMediatorRuntime({ db });
    const dispose = vi.spyOn(runtime, "dispose");
    const worker = new (await import("../src/mediator/worker.js")).MediatorWorker(db, {
      runtime,
      tickMs: 10_000,
    });
    worker.start();
    await worker.stopAndWait(500);
    expect(dispose).not.toHaveBeenCalled();
    await runtime.dispose();
    expect(dispose).toHaveBeenCalledOnce();
    await db.close();
  });
});
