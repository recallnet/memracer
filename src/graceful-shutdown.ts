import type { Server } from "node:http";
import type { Db } from "./db.js";
import type { MediatorRuntime } from "./mediator/effect-runtime.js";
import type { MediatorWorker } from "./mediator/worker.js";

export interface GracefulShutdownOptions {
  readonly server: Pick<Server, "close" | "closeIdleConnections" | "closeAllConnections">;
  readonly worker: Pick<MediatorWorker, "stop" | "stopAndWait">;
  readonly runtime: Pick<MediatorRuntime, "dispose">;
  readonly db: Pick<Db, "close">;
  readonly timeoutMs?: number;
}

export interface ShutdownSignalTarget {
  once(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  exit(code: number): unknown;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function closeServerWithin(
  server: GracefulShutdownOptions["server"],
  deadline: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };

    timer = setTimeout(() => {
      try {
        // server.close waits for active HTTP responses indefinitely. Destroy
        // them at the shared shutdown deadline and settle even if Node never
        // follows with the close callback.
        server.closeAllConnections();
        settle();
      } catch (error) {
        settle(asError(error));
      }
    }, Math.max(0, deadline - Date.now()));

    try {
      server.close((error?: Error) => settle(error));
      // Call after close so a connection cannot become idle between the two
      // operations and escape the drain.
      server.closeIdleConnections();
    } catch (error) {
      settle(asError(error));
    }
  });
}

function runWithin(
  operation: () => Promise<void>,
  deadline: number,
  label: string,
): Promise<void> {
  let operationPromise: Promise<void>;
  try {
    operationPromise = operation();
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${label} did not settle before shutdown deadline`));
    }, Math.max(0, deadline - Date.now()));
    operationPromise.then(
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Build one idempotent shutdown sequence for both SIGINT and SIGTERM. */
export function makeGracefulShutdown(options: GracefulShutdownOptions): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => {
    if (pending) return pending;

    let resolvePending!: () => void;
    let rejectPending!: (error: unknown) => void;
    pending = new Promise<void>((resolve, reject) => {
      resolvePending = resolve;
      rejectPending = reject;
    });
    const run = async () => {
      const errors: unknown[] = [];
      const timeoutMs = Math.max(0, options.timeoutMs ?? 25_000);
      const deadline = Date.now() + timeoutMs;
      const cleanupReserveMs = Math.min(250, Math.floor(timeoutMs / 2));
      const drainDeadline = deadline - cleanupReserveMs;
      // Stop mediator claims synchronously before closing the HTTP edge. A
      // registered stop handler may throw; retain that first error but still
      // drive every bounded cleanup stage.
      try {
        options.worker.stop();
      } catch (error) {
        errors.push(error);
      }
      const serverClosed = closeServerWithin(options.server, drainDeadline);
      const workerStopped = runWithin(
        () => options.worker.stopAndWait(Math.max(0, drainDeadline - Date.now())),
        drainDeadline,
        "worker shutdown",
      );
      const drains = await Promise.allSettled([
        serverClosed,
        workerStopped,
      ]);
      for (const result of drains) {
        if (result.status === "rejected") errors.push(result.reason);
      }

      const runtimeDisposed = await Promise.allSettled([
        runWithin(() => options.runtime.dispose(), deadline, "runtime disposal"),
      ]);
      if (runtimeDisposed[0]?.status === "rejected") errors.push(runtimeDisposed[0].reason);
      const dbClosed = await Promise.allSettled([
        runWithin(() => options.db.close(), deadline, "database close"),
      ]);
      if (dbClosed[0]?.status === "rejected") errors.push(dbClosed[0].reason);
      if (errors.length > 0) throw errors[0];
    };
    void run().then(resolvePending, rejectPending);
    return pending;
  };
}

/** Install hard-exiting production signal handlers around a bounded shutdown. */
export function installShutdownSignalHandlers(
  shutdown: () => Promise<void>,
  target: ShutdownSignalTarget = process,
  logError: (prefix: string, message: string) => void = (prefix, message) => {
    console.error(prefix, message);
  },
): void {
  let handling = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    target.once(signal, () => {
      if (handling) return;
      handling = true;
      void Promise.resolve().then(shutdown).then(
        () => { target.exit(0); },
        (error) => {
          logError("[shutdown-failure]", asError(error).message);
          target.exit(1);
        },
      );
    });
  }
}
