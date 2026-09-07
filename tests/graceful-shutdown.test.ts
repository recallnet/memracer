import { createServer, get } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  installShutdownSignalHandlers,
  makeGracefulShutdown,
} from "../src/graceful-shutdown.js";

describe("graceful shutdown", () => {
  it("stops the worker before disposing the app-owned runtime and closes each resource once", async () => {
    const order: string[] = [];
    let closeCallback: ((error?: Error) => void) | undefined;
    const closeAllConnections = vi.fn();
    const stopAndWait = vi.fn(async (_timeoutMs?: number) => {
      order.push("worker.stopAndWait");
    });
    const shutdown = makeGracefulShutdown({
      server: {
        close: vi.fn((callback?: (error?: Error) => void) => {
          order.push("server.close");
          closeCallback = callback;
          return {} as never;
        }),
        closeIdleConnections: vi.fn(() => { order.push("server.closeIdleConnections"); }),
        closeAllConnections,
      },
      worker: {
        stop: vi.fn(() => { order.push("worker.stop"); }),
        stopAndWait,
      },
      runtime: {
        dispose: vi.fn(async () => { order.push("runtime.dispose"); }),
      },
      db: {
        close: vi.fn(async () => { order.push("db.close"); }),
      },
      timeoutMs: 5,
    });

    const first = shutdown();
    const second = shutdown();
    expect(second).toBe(first);
    expect(order).toEqual([
      "worker.stop",
      "server.close",
      "server.closeIdleConnections",
      "worker.stopAndWait",
    ]);
    closeCallback?.();
    await first;
    await new Promise((resolve) => setTimeout(resolve, 15));

    expect(order).toEqual([
      "worker.stop",
      "server.close",
      "server.closeIdleConnections",
      "worker.stopAndWait",
      "runtime.dispose",
      "db.close",
    ]);
    expect(closeAllConnections).not.toHaveBeenCalled();
    const workerBudget = stopAndWait.mock.calls[0]?.[0];
    expect(workerBudget).toBeTypeOf("number");
    expect(workerBudget).toBeGreaterThanOrEqual(0);
    expect(workerBudget).toBeLessThanOrEqual(5);
  });

  it("still disposes the runtime and database after a forced worker stop reports failure", async () => {
    const disposed = vi.fn(async () => undefined);
    const closed = vi.fn(async () => undefined);
    const shutdown = makeGracefulShutdown({
      server: {
        close: (callback?: (error?: Error) => void) => { callback?.(); return {} as never; },
        closeIdleConnections: () => undefined,
        closeAllConnections: () => undefined,
      },
      worker: {
        stop: () => undefined,
        stopAndWait: async () => { throw new Error("forced interruption"); },
      },
      runtime: { dispose: disposed },
      db: { close: closed },
    });

    await expect(shutdown()).rejects.toThrow("forced interruption");
    expect(disposed).toHaveBeenCalledOnce();
    expect(closed).toHaveBeenCalledOnce();
  });

  it("publishes one rejected shutdown promise before a synchronous stop-handler failure", async () => {
    const order: string[] = [];
    const shutdown = makeGracefulShutdown({
      server: {
        close: (callback?: (error?: Error) => void) => { callback?.(); return {} as never; },
        closeIdleConnections: () => undefined,
        closeAllConnections: () => undefined,
      },
      worker: {
        stop: () => { order.push("worker.stop"); throw new Error("stop handler failed"); },
        stopAndWait: async () => { order.push("worker.stopAndWait"); },
      },
      runtime: { dispose: async () => { order.push("runtime.dispose"); } },
      db: { close: async () => { order.push("db.close"); } },
    });

    const first = shutdown();
    const second = shutdown();
    expect(second).toBe(first);
    await expect(first).rejects.toThrow("stop handler failed");
    expect(order).toEqual([
      "worker.stop",
      "worker.stopAndWait",
      "runtime.dispose",
      "db.close",
    ]);
  });

  it("preserves an ordinary HTTP close error while still cleaning up", async () => {
    const disposed = vi.fn(async () => undefined);
    const closed = vi.fn(async () => undefined);
    const shutdown = makeGracefulShutdown({
      server: {
        close: (callback?: (error?: Error) => void) => {
          callback?.(new Error("http close failed"));
          return {} as never;
        },
        closeIdleConnections: () => undefined,
        closeAllConnections: () => undefined,
      },
      worker: { stop: () => undefined, stopAndWait: async () => undefined },
      runtime: { dispose: disposed },
      db: { close: closed },
    });

    await expect(shutdown()).rejects.toThrow("http close failed");
    expect(disposed).toHaveBeenCalledOnce();
    expect(closed).toHaveBeenCalledOnce();
  });

  it("reports a force-close error after the deadline without skipping cleanup", async () => {
    const disposed = vi.fn(async () => undefined);
    const closed = vi.fn(async () => undefined);
    const shutdown = makeGracefulShutdown({
      server: {
        close: () => ({} as never),
        closeIdleConnections: () => undefined,
        closeAllConnections: () => { throw new Error("force close failed"); },
      },
      worker: { stop: () => undefined, stopAndWait: async () => undefined },
      runtime: { dispose: disposed },
      db: { close: closed },
      timeoutMs: 0,
    });

    await expect(shutdown()).rejects.toThrow("force close failed");
    expect(disposed).toHaveBeenCalledOnce();
    expect(closed).toHaveBeenCalledOnce();
  });

  it("force-closes an active SSE response before runtime and database disposal", async () => {
    let responseOpened!: () => void;
    let responseFailed!: (error: Error) => void;
    const opened = new Promise<void>((resolve, reject) => {
      responseOpened = resolve;
      responseFailed = reject;
    });
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": connected\n\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no TCP port");
    const request = get({ host: "127.0.0.1", port: address.port }, (response) => {
      response.once("data", responseOpened);
      response.resume();
    });
    request.once("error", responseFailed);
    await opened;

    const order: string[] = [];
    const forceAllConnections = server.closeAllConnections.bind(server);
    const forced = vi.spyOn(server, "closeAllConnections").mockImplementation(() => {
      order.push("server.force");
      forceAllConnections();
    });
    const shutdown = makeGracefulShutdown({
      server,
      worker: {
        stop: () => { order.push("worker.stop"); },
        stopAndWait: async () => { order.push("worker.stopAndWait"); },
      },
      runtime: { dispose: async () => { order.push("runtime.dispose"); } },
      db: { close: async () => { order.push("db.close"); } },
      timeoutMs: 25,
    });

    try {
      await shutdown();
      expect(forced).toHaveBeenCalledOnce();
      expect(order).toEqual([
        "worker.stop",
        "worker.stopAndWait",
        "server.force",
        "runtime.dispose",
        "db.close",
      ]);
    } finally {
      request.destroy();
      server.closeAllConnections();
    }
  });

  it("bounds never-settling worker, runtime, and database cleanup by one deadline", async () => {
    const order: string[] = [];
    const never = () => new Promise<void>(() => undefined);
    const shutdown = makeGracefulShutdown({
      server: {
        close: (callback?: (error?: Error) => void) => { callback?.(); return {} as never; },
        closeIdleConnections: () => undefined,
        closeAllConnections: () => undefined,
      },
      worker: {
        stop: () => { order.push("worker.stop"); },
        stopAndWait: () => { order.push("worker.stopAndWait"); return never(); },
      },
      runtime: { dispose: () => { order.push("runtime.dispose"); return never(); } },
      db: { close: () => { order.push("db.close"); return never(); } },
      timeoutMs: 20,
    });

    const outcome = await Promise.race([
      shutdown().then(
        () => "resolved" as const,
        (error: unknown) => error,
      ),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 250)),
    ]);

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe("worker shutdown did not settle before shutdown deadline");
    expect(order).toEqual([
      "worker.stop",
      "worker.stopAndWait",
      "runtime.dispose",
      "db.close",
    ]);
  });

  it("hard-exits after a signal shutdown result and logs failures before exit", async () => {
    const listeners = new Map<string, () => void>();
    const events: string[] = [];
    const target = {
      once: (signal: "SIGINT" | "SIGTERM", listener: () => void) => {
        listeners.set(signal, listener);
      },
      exit: (code: number) => { events.push(`exit:${code}`); },
    };
    installShutdownSignalHandlers(
      () => { throw new Error("cleanup timed out"); },
      target,
      (prefix, message) => { events.push(`${prefix}:${message}`); },
    );

    listeners.get("SIGTERM")?.();
    listeners.get("SIGINT")?.();
    await vi.waitUntil(() => events.length === 2, { timeout: 250 });
    expect(events).toEqual([
      "[shutdown-failure]:cleanup timed out",
      "exit:1",
    ]);

    events.length = 0;
    const successListeners = new Map<string, () => void>();
    let finishShutdown!: () => void;
    const shutdownGate = new Promise<void>((resolve) => { finishShutdown = resolve; });
    const shutdownCalls = vi.fn(() => shutdownGate);
    installShutdownSignalHandlers(
      shutdownCalls,
      {
        once: (signal, listener) => { successListeners.set(signal, listener); },
        exit: (code) => { events.push(`exit:${code}`); },
      },
    );
    successListeners.get("SIGINT")?.();
    successListeners.get("SIGTERM")?.();
    await vi.waitUntil(() => shutdownCalls.mock.calls.length === 1, { timeout: 250 });
    expect(events).toEqual([]);
    finishShutdown();
    await vi.waitUntil(() => events.length === 1, { timeout: 250 });
    expect(events).toEqual(["exit:0"]);
    expect(shutdownCalls).toHaveBeenCalledOnce();
  });
});
