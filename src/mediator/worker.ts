import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { Effect, Either, Exit, Fiber, FiberId, FiberSet, Queue as EffectQueue } from "effect";
import type { Scope } from "effect";
import type { Db, SqlValue } from "../db.js";
import { makeMediatorRuntime, type MediatorRuntime } from "./effect-runtime.js";
import { JobPolicyLog } from "./job-policy-log.js";

export interface JobRow {
  id: number;
  project_id: string;
  kind: string;
  payload: string;
  status: "pending" | "running" | "done" | "failed";
  attempts: number;
  result: string | null;
  error: string | null;
  started_at: number | null;
}

export type JobHandler = (payload: unknown, job: JobRow) => Promise<unknown>;

const MAX_ATTEMPTS = 2;
const RAW_OUTPUT_LOG_LIMIT = 2048;
const TERMINAL_DRIVER_ERROR_TAGS = new Set(["OpenRouterPermanentError", "OpenRouterRetriesExhaustedError"]);

function boundedUtf8(input: string, maxBytes: number): string {
  let bytes = 0;
  let output = "";
  for (const char of input) {
    const size = Buffer.byteLength(char);
    if (bytes + size > maxBytes) break;
    output += char;
    bytes += size;
  }
  return output;
}

function failureLog(job: Pick<JobRow, "id" | "kind" | "attempts">, err: unknown): string {
  const details = err && typeof err === "object" ? err as { model?: unknown; rawOutput?: unknown } : {};
  const raw = typeof details.rawOutput === "string" ? boundedUtf8(details.rawOutput, RAW_OUTPUT_LOG_LIMIT) : undefined;
  return `[mediator-job-failure] ${JSON.stringify({
    job_id: job.id,
    kind: job.kind,
    attempts: job.attempts,
    model: typeof details.model === "string" ? details.model : "unknown",
    error: err instanceof Error ? err.message : String(err),
    ...(raw !== undefined ? { raw_output: raw } : {}),
  })}`;
}

/** Consecutive same-message failures before a sweep/drain source escalates. */
export const DEFAULT_CONSECUTIVE_ERROR_THRESHOLD = 5;

/** The two periodic sources whose persistent failures we surface. */
export type ErrorSource = "sweep" | "drain";

/** Per-source health, surfaced through status() and the dashboard. */
export interface SourceErrors {
  /** Consecutive same-message failures; 0 means healthy. */
  count: number;
  /** The most recent error message, or null when none has occurred. */
  lastMessage: string | null;
  /** Epoch ms of the most recent failure, or null. */
  lastAt: number | null;
  /** True once count reached the threshold — active, human-visible degradation. */
  escalated: boolean;
}

export interface WorkerStatus {
  inFlight: number;
  sweepErrors: SourceErrors;
  drainErrors: SourceErrors;
}

/** An escalation crossing the consecutive-failure threshold. */
export interface EscalationSignal {
  source: ErrorSource;
  message: string;
  count: number;
}

export class MediatorWorker {
  readonly runtime: MediatorRuntime;
  private readonly ownsRuntime: boolean;
  private readonly events = new EventEmitter();
  private readonly handlers = new Map<string, JobHandler>();
  private readonly sweeps: Array<() => Promise<void>> = [];
  private readonly stopHandlers = new Set<() => void>();
  private readonly tickMs: number;
  private readonly jobTimeoutMs: number;
  private readonly concurrency: number;
  private rootFiber: ReturnType<MediatorRuntime["runFork"]> | undefined;
  private rootCompletion: Promise<void> | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private shutdownDeadline: number | undefined;
  private shutdownDeadlineTimer: NodeJS.Timeout | undefined;
  private readonly shutdownDeadlineController = new AbortController();
  private workSignals: EffectQueue.Queue<void> | undefined;
  private slotSignals: EffectQueue.Queue<void> | undefined;
  private stopSignals: EffectQueue.Queue<void> | undefined;
  private executingFibers: FiberSet.FiberSet<void, never> | undefined;
  private stopped = false;
  private readonly errorThreshold: number;
  private readonly onEscalation?: (signal: EscalationSignal) => void;
  private readonly sourceErrors: Record<ErrorSource, SourceErrors> = {
    sweep: { count: 0, lastMessage: null, lastAt: null, escalated: false },
    drain: { count: 0, lastMessage: null, lastAt: null, escalated: false },
  };
  private readonly jobPolicyLog: JobPolicyLog;

  constructor(
    private readonly db: Db,
    opts?: {
      tickMs?: number;
      jobTimeoutMs?: number;
      concurrency?: number;
      /** Consecutive same-message failures before a source escalates (default 5). */
      consecutiveErrorThreshold?: number;
      /** Invoked once per source when it crosses the escalation threshold. */
      onEscalation?: (signal: EscalationSignal) => void;
      /** Shared app-owned Effect runtime. */
      runtime?: MediatorRuntime;
      /** The worker disposes this runtime after its structured scope stops. */
      ownsRuntime?: boolean;
    },
  ) {
    this.jobPolicyLog = new JobPolicyLog(db);
    this.runtime = opts?.runtime ?? makeMediatorRuntime({ db });
    this.ownsRuntime = opts?.ownsRuntime ?? opts?.runtime === undefined;
    this.events.setMaxListeners(0);
    this.tickMs = opts?.tickMs ?? 500;
    // Outer safety valve for a genuinely wedged pipeline. Each OpenRouter
    // retry/backoff operation has its own 180s Effect timeout; this wider bound
    // covers the complete handler and remains host-tunable through main.ts.
    this.jobTimeoutMs = opts?.jobTimeoutMs ?? 300_000;
    this.concurrency = opts?.concurrency ?? 3;
    this.errorThreshold = opts?.consecutiveErrorThreshold ?? DEFAULT_CONSECUTIVE_ERROR_THRESHOLD;
    this.onEscalation = opts?.onEscalation;
  }

  /**
   * Subscribe to escalation crossings (a source hitting the consecutive-failure
   * threshold). The same signal is delivered to the onEscalation constructor
   * callback; the event is for additional listeners (tests, future wiring).
   */
  onEscalate(listener: (signal: EscalationSignal) => void): void {
    this.events.on("escalation", listener);
  }

  /**
   * A per-tick source failure. The swallow-and-retry model is unchanged — this
   * only records a signal so a *persistently* failing source becomes visible.
   * Same-message failures accumulate a consecutive streak; a new message starts
   * a fresh streak. Logging is rate-limited to the first failure and the
   * threshold crossing so a wedged source cannot spam the log every tick.
   */
  private recordError(source: ErrorSource, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    const s = this.sourceErrors[source];
    s.count = s.lastMessage === message ? s.count + 1 : 1;
    s.lastMessage = message;
    s.lastAt = Date.now();
    if (s.count === 1 || s.count === this.errorThreshold) {
      console.error(`[worker] ${source} failing (x${s.count}): ${message}`);
    }
    if (s.count >= this.errorThreshold && !s.escalated) {
      s.escalated = true;
      const signal: EscalationSignal = { source, message, count: s.count };
      this.events.emit("escalation", signal);
      this.onEscalation?.(signal);
    }
  }

  /** A successful tick clears the source's streak (transient errors stay quiet). */
  private recordSuccess(source: ErrorSource): void {
    const s = this.sourceErrors[source];
    if (s.count === 0 && !s.escalated) return;
    s.count = 0;
    s.escalated = false;
  }

  /** Orchestrator health for the dashboard/human_status surface. */
  status(): WorkerStatus {
    return {
      inFlight: this.executingFibers ? Array.from(this.executingFibers).length : 0,
      sweepErrors: { ...this.sourceErrors.sweep },
      drainErrors: { ...this.sourceErrors.drain },
    };
  }

  register(kind: string, handler: JobHandler): void {
    this.handlers.set(kind, handler);
  }

  /**
   * Register a periodic sweep run on every tick (alongside job draining) and
   * cleared by stop(). Used for clock-driven work that no enqueue can trigger
   * — e.g. graduating a warming task when its incubation clock strikes (#61).
   * Errors are swallowed per-tick: a transient failure must not take the
   * process down; the next tick retries.
   */
  registerSweep(fn: () => Promise<void>): void {
    this.sweeps.push(fn);
  }

  /** Register process-local resources that must begin closing with the worker. */
  onStop(handler: () => void): void {
    this.stopHandlers.add(handler);
  }

  private runSweepsEffect(): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      let failure: unknown;
      for (const sweep of this.sweeps) {
        const result = yield* Effect.either(Effect.tryPromise({
          try: () => sweep(),
          catch: (error) => error,
        }));
        if (Either.isLeft(result)) failure = result.left;
      }
      if (failure !== undefined) this.recordError("sweep", failure);
      else if (this.sweeps.length > 0) this.recordSuccess("sweep");
    });
  }

  private signalWork(): void {
    this.workSignals?.unsafeOffer(undefined);
  }

  private wakeWorker(): void {
    if (!this.rootFiber && !this.shutdownPromise) this.start();
    this.signalWork();
  }

  async enqueue(projectId: string, kind: string, payload: unknown): Promise<number> {
    const now = Date.now();
    const inserted = await this.db
      .prepare(
        "INSERT INTO jobs (project_id, kind, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING id",
      )
      .get<{ id: number }>(projectId, kind, JSON.stringify(payload), now, now);
    this.wakeWorker();
    return inserted!.id;
  }

  /**
   * Reuse an identical in-flight job instead of enqueuing a duplicate: a
   * caller retrying the same tool call while the mediator is still working
   * gets the original job's result. Equality is the payload's JSON string.
   */
  async findOrEnqueue(projectId: string, kind: string, payload: unknown): Promise<number> {
    const serialized = JSON.stringify(payload);
    // Rows created before atomic coalescing have no key. Reuse one when it is
    // already in flight, but never create another NULL-keyed row here.
    const legacy = await this.db
      .prepare(
        `SELECT id FROM jobs
          WHERE project_id=? AND kind=? AND payload=? AND coalesce_key IS NULL
            AND status IN ('pending','running') ORDER BY id ASC LIMIT 1`,
      )
      .get<{ id: number }>(projectId, kind, serialized);
    if (legacy) return legacy.id;

    const coalesceKey = createHash("sha256").update(serialized).digest("hex");
    const now = Date.now();
    const inserted = await this.db
      .prepare(
        `INSERT INTO jobs (project_id, kind, payload, created_at, updated_at, coalesce_key)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING id`,
      )
      .get<{ id: number }>(projectId, kind, serialized, now, now, coalesceKey);
    const winner = inserted ?? await this.db
      .prepare(
        `SELECT id FROM jobs WHERE project_id=? AND kind=? AND coalesce_key=?
          ORDER BY id DESC LIMIT 1`,
      )
      .get<{ id: number }>(projectId, kind, coalesceKey);
    if (!winner) throw new Error("coalesced job insert lost its durable winner");
    this.wakeWorker();
    return winner.id;
  }

  async getJob(id: number): Promise<JobRow> {
    return (await this.db.prepare("SELECT * FROM jobs WHERE id = ?").get<JobRow>(id)) as JobRow;
  }

  async findLatestJob(projectId: string, kind: string, payload: unknown): Promise<JobRow | null> {
    return (await this.db
      .prepare(
        "SELECT * FROM jobs WHERE project_id=? AND kind=? AND payload=? ORDER BY id DESC LIMIT 1",
      )
      .get<JobRow>(projectId, kind, JSON.stringify(payload))) ?? null;
  }

  async waitForJob(id: number, timeoutMs: number): Promise<JobRow> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const job = await this.getJob(id);
      if (job.status === "done" || job.status === "failed") return job;
      if (Date.now() >= deadline) return job;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, Math.min(200, Math.max(1, deadline - Date.now())));
        const events = this.events;
        function done() {
          clearTimeout(timer);
          events.removeListener(`job:${id}`, done);
          resolve();
        }
        events.once(`job:${id}`, done);
      });
    }
  }

  start(): void {
    if (this.rootFiber && this.rootFiber.unsafePoll() === null) return;
    if (this.shutdownPromise) throw new Error("mediator worker cannot restart after shutdown");
    this.stopped = false;
    const fiber = this.runtime.runFork(Effect.scoped(this.supervise()));
    this.rootFiber = fiber;
    this.rootCompletion = new Promise<void>((resolve) => {
      fiber.addObserver(() => {
        if (this.rootFiber === fiber) this.rootFiber = undefined;
        resolve();
      });
    });
  }

  /** Stops claiming new jobs. In-flight handler invocations run to completion. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.signalWork();
    this.slotSignals?.unsafeOffer(undefined);
    this.stopSignals?.unsafeOffer(undefined);
    for (const handler of this.stopHandlers) handler();
    if (!this.shutdownPromise) {
      const completion = this.rootCompletion ?? Promise.resolve();
      this.shutdownPromise = completion.then(async () => {
        if (this.ownsRuntime) await this.runtime.dispose();
      });
    }
  }

  /** Stop new claims/ticks and wait for active claims, handlers, and sweeps to settle. */
  async stopAndWait(timeoutMs = 2_000): Promise<void> {
    const boundedTimeoutMs = Math.max(0, timeoutMs);
    const deadline = Date.now() + boundedTimeoutMs;
    const cleanupReserveMs = Math.min(250, Math.floor(boundedTimeoutMs / 2));
    const fiber = this.rootFiber;
    const completion = this.rootCompletion ?? Promise.resolve();
    this.armShutdownDeadline(deadline);
    this.stop();
    const settled = await this.waitWithin(
      completion,
      Math.max(0, deadline - Date.now() - cleanupReserveMs),
    );
    let completed = settled;
    if (!settled && fiber) {
      fiber.unsafeInterruptAsFork(FiberId.none);
      completed = await this.waitWithin(completion, Math.max(0, deadline - Date.now()));
    }
    const shutdownSettled = await this.waitWithin(
      this.shutdownPromise ?? Promise.resolve(),
      Math.max(0, deadline - Date.now()),
    );
    if (!settled || !completed || !shutdownSettled) {
      throw new Error("mediator worker did not become idle before shutdown timeout");
    }
    if (this.shutdownDeadlineTimer) {
      clearTimeout(this.shutdownDeadlineTimer);
      this.shutdownDeadlineTimer = undefined;
    }
  }

  private armShutdownDeadline(deadline: number): void {
    const armedDeadline = Math.min(this.shutdownDeadline ?? deadline, deadline);
    this.shutdownDeadline = armedDeadline;
    if (this.shutdownDeadlineTimer) clearTimeout(this.shutdownDeadlineTimer);
    const abort = () => {
      this.shutdownDeadlineTimer = undefined;
      this.shutdownDeadlineController.abort();
    };
    const delay = armedDeadline - Date.now();
    if (delay <= 0) abort();
    else this.shutdownDeadlineTimer = setTimeout(abort, delay);
  }

  private waitWithin(completion: Promise<void>, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(false);
      }, Math.max(0, timeoutMs));
      completion.then(
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(true);
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

  /** Claim the next runnable job: requeue stuck ones first (lazy watchdog), then take oldest pending. */
  private async claim(): Promise<JobRow | null> {
    return this.db.transaction(async (): Promise<JobRow | null> => {
      const now = Date.now();
      const stuckCutoff = now - this.jobTimeoutMs * 2;
      const stuck = await this.db
        .prepare("SELECT id, kind, attempts, started_at FROM jobs WHERE status = 'running' AND started_at < ?")
        .all<{ id: number; kind: string; attempts: number; started_at: number }>(stuckCutoff);
      for (const s of stuck) {
        if (s.attempts >= MAX_ATTEMPTS) {
          const failed = await this.db
            .prepare(
              `UPDATE jobs SET status='failed', error='timed out', updated_at=?
               WHERE id=? AND status='running' AND attempts=? AND started_at=?`,
            )
            .run(now, s.id, s.attempts, s.started_at);
          if (failed.changes > 0) {
            await this.jobPolicyLog.markAttemptOutcome(s.id, s.attempts, "fail", now);
            console.error(failureLog(s, new Error("timed out")));
            this.events.emit(`job:${s.id}`);
          }
        } else {
          const requeued = await this.db
            .prepare(
              `UPDATE jobs SET status='pending', started_at=NULL, updated_at=?
               WHERE id=? AND status='running' AND attempts=? AND started_at=?`,
            )
            .run(now, s.id, s.attempts, s.started_at);
          if (requeued.changes > 0) {
            await this.jobPolicyLog.markAttemptOutcome(s.id, s.attempts, "retry", now);
          }
        }
      }
      const row = await this.db
        .prepare(
          `SELECT pending.id FROM jobs pending
            WHERE pending.status='pending'
              AND (pending.kind <> 'refresh' OR NOT EXISTS (
                SELECT 1 FROM jobs running
                 WHERE running.project_id=pending.project_id
                   AND running.kind='refresh' AND running.status='running'
              ))
            ORDER BY pending.id ASC LIMIT 1`,
        )
        .get<{ id: number }>();
      if (!row) return null;
      // status='pending' guard: overlapping drains (or two Postgres claim
      // transactions under read committed) must never run the same job twice.
      const claimed = await this.db
        .prepare(
          "UPDATE jobs SET status='running', attempts=attempts+1, started_at=?, updated_at=? WHERE id=? AND status='pending' RETURNING *",
        )
        .get<JobRow>(now, now, row.id);
      return claimed ?? null;
    });
  }

  /**
   * Claims stay serial per drain pass (the claim transaction is atomic and
   * guarded); execution is parallel up to `concurrency`, so long
   * reconcile/curate jobs cannot starve an interactive ask past its
   * tool-call wait window. A claim error is swallowed: a drain tick racing a
   * teardown (or a transient backend hiccup) must not take the process down
   * via an unhandled rejection — the next tick retries.
   */
  private claimEffect(): Effect.Effect<JobRow | null> {
    return Effect.suspend(() => this.stopped
      ? Effect.succeed(null)
      : Effect.tryPromise({
        try: () => this.claim(),
        catch: (error) => error,
      })).pipe(
      Effect.tap((job) => Effect.sync(() => {
        this.recordSuccess("drain");
        return job;
      })),
      Effect.catchAll((error) => Effect.sync(() => {
        this.recordError("drain", error);
        return null;
      })),
    );
  }

  private releaseClaim(job: JobRow | null, exit: Exit.Exit<unknown, unknown>): Effect.Effect<void> {
    if (!job) return Effect.void;
    const message = Exit.isInterrupted(exit)
      ? "job handler interrupted"
      : "job execution exited before persistence";
    return Effect.uninterruptible(Effect.async<void>((resume) => {
      const signal = this.shutdownDeadlineController.signal;
      let settled = false;
      const onAbort = () => { settle(Effect.void); };
      const settle = (effect: Effect.Effect<void>) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resume(effect);
      };
      if (signal.aborted) {
        settle(Effect.void);
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        void this.db
          .prepare(
            `UPDATE jobs SET status='pending', started_at=NULL, error=?, updated_at=?
             WHERE id=? AND status='running' AND attempts=? AND started_at=?`,
          )
          .run(message, Date.now(), job.id, job.attempts, job.started_at)
          .then(
            async (updated) => {
              try {
                if (updated.changes > 0) {
                  await this.jobPolicyLog.markAttemptOutcome(job.id, job.attempts, "retry");
                }
                settle(Effect.void);
              } catch (error) {
                settle(Effect.sync(() => this.recordError("drain", error)));
              }
            },
            (error) => settle(Effect.sync(() => this.recordError("drain", error))),
          );
      } catch (error) {
        settle(Effect.sync(() => this.recordError("drain", error)));
      }
      return Effect.sync(() => {
        settled = true;
        signal.removeEventListener("abort", onAbort);
      });
    }));
  }

  private runClaimed(
    job: JobRow,
    executingFibers: FiberSet.FiberSet<void, never>,
  ): Effect.Effect<boolean> {
    return Effect.acquireUseRelease(
      // Acquisition is masked; the forked handler must not inherit that mask.
      FiberSet.run(executingFibers, Effect.interruptible(this.run(job))),
      (fiber) => Fiber.join(fiber),
      // The durable claim surrounds this nested resource. Its release is
      // uninterruptible and waits for the handler before the claim can return.
      (fiber) => Fiber.interrupt(fiber).pipe(Effect.asVoid),
    ).pipe(
      Effect.as(true),
    );
  }

  private runOne(
    jobSemaphore: Effect.Semaphore,
    claimSemaphore: Effect.Semaphore,
    executingFibers: FiberSet.FiberSet<void, never>,
  ): Effect.Effect<boolean> {
    const claimed = Effect.acquireRelease(
      claimSemaphore.withPermits(1)(this.claimEffect()),
      (job, exit) => this.releaseClaim(job, exit),
    ).pipe(
      Effect.flatMap((job) => {
        if (!job || this.stopped) return Effect.succeed(false);
        return this.runClaimed(job, executingFibers);
      }),
      Effect.scoped,
    );
    return jobSemaphore.withPermits(1)(claimed);
  }

  private runPeriodic(stopSignals: EffectQueue.Queue<void>): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      yield* Effect.yieldNow();
      while (!this.stopped) {
        this.signalWork();
        yield* this.runSweepsEffect();
        if (!this.stopped) {
          yield* Effect.raceFirst(
            Effect.sleep(this.tickMs),
            EffectQueue.take(stopSignals),
          );
        }
      }
    });
  }

  // Create the executing set before the scheduling set. Scoped shutdown is
  // LIFO, so scheduling parents await their child before execution set close.
  private supervise(): Effect.Effect<void, never, Scope.Scope> {
    return Effect.gen(this, function* () {
      const signals = yield* EffectQueue.sliding<void>(1);
      const slotSignals = yield* EffectQueue.sliding<void>(1);
      const stopSignals = yield* EffectQueue.sliding<void>(1);
      const executingFibers = yield* FiberSet.make<void, never>();
      const jobSemaphore = yield* Effect.makeSemaphore(this.concurrency);
      const claimSemaphore = yield* Effect.makeSemaphore(1);
      this.workSignals = signals;
      this.slotSignals = slotSignals;
      this.stopSignals = stopSignals;
      this.executingFibers = executingFibers;
      yield* Effect.addFinalizer(() => Effect.sync(() => {
        if (this.workSignals === signals) this.workSignals = undefined;
        if (this.slotSignals === slotSignals) this.slotSignals = undefined;
        if (this.stopSignals === stopSignals) this.stopSignals = undefined;
        if (this.executingFibers === executingFibers) this.executingFibers = undefined;
      }).pipe(
        Effect.zipRight(EffectQueue.shutdown(signals)),
        Effect.zipRight(EffectQueue.shutdown(slotSignals)),
        Effect.zipRight(EffectQueue.shutdown(stopSignals)),
      ));
      const schedulingFibers = yield* FiberSet.make<boolean, never>();
      const dispatch = Effect.gen(this, function* () {
        let demand = false;
        while (!this.stopped) {
          if (!demand) {
            yield* EffectQueue.take(signals);
            demand = true;
          }
          if (this.stopped) break;
          const available = Math.max(0, this.concurrency - Array.from(schedulingFibers).length);
          if (available === 0) {
            yield* EffectQueue.take(slotSignals);
            continue;
          }
          yield* Effect.forEach(
            Array.from({ length: available }),
            () => FiberSet.run(
              schedulingFibers,
              this.runOne(jobSemaphore, claimSemaphore, executingFibers),
            ).pipe(
              Effect.tap((fiber) => Effect.sync(() => {
                // FiberSet registered its removal observer before this one, so
                // refill sees the completed slot as available.
                fiber.addObserver((exit) => {
                  slotSignals.unsafeOffer(undefined);
                  if (Exit.isSuccess(exit) && exit.value) this.signalWork();
                });
              })),
            ),
            { concurrency: this.concurrency, discard: true },
          );
          demand = false;
        }
      });

      yield* Effect.all([dispatch, this.runPeriodic(stopSignals)], {
        concurrency: "unbounded",
        discard: true,
      });
      yield* FiberSet.awaitEmpty(schedulingFibers);
      yield* FiberSet.awaitEmpty(executingFibers);
    });
  }

  private guardedJobUpdate(job: JobRow, sql: string, ...params: SqlValue[]): Effect.Effect<number> {
    return Effect.tryPromise({
      try: () => this.db.prepare(sql).run(...params, job.id, job.attempts, job.started_at),
      catch: (error) => error,
    }).pipe(
      Effect.map((result) => result.changes),
      Effect.catchAll((error) => Effect.sync(() => {
        this.recordError("drain", error);
        return 0;
      })),
    );
  }

  private completeJob(job: JobRow, result: unknown): Effect.Effect<void> {
    return this.guardedJobUpdate(
      job,
      `UPDATE jobs SET status='done', result=?, updated_at=?
       WHERE id=? AND status='running' AND attempts=? AND started_at=?`,
      JSON.stringify(result),
      Date.now(),
    ).pipe(
      Effect.tap((changes) => Effect.sync(() => {
        if (changes > 0) this.events.emit(`job:${job.id}`);
      })),
      Effect.asVoid,
    );
  }

  private failJob(job: JobRow, error: unknown): Effect.Effect<void> {
    const message = error instanceof Error ? error.message : String(error);
    return this.guardedJobUpdate(
      job,
      `UPDATE jobs SET status='failed', error=?, updated_at=?
       WHERE id=? AND status='running' AND attempts=? AND started_at=?`,
      message,
      Date.now(),
    ).pipe(
      Effect.tap((changes) => changes > 0
        ? Effect.tryPromise({
            try: () => this.jobPolicyLog.markAttemptOutcome(job.id, job.attempts, "fail"),
            catch: (policyError) => policyError,
          }).pipe(Effect.catchAll((policyError) => Effect.sync(() => this.recordError("drain", policyError))))
        : Effect.void),
      Effect.tap((changes) => Effect.sync(() => {
        if (changes > 0) {
          console.error(failureLog(job, error));
          this.events.emit(`job:${job.id}`);
        }
      })),
      Effect.asVoid,
    );
  }

  private requeueJob(job: JobRow, error: unknown): Effect.Effect<void> {
    const message = error instanceof Error ? error.message : String(error);
    return this.guardedJobUpdate(
      job,
      `UPDATE jobs SET status='pending', started_at=NULL, error=?, updated_at=?
       WHERE id=? AND status='running' AND attempts=? AND started_at=?`,
      message,
      Date.now(),
    ).pipe(
      Effect.tap((changes) => changes > 0
        ? Effect.tryPromise({
            try: () => this.jobPolicyLog.markAttemptOutcome(job.id, job.attempts, "retry"),
            catch: (policyError) => policyError,
          }).pipe(Effect.catchAll((policyError) => Effect.sync(() => this.recordError("drain", policyError))))
        : Effect.void),
      Effect.asVoid,
    );
  }

  private run(job: JobRow): Effect.Effect<void> {
    const handler = this.handlers.get(job.kind);
    if (!handler) {
      return this.failJob(job, new Error(`no handler for kind ${job.kind}`));
    }

    const invoke = Effect.try({
      try: () => JSON.parse(job.payload) as unknown,
      catch: (error) => error,
    }).pipe(
      Effect.flatMap((payload) => Effect.tryPromise({
        try: () => handler(payload, job),
        catch: (error) => error,
      })),
      Effect.timeoutFail({
        duration: this.jobTimeoutMs,
        onTimeout: () => new Error("job handler timed out"),
      }),
    );

    return Effect.matchEffect(invoke, {
      onSuccess: (result) => this.completeJob(job, result),
      onFailure: (err) => {
        const shouldRetryJob = !(
          err &&
          typeof err === "object" &&
          "_tag" in err &&
          typeof err._tag === "string" &&
          TERMINAL_DRIVER_ERROR_TAGS.has(err._tag)
        );
        return job.attempts >= MAX_ATTEMPTS || !shouldRetryJob
          ? this.failJob(job, err)
          : this.requeueJob(job, err);
      },
    });
  }
}
