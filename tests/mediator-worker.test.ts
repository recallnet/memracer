import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db.js";
import { MediatorWorker, type JobRow } from "../src/mediator/worker.js";
import { JobPolicyLog } from "../src/mediator/job-policy-log.js";
import { MediatorOutputError, OpenRouterPermanentError, OpenRouterRetriesExhaustedError } from "../src/mediator/openrouter.js";
import { openTestDb } from "./helpers/db.js";

async function setup(
  handler: (payload: unknown, job: JobRow) => Promise<unknown>,
  opts?: { tickMs?: number; jobTimeoutMs?: number; concurrency?: number },
): Promise<{ db: Db; worker: MediatorWorker }> {
  const db = await openTestDb();
  await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
  const worker = new MediatorWorker(db, {
    tickMs: opts?.tickMs ?? 20,
    jobTimeoutMs: opts?.jobTimeoutMs ?? 500,
    concurrency: opts?.concurrency,
  });
  worker.register("groom", handler);
  return { db, worker };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let active: MediatorWorker | undefined;
afterEach(async () => {
  const worker = active;
  active = undefined;
  if (worker) await worker.stopAndWait();
});

describe("MediatorWorker", () => {
  it("reports zero in flight before and after an empty drain", async () => {
    const { worker } = await setup(async () => ({ ok: true }), { tickMs: 10_000 });
    active = worker;
    expect(worker.status().inFlight).toBe(0);
    worker.start();
    await sleep(20);
    expect(worker.status().inFlight).toBe(0);
  });

  it("does not count a blocked claim attempt as in flight", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
    let announceBlocked!: () => void;
    const blocked = new Promise<void>((resolve) => { announceBlocked = resolve; });
    let releaseClaim!: () => void;
    const claimGate = new Promise<void>((resolve) => { releaseClaim = resolve; });
    let gateFirstClaim = true;
    const wrapped = new Proxy(db, {
      get(target, property) {
        if (property === "transaction") {
          return async <T>(fn: () => Promise<T>): Promise<T> => {
            if (gateFirstClaim) {
              gateFirstClaim = false;
              announceBlocked();
              await claimGate;
            }
            return target.transaction(fn);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Db;
    const worker = new MediatorWorker(wrapped, { tickMs: 10_000, concurrency: 1 });
    active = worker;
    worker.start();
    await blocked;

    try {
      expect(worker.status().inFlight).toBe(0);
    } finally {
      releaseClaim();
    }
  });

  it("requeues a claim that completes after stop without starting its handler", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
    let announceBlocked!: () => void;
    const blocked = new Promise<void>((resolve) => { announceBlocked = resolve; });
    let releaseClaim!: () => void;
    const claimGate = new Promise<void>((resolve) => { releaseClaim = resolve; });
    let gateFirstClaim = true;
    const wrapped = new Proxy(db, {
      get(target, property) {
        if (property === "transaction") {
          return async <T>(fn: () => Promise<T>): Promise<T> => {
            if (gateFirstClaim) {
              gateFirstClaim = false;
              announceBlocked();
              await claimGate;
            }
            return target.transaction(fn);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Db;
    const handler = vi.fn(async () => ({ tooLate: true }));
    const worker = new MediatorWorker(wrapped, { tickMs: 10_000, concurrency: 1 });
    worker.register("groom", handler);
    active = worker;
    worker.start();
    await blocked;
    const id = await worker.enqueue("p", "groom", { keep: "pending" });

    worker.stop();
    releaseClaim();
    await worker.stopAndWait(1_000);

    expect(handler).not.toHaveBeenCalled();
    expect(worker.status().inFlight).toBe(0);
    expect(await worker.getJob(id)).toMatchObject({
      status: "pending",
      attempts: 1,
      started_at: null,
      result: null,
      error: "job execution exited before persistence",
    });
    await sleep(20);
    expect(handler).not.toHaveBeenCalled();
  });

  it("bounds a requeue already blocked between stop and stopAndWait", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
    let announceClaim!: () => void;
    const claimBlocked = new Promise<void>((resolve) => { announceClaim = resolve; });
    let releaseClaim!: () => void;
    const claimGate = new Promise<void>((resolve) => { releaseClaim = resolve; });
    let announceUpdate!: () => void;
    const updateBlocked = new Promise<void>((resolve) => { announceUpdate = resolve; });
    let releaseUpdate!: () => void;
    const updateGate = new Promise<void>((resolve) => { releaseUpdate = resolve; });
    let gateFirstClaim = true;
    const wrapped = new Proxy(db, {
      get(target, property) {
        if (property === "transaction") {
          return async <T>(fn: () => Promise<T>): Promise<T> => {
            if (gateFirstClaim) {
              gateFirstClaim = false;
              announceClaim();
              await claimGate;
            }
            return target.transaction(fn);
          };
        }
        if (property === "prepare") {
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (!sql.includes("UPDATE jobs SET status='pending', started_at=NULL, error=?")) {
              return statement;
            }
            return new Proxy(statement, {
              get(statementTarget, statementProperty) {
                if (statementProperty === "run") {
                  return async (...params: Parameters<typeof statementTarget.run>) => {
                    announceUpdate();
                    await updateGate;
                    return statementTarget.run(...params);
                  };
                }
                const value = Reflect.get(statementTarget, statementProperty, statementTarget) as unknown;
                return typeof value === "function" ? value.bind(statementTarget) : value;
              },
            });
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Db;
    const handler = vi.fn(async () => ({ tooLate: true }));
    const worker = new MediatorWorker(wrapped, { tickMs: 10_000, concurrency: 1 });
    worker.register("groom", handler);
    active = worker;
    worker.start();
    await claimBlocked;
    const id = await worker.enqueue("p", "groom", { keep: "pending" });
    worker.stop();
    releaseClaim();
    await updateBlocked;

    const stopping = worker.stopAndWait(20);
    const outcome = await Promise.race([
      stopping.then(
        () => "resolved" as const,
        (error: unknown) => error,
      ),
      sleep(250).then(() => "pending" as const),
    ]);
    const beforeRelease = await worker.getJob(id);
    releaseUpdate();
    await stopping.catch(() => undefined);
    active = undefined;

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe("mediator worker did not become idle before shutdown timeout");
    expect(handler).not.toHaveBeenCalled();
    expect(beforeRelease).toMatchObject({ status: "running", result: null });
    await vi.waitUntil(async () => (await worker.getJob(id)).status === "pending", { timeout: 1_000 });
    expect(await worker.getJob(id)).toMatchObject({
      status: "pending",
      started_at: null,
      result: null,
      error: "job execution exited before persistence",
    });
  });

  it("runs a job and waitForJob returns its result", async () => {
    const { worker } = await setup(async (p) => ({ echoed: p }));
    active = worker;
    worker.start();
    const id = await worker.enqueue("p", "groom", { x: 1 });
    const job = await worker.waitForJob(id, 3000);
    expect(job.status).toBe("done");
    expect(JSON.parse(job.result!)).toEqual({ echoed: { x: 1 } });
  });

  it("fails a job whose handler throws, retries once, then marks failed", async () => {
    let calls = 0;
    const { worker } = await setup(async () => {
      calls += 1;
      throw new Error("boom");
    });
    active = worker;
    worker.start();
    const id = await worker.enqueue("p", "groom", {});
    const job = await worker.waitForJob(id, 5000);
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/boom/);
    expect(calls).toBe(2);
  });

  it("marks the first policy attempt retry and the successful attempt ok", async () => {
    let policyLog: JobPolicyLog;
    const made = await setup(async (_payload, job) => {
      const key = { jobId: job.id, attempt: job.attempts, invocation: 1 };
      await policyLog.start({
        ...key,
        projectId: job.project_id,
        taskId: null,
        kind: job.kind,
        classifiedDifficulty: null,
        model: "z-ai/glm-5.2",
        effort: "high",
        maxTokens: 32_768,
        rolloutArm: "routed",
        startedAt: Date.now(),
      });
      await policyLog.finish(key, {
        outcome: "ok", finishedAt: Date.now(), tokensIn: 10, tokensOut: 2,
      });
      if (job.attempts === 1) throw new Error("retry after post-model failure");
      return { ok: true };
    });
    policyLog = new JobPolicyLog(made.db);
    active = made.worker;
    made.worker.start();
    const id = await made.worker.enqueue("p", "groom", {});
    expect((await made.worker.waitForJob(id, 5_000)).status).toBe("done");
    expect(await made.db.prepare(
      "SELECT attempt, outcome FROM job_policy_log WHERE job_id=? ORDER BY attempt",
    ).all(id)).toEqual([
      { attempt: 1, outcome: "retry" },
      { attempt: 2, outcome: "ok" },
    ]);
  });

  it("requeues a thrown mid-claim attempt when shutdown prevents immediate retry", async () => {
    let worker!: MediatorWorker;
    let announce!: () => void;
    const attempted = new Promise<void>((resolve) => { announce = resolve; });
    const made = await setup(async () => {
      announce();
      worker.stop();
      throw new Error("mid-claim boom");
    }, { tickMs: 10_000 });
    worker = made.worker;
    active = worker;
    worker.start();
    const id = await worker.enqueue("p", "groom", { keep: "me" });
    await attempted;
    await worker.stopAndWait(1_000);
    expect(await worker.getJob(id)).toMatchObject({
      status: "pending",
      attempts: 1,
      started_at: null,
      error: "mid-claim boom",
    });
  });

  it("logs bounded structured context when a mediator job exhausts retries", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const raw = "é".repeat(3_000);
    const { worker } = await setup(async () => {
      throw new MediatorOutputError({
        message: "invalid mediator output after retry; schema validation error",
        model: "textile-1",
        rawOutput: raw,
      });
    });
    active = worker;
    worker.start();
    const id = await worker.enqueue("p", "groom", {});
    const job = await worker.waitForJob(id, 5000);
    expect(job.status).toBe("failed");
    const line = String(log.mock.calls.find((call) => String(call[0]).startsWith("[mediator-job-failure]"))?.[0]);
    const entry = JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>;
    expect(entry).toMatchObject({
      job_id: id,
      kind: "groom",
      attempts: 2,
      model: "textile-1",
      error: expect.stringContaining("schema validation error"),
    });
    expect(Buffer.byteLength(String(entry.raw_output))).toBe(2048);
    log.mockRestore();
  });

  it("does not repeat a driver-level exhausted retry budget", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let calls = 0;
    const { worker } = await setup(async () => {
      calls += 1;
      throw new OpenRouterRetriesExhaustedError({
        message: "openrouter 429: busy",
        model: "textile-1",
        status: 429,
      });
    });
    active = worker;
    worker.start();
    const id = await worker.enqueue("p", "groom", {});
    const job = await worker.waitForJob(id, 5000);
    expect(job.status).toBe("failed");
    expect(job.attempts).toBe(1);
    expect(calls).toBe(1);
    log.mockRestore();
  });

  it("does not repeat a permanent pinned-model provider failure", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let calls = 0;
    const { worker } = await setup(async () => {
      calls += 1;
      throw new OpenRouterPermanentError({
        message: "openrouter 404: No endpoints found that can handle the requested parameters",
        model: "z-ai/glm-5.2",
        status: 404,
      });
    });
    active = worker;
    worker.start();
    const id = await worker.enqueue("p", "groom", {});
    const job = await worker.waitForJob(id, 5000);
    expect(job.status).toBe("failed");
    expect(job.attempts).toBe(1);
    expect(calls).toBe(1);
    log.mockRestore();
  });

  it("runs slow jobs concurrently: 3 jobs finish in ~1x handler time, not 3x", async () => {
    const { worker } = await setup(async (p) => {
      await sleep(150);
      return { echoed: p };
    });
    active = worker;
    worker.start();
    const ids = await Promise.all([1, 2, 3].map((x) => worker.enqueue("p", "groom", { x })));
    const t0 = Date.now();
    const jobs = await Promise.all(ids.map((id) => worker.waitForJob(id, 5000)));
    const elapsed = Date.now() - t0;
    for (const job of jobs) expect(job.status).toBe("done");
    expect(elapsed).toBeLessThan(350); // serial would be >= 450ms
  });

  it("caps in-flight handlers at opts.concurrency and never double-runs a job", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const runs = new Map<number, number>();
    const { worker } = await setup(
      async (p) => {
        const { x } = p as { x: number };
        runs.set(x, (runs.get(x) ?? 0) + 1);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await sleep(60);
        inFlight -= 1;
        return { x };
      },
      { concurrency: 2 },
    );
    active = worker;
    worker.start();
    const ids = await Promise.all([1, 2, 3, 4, 5].map((x) => worker.enqueue("p", "groom", { x })));
    const jobs = await Promise.all(ids.map((id) => worker.waitForJob(id, 5000)));
    for (const job of jobs) expect(job.status).toBe("done");
    expect(maxInFlight).toBe(2);
    expect([...runs.values()]).toEqual([1, 1, 1, 1, 1]);
  });

  it("uses the default three-permit cap", async () => {
    let running = 0;
    let maxRunning = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { worker } = await setup(async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await gate;
      running -= 1;
      return { ok: true };
    }, { tickMs: 10_000, jobTimeoutMs: 5_000 });
    active = worker;
    worker.start();
    const ids = await Promise.all(Array.from({ length: 6 }, (_, x) =>
      worker.enqueue("p", "groom", { x })));
    await vi.waitUntil(() => maxRunning === 3, { timeout: 1_000 });
    expect(worker.status().inFlight).toBe(3);
    release();
    expect((await Promise.all(ids.map((id) => worker.waitForJob(id, 2_000))))
      .every((job) => job.status === "done")).toBe(true);
    expect(maxRunning).toBe(3);
  });

  it("refills a freed single slot without waiting for the periodic tick", async () => {
    const starts: number[] = [];
    const { worker } = await setup(async () => {
      starts.push(Date.now());
      await sleep(25);
      return { ok: true };
    }, { tickMs: 10_000, concurrency: 1 });
    active = worker;
    worker.start();
    const ids = await Promise.all([
      worker.enqueue("p", "groom", { x: 1 }),
      worker.enqueue("p", "groom", { x: 2 }),
    ]);
    const jobs = await Promise.all(ids.map((id) => worker.waitForJob(id, 1_000)));
    expect(jobs.map((job) => job.status)).toEqual(["done", "done"]);
    expect(starts).toHaveLength(2);
    expect(starts[1] - starts[0]).toBeLessThan(250);
  });

  it("retains enqueue demand while a full FiberSet is finishing a null claim", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
    let releaseNull!: () => void;
    const nullGate = new Promise<void>((resolve) => { releaseNull = resolve; });
    let announceNull!: () => void;
    const nullReady = new Promise<void>((resolve) => { announceNull = resolve; });
    let holdFirstNull = true;
    const wrapped = new Proxy(db, {
      get(target, property) {
        if (property === "transaction") {
          return async <T>(fn: () => Promise<T>): Promise<T> => {
            const result = await target.transaction(fn);
            if (holdFirstNull && result === null) {
              holdFirstNull = false;
              announceNull();
              await nullGate;
            }
            return result;
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Db;
    const worker = new MediatorWorker(wrapped, {
      tickMs: 10_000,
      jobTimeoutMs: 1_000,
      concurrency: 1,
    });
    worker.register("groom", async () => ({ ok: true }));
    active = worker;
    worker.start();
    await nullReady;
    try {
      expect(worker.status().inFlight).toBe(0);
      const id = await worker.enqueue("p", "groom", { arrived: "while-full" });
      await sleep(20);
      releaseNull();
      expect((await worker.waitForJob(id, 1_000)).status).toBe("done");
    } finally {
      releaseNull();
    }
  });

  it("stop(): in-flight jobs finish, queued ones are not started", async () => {
    let started = 0;
    const { worker } = await setup(
      async () => {
        started += 1;
        await sleep(100);
        return { ok: true };
      },
      { concurrency: 1 },
    );
    active = worker;
    worker.start();
    const first = await worker.enqueue("p", "groom", { x: 1 });
    const second = await worker.enqueue("p", "groom", { x: 2 });
    // let the first job get claimed, then stop before the second can start
    while (started === 0) await sleep(5);
    worker.stop();
    const done = await worker.waitForJob(first, 3000);
    expect(done.status).toBe("done");
    await sleep(150);
    expect((await worker.getJob(second)).status).toBe("pending");
    expect(started).toBe(1);
  });

  it("stop and stopAndWait invoke each registered stop handler once", async () => {
    const { worker } = await setup(async () => ({ ok: true }), { tickMs: 10_000 });
    active = worker;
    const stopped = vi.fn();
    worker.onStop(stopped);
    worker.start();
    worker.stop();
    await worker.stopAndWait(500);
    expect(stopped).toHaveBeenCalledOnce();
  });

  it("wakes a long periodic sleep so an idle worker stops promptly", async () => {
    const { worker } = await setup(async () => ({ ok: true }), { tickMs: 60_000 });
    active = worker;
    worker.start();
    await sleep(20);
    await expect(worker.stopAndWait(200)).resolves.toBeUndefined();
  });

  it("findOrEnqueue: an identical pending/running job is reused, not duplicated", async () => {
    const { db, worker } = await setup(async () => {
      await sleep(80);
      return { ok: true };
    });
    active = worker;
    worker.start();
    const first = await worker.findOrEnqueue("p", "groom", { taskId: 7, question: "q" });
    const dup = await worker.findOrEnqueue("p", "groom", { taskId: 7, question: "q" });
    expect(dup).toBe(first);
    const other = await worker.findOrEnqueue("p", "groom", { taskId: 7, question: "different" });
    expect(other).not.toBe(first);
    expect(((await db.prepare("SELECT COUNT(*) AS n FROM jobs").get<{ n: number }>()) as { n: number }).n).toBe(2);
    await worker.waitForJob(first, 3000);
    // once the job completed, the same payload enqueues fresh work
    const again = await worker.findOrEnqueue("p", "groom", { taskId: 7, question: "q" });
    expect(again).not.toBe(first);
  });

  it("findOrEnqueue atomically coalesces concurrent identical calls", async () => {
    const { db, worker } = await setup(async () => ({ ok: true }));
    active = worker;
    const ids = await Promise.all(Array.from({ length: 12 }, () =>
      worker.findOrEnqueue("p", "groom", { taskId: 7, question: "same" })));
    expect(new Set(ids)).toEqual(new Set([ids[0]]));
    expect(await db.prepare("SELECT COUNT(*) AS n FROM jobs").get()).toEqual({ n: 1 });
    expect(await db.prepare("SELECT coalesce_key IS NOT NULL AS keyed FROM jobs").get()).toEqual({
      keyed: db.dialect === "postgres" ? true : 1,
    });
    expect((await worker.waitForJob(ids[0], 3_000)).status).toBe("done");
  });

  it("serializes distinct refresh payloads per project across workers while preserving FIFO", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P'),('other','Other')").run();
    const first = new MediatorWorker(db, { tickMs: 10, jobTimeoutMs: 10_000, concurrency: 3 });
    const second = new MediatorWorker(db, { tickMs: 10, jobTimeoutMs: 10_000, concurrency: 3 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const starts: string[] = [];
    const handler = async (payload: unknown) => {
      const marker = (payload as { marker: string }).marker;
      starts.push(marker);
      if (marker === "first") await gate;
      return marker;
    };
    first.register("refresh", handler);
    second.register("refresh", handler);
    const firstId = await first.enqueue("p", "refresh", { marker: "first" });
    const secondId = await first.enqueue("p", "refresh", { marker: "second" });
    const otherId = await first.enqueue("other", "refresh", { marker: "other" });
    try {
      first.start();
      second.start();
      const startDeadline = Date.now() + 8_000;
      while ((!starts.includes("first") || !starts.includes("other")) && Date.now() < startDeadline) await sleep(5);
      expect(starts).toEqual(expect.arrayContaining(["first", "other"]));
      await sleep(60);
      expect(starts).not.toContain("second");
      expect((await first.getJob(secondId)).status).toBe("pending");
      release();
      expect((await first.waitForJob(firstId, 2_000)).status).toBe("done");
      expect((await first.waitForJob(otherId, 2_000)).status).toBe("done");
      expect((await first.waitForJob(secondId, 2_000)).status).toBe("done");
      expect(starts.filter((marker) => marker !== "other")).toEqual(["first", "second"]);
    } finally {
      release();
      await Promise.all([first.stopAndWait(), second.stopAndWait()]);
    }
  });

  it("does not retain the Effect timeout after the handler settles", async () => {
    const { worker } = await setup(async () => "ok", { jobTimeoutMs: 60_000 });
    active = worker;
    worker.start();
    const job = await worker.waitForJob(await worker.enqueue("p", "groom", { x: 1 }), 3000);
    expect(job.status).toBe("done");
    await expect(worker.stopAndWait(200)).resolves.toBeUndefined();
  });

  it("coalesces overlapping sweep ticks and stopAndWait includes the active sweep", async () => {
    const { worker } = await setup(async () => ({ ok: true }));
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let announce!: () => void;
    const started = new Promise<void>((resolve) => { announce = resolve; });
    worker.registerSweep(async () => {
      calls += 1;
      announce();
      await gate;
    });
    worker.start();
    await started;
    await sleep(60);
    expect(calls).toBe(1);
    let settled = false;
    const stopping = worker.stopAndWait(1_000).then(() => { settled = true; });
    await sleep(20);
    expect(settled).toBe(false);
    release();
    await stopping;
    expect(calls).toBe(1);
  });

  it("does not start the queued initial sweep after immediate stopAndWait", async () => {
    const { worker } = await setup(async () => ({ ok: true }));
    let calls = 0;
    worker.registerSweep(async () => { calls += 1; });
    worker.start();
    await worker.stopAndWait();
    await sleep(20);
    expect(calls).toBe(0);
  });

  it("watchdog: a job stuck past the timeout is retried without losing its payload", async () => {
    let calls = 0;
    const { worker } = await setup(
      async (p) => {
        calls += 1;
        if (calls === 1) await new Promise((r) => setTimeout(r, 60_000)); // hang first attempt
        return { ok: true, payload: p };
      },
      { jobTimeoutMs: 100 },
    );
    active = worker;
    worker.start();
    const id = await worker.enqueue("p", "groom", { keep: "me" });
    const job = await worker.waitForJob(id, 8000);
    expect(job.status).toBe("done");
    expect(JSON.parse(job.result!)).toEqual({ ok: true, payload: { keep: "me" } });
    expect(calls).toBe(2);
  });

  it("interrupting a claimed job requeues it before forced shutdown returns", async () => {
    let finishLate!: (value: unknown) => void;
    const lateHandler = new Promise<unknown>((resolve) => { finishLate = resolve; });
    const { worker } = await setup(async () => lateHandler, {
      tickMs: 10_000,
      jobTimeoutMs: 60_000,
      concurrency: 1,
    });
    active = worker;
    worker.start();
    const id = await worker.enqueue("p", "groom", { keep: "me" });
    await vi.waitUntil(async () => (await worker.getJob(id)).status === "running", { timeout: 1_000 });
    await expect(worker.stopAndWait(30)).rejects.toThrow(
      "mediator worker did not become idle before shutdown timeout",
    );
    active = undefined;
    expect(await worker.getJob(id)).toMatchObject({
      status: "pending",
      started_at: null,
      error: "job handler interrupted",
    });
    finishLate({ tooLate: true });
    await sleep(20);
    expect(await worker.getJob(id)).toMatchObject({
      status: "pending",
      result: null,
      error: "job handler interrupted",
    });
  });

  it("gives a post-interrupt exact requeue the reserved cleanup tail", async () => {
    const db = await openTestDb();
    await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
    let announceUpdate!: () => void;
    const updateBlocked = new Promise<void>((resolve) => { announceUpdate = resolve; });
    let releaseUpdate!: () => void;
    const updateGate = new Promise<void>((resolve) => { releaseUpdate = resolve; });
    const wrapped = new Proxy(db, {
      get(target, property) {
        if (property === "prepare") {
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (!sql.includes("UPDATE jobs SET status='pending', started_at=NULL, error=?")) {
              return statement;
            }
            return new Proxy(statement, {
              get(statementTarget, statementProperty) {
                if (statementProperty === "run") {
                  return async (...params: Parameters<typeof statementTarget.run>) => {
                    announceUpdate();
                    await updateGate;
                    return statementTarget.run(...params);
                  };
                }
                const value = Reflect.get(statementTarget, statementProperty, statementTarget) as unknown;
                return typeof value === "function" ? value.bind(statementTarget) : value;
              },
            });
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Db;
    let finishLate!: (value: unknown) => void;
    const lateHandler = new Promise<unknown>((resolve) => { finishLate = resolve; });
    const worker = new MediatorWorker(wrapped, {
      tickMs: 10_000,
      jobTimeoutMs: 60_000,
      concurrency: 1,
    });
    worker.register("groom", async () => lateHandler);
    active = worker;
    worker.start();
    const id = await worker.enqueue("p", "groom", { keep: "me" });
    await vi.waitUntil(async () => (await worker.getJob(id)).status === "running", { timeout: 1_000 });

    let settled = false;
    let stoppingError: unknown;
    const stopping = worker.stopAndWait(100).then(
      () => { settled = true; },
      (error: unknown) => { settled = true; stoppingError = error; },
    );
    await updateBlocked;
    await sleep(5);

    expect(settled).toBe(false);
    expect(await worker.getJob(id)).toMatchObject({ status: "running", result: null });
    releaseUpdate();
    await stopping;
    active = undefined;

    expect(stoppingError).toBeInstanceOf(Error);
    expect((stoppingError as Error).message).toBe(
      "mediator worker did not become idle before shutdown timeout",
    );
    expect(await worker.getJob(id)).toMatchObject({
      status: "pending",
      started_at: null,
      result: null,
      error: "job handler interrupted",
    });
    finishLate({ tooLate: true });
    await sleep(20);
    expect(await worker.getJob(id)).toMatchObject({ status: "pending", result: null });
  });

  it("does not let a stale finalizer mutate a newer attempt", async () => {
    const { db, worker } = await setup(async () => new Promise<never>(() => undefined), {
      tickMs: 10_000,
      jobTimeoutMs: 60_000,
      concurrency: 1,
    });
    active = worker;
    worker.start();
    const id = await worker.enqueue("p", "groom", { keep: "newer-attempt" });
    await vi.waitUntil(async () => (await worker.getJob(id)).status === "running", { timeout: 1_000 });
    const first = await worker.getJob(id);
    const newerStartedAt = first.started_at! + 1_000;
    await db.prepare(
      "UPDATE jobs SET attempts=attempts+1, started_at=?, error=NULL WHERE id=? AND status='running'",
    ).run(newerStartedAt, id);

    await expect(worker.stopAndWait(30)).rejects.toThrow(
      "mediator worker did not become idle before shutdown timeout",
    );
    active = undefined;
    expect(await worker.getJob(id)).toMatchObject({
      status: "running",
      attempts: 2,
      started_at: newerStartedAt,
      error: null,
    });
  });

  it("a hung handler times out, releases its only slot, and lets backlog finish", async () => {
    const starts: number[] = [];
    const { worker } = await setup(async (payload) => {
      const x = (payload as { x: number }).x;
      starts.push(x);
      if (x === 1) return new Promise<never>(() => undefined);
      return { x };
    }, { tickMs: 10_000, jobTimeoutMs: 40, concurrency: 1 });
    active = worker;
    worker.start();
    const first = await worker.enqueue("p", "groom", { x: 1 });
    const second = await worker.enqueue("p", "groom", { x: 2 });
    expect((await worker.waitForJob(second, 1_000)).status).toBe("done");
    expect((await worker.waitForJob(first, 1_000)).status).toBe("failed");
    expect(starts).toEqual([1, 1, 2]);
  });

  it("keeps worker ownership in Effect primitives instead of legacy timers and counters", () => {
    const source = readFileSync(new URL("../src/mediator/worker.ts", import.meta.url), "utf8");
    expect(source).toContain("Effect.acquireRelease");
    expect(source).toContain("Effect.forEach");
    expect(source).toContain("Effect.makeSemaphore");
    expect(source).toContain("FiberSet.make");
    expect(source).not.toMatch(/\bsetInterval\s*\(/);
    expect(source).not.toMatch(/\bPromise\.race\s*\(/);
    expect(source).not.toMatch(/private\s+inFlight\s*=/);
  });
});
