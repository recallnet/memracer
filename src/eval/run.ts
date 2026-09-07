import type { MediatorContext, MediatorDriver } from "../mediator/driver.js";
import type { AnswerFixture, GroomFixture, ReviewFixture } from "./fixtures.js";
import { answerFixtures, groomFixtures, reviewFixtures } from "./fixtures.js";

export interface FixtureSet {
  groom: GroomFixture[];
  review: ReviewFixture[];
  answer: AnswerFixture[];
}

export interface RunEvalOptions {
  /** Parallel driver calls (default 4). */
  concurrency?: number;
  /** Override the golden suite (used by scoring unit tests). */
  fixtures?: FixtureSet;
  /** Called once after the run; return mean-cost-per-job * 100, or null when no meter data. */
  costPer100Jobs?: () => number | null;
}

export interface PerCase {
  name: string;
  expected: string;
  got: string;
  ok: boolean;
  ms: number;
}

export interface Scorecard {
  groom: { accuracy: number; mergePrecision: number; mergeRecall: number; clarifyRate: number };
  review: { accuracy: number; badPlanApprovals: number; actionableFeedbackRate: number };
  answer: { accuracy: number };
  invalidJsonCount: number;
  latency: { p50Ms: number; p95Ms: number };
  costPer100Jobs: number | null;
  perCase: PerCase[];
}

/** Revise feedback shorter than this is treated as non-actionable (documented heuristic). */
const ACTIONABLE_FEEDBACK_MIN_CHARS = 40;

interface CaseOutcome extends PerCase {
  kind: "groom" | "review" | "answer";
  error: boolean;
  /** groom */
  predictedMerge?: boolean;
  correctMerge?: boolean;
  goldenMerge?: boolean;
  goldenClarify?: boolean;
  predictedClarifyOnGoldenClarify?: boolean;
  /** review */
  badPlanApproval?: boolean;
  reviseVerdict?: boolean;
  actionableFeedback?: boolean;
}

function groomContext(f: GroomFixture): MediatorContext {
  return { projectId: "eval", projectName: "eval-project", queue: f.queue, decisions: [], memory: "" };
}

/**
 * Review/answer drivers only see the task through the context, so the harness
 * surfaces the fixture's task as the sole queued item plus a "create" decision
 * whose rationale carries the full task body (acceptance criteria included).
 */
function taskContext(task: { title: string; body: string }): MediatorContext {
  return {
    projectId: "eval",
    projectName: "eval-project",
    queue: [{ id: 1, title: task.title, state: "PLANNING", priority: 1 }],
    decisions: [
      { kind: "create", task_id: 1, summary: `created task 1 "${task.title}"`, rationale: `Task spec: ${task.body}` },
    ],
    memory: "",
  };
}

function ratio(numer: number, denom: number): number {
  return denom === 0 ? 1 : numer / denom;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

async function runCase(kind: "groom" | "review" | "answer", name: string, expected: string, call: () => Promise<string>): Promise<{ got: string; ms: number; error: boolean }> {
  const start = performance.now();
  try {
    const got = await call();
    return { got, ms: performance.now() - start, error: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { got: `error: ${msg}`, ms: performance.now() - start, error: true };
  }
}

async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function runEval(driver: MediatorDriver, opts: RunEvalOptions = {}): Promise<Scorecard> {
  const fixtures = opts.fixtures ?? { groom: groomFixtures, review: reviewFixtures, answer: answerFixtures };
  const concurrency = opts.concurrency ?? 4;

  const jobs: (() => Promise<CaseOutcome>)[] = [];

  for (const f of fixtures.groom) {
    const expected = f.golden.action === "merge" ? `merge:${f.golden.into_task_id}` : f.golden.action;
    jobs.push(async () => {
      let predictedMerge = false;
      let predictedClarify = false;
      const r = await runCase("groom", f.name, expected, async () => {
        const result = await driver.groom(groomContext(f), {
          taskId: 9000,
          title: f.submission.title,
          body: f.submission.body,
          priority: f.submission.priority,
          submittedBy: "eval-user",
          evidence: f.submission.evidence,
        });
        predictedMerge = result.action === "merge";
        predictedClarify = result.action === "clarify";
        return result.action === "merge" ? `merge:${result.into_task_id}` : result.action;
      });
      const ok = !r.error && r.got === expected;
      const goldenMerge = f.golden.action === "merge";
      const goldenClarify = f.golden.action === "clarify";
      return {
        kind: "groom", name: f.name, expected, got: r.got, ok, ms: r.ms, error: r.error,
        predictedMerge, correctMerge: ok && goldenMerge, goldenMerge, goldenClarify,
        predictedClarifyOnGoldenClarify: goldenClarify && predictedClarify,
      };
    });
  }

  for (const f of fixtures.review) {
    const expected = f.golden.verdict;
    jobs.push(async () => {
      let feedback = "";
      let verdict: string | undefined;
      const r = await runCase("review", f.name, expected, async () => {
        const result = await driver.review(taskContext(f.task), {
          taskId: 1,
          task: { ...f.task, groomingRationale: "eval fixture specification" },
          plan: f.plan,
          filesTouched: f.filesTouched,
          risk: f.risk,
        });
        feedback = result.feedback;
        verdict = result.verdict;
        return result.verdict;
      });
      const ok = !r.error && r.got === expected;
      return {
        kind: "review", name: f.name, expected, got: r.got, ok, ms: r.ms, error: r.error,
        badPlanApproval: verdict === "approved" && f.golden.verdict === "revise" && f.missesAcceptanceCriterion === true,
        reviseVerdict: verdict === "revise",
        actionableFeedback: verdict === "revise" && feedback.trim().length >= ACTIONABLE_FEEDBACK_MIN_CHARS,
      };
    });
  }

  for (const f of fixtures.answer) {
    const expected = f.golden.escalate ? "escalate" : "answer";
    jobs.push(async () => {
      const r = await runCase("answer", f.name, expected, async () => {
        const result = await driver.answer(taskContext(f.task), { taskId: 1, question: f.question });
        return result.escalate ? "escalate" : "answer";
      });
      const ok = !r.error && r.got === expected;
      return { kind: "answer", name: f.name, expected, got: r.got, ok, ms: r.ms, error: r.error };
    });
  }

  const outcomes = await mapConcurrent(jobs, concurrency, (job) => job());

  const groom = outcomes.filter((o) => o.kind === "groom");
  const review = outcomes.filter((o) => o.kind === "review");
  const answer = outcomes.filter((o) => o.kind === "answer");

  const latencies = outcomes.map((o) => o.ms).sort((a, b) => a - b);

  return {
    groom: {
      accuracy: ratio(groom.filter((o) => o.ok).length, groom.length),
      mergePrecision: ratio(
        groom.filter((o) => o.correctMerge).length,
        groom.filter((o) => o.predictedMerge).length,
      ),
      mergeRecall: ratio(
        groom.filter((o) => o.correctMerge).length,
        groom.filter((o) => o.goldenMerge).length,
      ),
      clarifyRate: ratio(
        groom.filter((o) => o.predictedClarifyOnGoldenClarify).length,
        groom.filter((o) => o.goldenClarify).length,
      ),
    },
    review: {
      accuracy: ratio(review.filter((o) => o.ok).length, review.length),
      badPlanApprovals: review.filter((o) => o.badPlanApproval).length,
      actionableFeedbackRate: ratio(
        review.filter((o) => o.actionableFeedback).length,
        review.filter((o) => o.reviseVerdict).length,
      ),
    },
    answer: {
      accuracy: ratio(answer.filter((o) => o.ok).length, answer.length),
    },
    invalidJsonCount: outcomes.filter((o) => o.error).length,
    latency: { p50Ms: percentile(latencies, 50), p95Ms: percentile(latencies, 95) },
    costPer100Jobs: opts.costPer100Jobs ? opts.costPer100Jobs() : null,
    perCase: outcomes.map(({ name, expected, got, ok, ms }) => ({ name, expected, got, ok, ms })),
  };
}
