// Pipeline-level eval: drives groom/review/answer through the REAL pipelines
// (registerPipelines + MediatorWorker + Queue over sqlite) against golden
// expectations. The isolation eval (run.ts) scores driver output; this suite
// scores the pipeline layer around it — the layer where two production
// defects (self-merge crash, groomed-task-in-own-context) lived unseen.
import { openDb } from "../db.js";
import { Queue, DEFAULT_LEASE_TTL_MS } from "../queue.js";
import { MediatorWorker } from "../mediator/worker.js";
import { registerPipelines } from "../mediator/pipelines.js";
import { MemoryStore } from "../mediator/memory.js";
import type {
  DiscussInput,
  DiscussResult,
  GroomResult,
  MediatorContext,
  MediatorDriver,
  Submission,
} from "../mediator/driver.js";

export interface PipelineCaseResult {
  name: string;
  ok: boolean;
  failures: string[];
  ms: number;
}

export interface PipelineScorecard {
  passed: number;
  failed: number;
  perCase: PipelineCaseResult[];
}

export interface PipelineFixture {
  name: string;
  /**
   * Runs the scenario end-to-end against a fresh harness and returns failure
   * messages (empty = pass). Receives the eval driver; guard fixtures may
   * ignore it and script pathological model output instead — they test the
   * pipeline's resilience to bad output, not the model.
   */
  exec: (driver: MediatorDriver) => Promise<string[]>;
}

interface Harness {
  db: ReturnType<typeof openDb>;
  queue: Queue;
  worker: MediatorWorker;
}

const JOB_WAIT_MS = 30_000;

/** Fresh in-memory db + queue + worker wired through the real pipelines. */
async function withHarness(
  driver: MediatorDriver,
  fn: (h: Harness) => Promise<string[]>,
): Promise<string[]> {
  const db = openDb(":memory:");
  await db.prepare("INSERT INTO projects (id, name) VALUES ('p','P')").run();
  const queue = new Queue(db);
  const worker = new MediatorWorker(db, { tickMs: 20, jobTimeoutMs: JOB_WAIT_MS });
  registerPipelines({ db, queue, worker, driverFor: () => driver, publicUrl: "https://memracer.test" });
  worker.start();
  try {
    return await fn({ db, queue, worker });
  } finally {
    worker.stop();
  }
}

function check(failures: string[], cond: boolean, message: string): void {
  if (!cond) failures.push(message);
}

/** Driver whose groom output is scripted per submission; other methods never run. */
function scriptedGroomDriver(groom: (ctx: MediatorContext, s: Submission) => GroomResult): MediatorDriver {
  const unused = (method: string) => async (): Promise<never> => {
    throw new Error(`${method} not scripted for this fixture`);
  };
  return {
    groom: async (ctx, s) => groom(ctx, s),
    review: unused("review"),
    answer: unused("answer"),
    discuss: unused("discuss"),
    enhance: unused("enhance"),
    conciliate: unused("conciliate"),
    eligibility: unused("eligibility"),
  };
}

/** Driver whose discuss output is scripted from the context; other methods never run. */
function scriptedDiscussDriver(
  discuss: (ctx: MediatorContext, input: DiscussInput) => DiscussResult,
): MediatorDriver {
  const unused = (method: string) => async (): Promise<never> => {
    throw new Error(`${method} not scripted for this fixture`);
  };
  return {
    groom: unused("groom"),
    review: unused("review"),
    answer: unused("answer"),
    discuss: async (ctx, input) => discuss(ctx, input),
    enhance: unused("enhance"),
    conciliate: unused("conciliate"),
    eligibility: unused("eligibility"),
  };
}

/** Driver that lets a deterministic answer fixture exercise the real memory-tool loop. */
function scriptedAnswerDriver(answer: MediatorDriver["answer"]): MediatorDriver {
  const unused = (method: string) => async (): Promise<never> => {
    throw new Error(`${method} not scripted for this fixture`);
  };
  return {
    groom: unused("groom"),
    review: unused("review"),
    answer,
    discuss: unused("discuss"),
    enhance: unused("enhance"),
    conciliate: unused("conciliate"),
    eligibility: unused("eligibility"),
  };
}

async function decisionKinds(db: Harness["db"]): Promise<string[]> {
  return (await db.prepare("SELECT kind FROM decision_log ORDER BY id").all<{ kind: string }>()).map((r) => r.kind);
}

/**
 * Shipped regression: the mediator returned a merge target that was the
 * submission itself or did not exist. The pipeline must complete the job,
 * keep the task as its own accepted entry, and log why.
 */
function invalidMergeFixture(
  name: string,
  target: (ownId: number) => number,
  expectedReason: "same_task" | "target_not_mergeable",
): PipelineFixture {
  return {
    name,
    exec: () =>
      withHarness(
        scriptedGroomDriver((_ctx, s) => ({
          action: "merge",
          into_task_id: target(s.taskId),
          rationale: "hallucinated duplicate",
        })),
        async ({ db, queue, worker }) => {
          const failures: string[] = [];
          await queue.submit("p", "dana", { title: "unrelated", body: "b", evidence: [] });
          const id = await queue.submit("p", "dana", { title: "victim", body: "plain body", evidence: [] });
          const job = await worker.waitForJob(
            await worker.enqueue("p", "groom", { taskId: id, submittedBy: "dana" }),
            JOB_WAIT_MS,
          );
          check(failures, job.status === "done", `job status: expected done, got ${job.status} (${job.error ?? "no error"})`);
          const result = job.result ? JSON.parse(job.result) : {};
          check(failures, result.action === "accept", `result action: expected accept fallback, got ${JSON.stringify(result)}`);
          const brief = await queue.brief(id);
          check(failures, brief.state === "QUEUED", `task state: expected QUEUED, got ${brief.state}`);
          check(
            failures,
            new RegExp(`deterministic merge safety refused \\d+ \\(${expectedReason}\\)`).test(
              brief.grooming_rationale ?? "",
            ),
            `grooming_rationale should name the refused target and reason, got: ${brief.grooming_rationale}`,
          );
          const kinds = await decisionKinds(db);
          check(failures, kinds.includes("create"), `decision_log: expected a 'create' entry, got ${kinds}`);
          check(failures, !kinds.includes("merge"), "decision_log: no 'merge' entry may be logged for an invalid target");
          return failures;
        },
      ),
  };
}

export const pipelineFixtures: PipelineFixture[] = [
  invalidMergeFixture("regression-self-merge-target", (ownId) => ownId, "same_task"),
  invalidMergeFixture("regression-hallucinated-merge-target", () => 9999, "target_not_mergeable"),

  {
    // Shipped regression: the task under grooming appeared in its own context
    // queue, so the model saw the submission as an existing duplicate and
    // proposed a self-merge.
    name: "regression-groom-context-excludes-self",
    exec: (driver) => {
      const seen: number[][] = [];
      const recording: MediatorDriver = {
        ...driver,
        groom: (ctx, s) => {
          seen.push(ctx.queue.map((t) => t.id));
          return driver.groom(ctx, s);
        },
        review: driver.review.bind(driver),
        answer: driver.answer.bind(driver),
        discuss: driver.discuss.bind(driver),
      };
      return withHarness(recording, async ({ queue, worker }) => {
        const failures: string[] = [];
        const other = await queue.submit("p", "dana", { title: "existing task", body: "b", evidence: [] });
        const id = await queue.submit("p", "dana", { title: "new submission", body: "plain body", evidence: [] });
        const job = await worker.waitForJob(
          await worker.enqueue("p", "groom", { taskId: id, submittedBy: "dana" }),
          JOB_WAIT_MS,
        );
        check(failures, job.status === "done", `job status: expected done, got ${job.status}`);
        check(failures, seen.length === 1, `driver.groom calls: expected 1, got ${seen.length}`);
        check(failures, (seen[0] ?? []).includes(other), `groom context should include other queued task ${other}, got ${seen[0]}`);
        check(failures, !(seen[0] ?? []).includes(id), `groom context must exclude the task under grooming (${id}), got ${seen[0]}`);
        return failures;
      });
    },
  },

  {
    name: "groom-accept",
    exec: (driver) =>
      withHarness(driver, async ({ db, queue, worker }) => {
        const failures: string[] = [];
        const id = await queue.submit("p", "dana", { title: "raw idea", body: "plain body", evidence: [] });
        const job = await worker.waitForJob(
          await worker.enqueue("p", "groom", { taskId: id, submittedBy: "dana" }),
          JOB_WAIT_MS,
        );
        check(failures, job.status === "done", `job status: expected done, got ${job.status}`);
        const result = job.result ? JSON.parse(job.result) : {};
        check(failures, result.action === "accept", `expected accept, got ${JSON.stringify(result)}`);
        const state = (await queue.brief(id)).state;
        check(failures, state === "QUEUED", `task state: expected QUEUED, got ${state}`);
        const kinds = await decisionKinds(db);
        check(failures, kinds.includes("create"), `decision_log: expected 'create', got ${kinds}`);
        const roles = (await db.prepare("SELECT role FROM thread_messages ORDER BY id").all<{ role: string }>()).map(
          (r) => r.role,
        );
        check(failures, roles.includes("human") && roles.includes("mediator"), `thread should record human + mediator, got ${roles}`);
        return failures;
      }),
  },

  {
    name: "groom-merge-valid",
    exec: (driver) =>
      withHarness(driver, async ({ db, queue, worker }) => {
        const failures: string[] = [];
        const title = "Rate limit public API requests";
        const body = "Add a limiter for public API requests with a shared quota.";
        const target = await queue.submit("p", "dana", { title, body, evidence: [] });
        const dup = await queue.submit("p", "rui", { title, body: `Outcome: ${body}`, evidence: [] });
        const job = await worker.waitForJob(
          await worker.enqueue("p", "groom", { taskId: dup, submittedBy: "rui" }),
          JOB_WAIT_MS,
        );
        check(failures, job.status === "done", `job status: expected done, got ${job.status}`);
        const result = job.result ? JSON.parse(job.result) : {};
        check(failures, result.action === "merge" && result.into_task_id === target, `expected merge into ${target}, got ${JSON.stringify(result)}`);
        const ids = (await queue.status("p")).tasks.map((t) => t.id);
        check(failures, ids.includes(target) && !ids.includes(dup), `queue should keep ${target} and drop ${dup}, got ${ids}`);
        const kinds = await decisionKinds(db);
        check(failures, kinds.includes("merge"), `decision_log: expected 'merge', got ${kinds}`);
        return failures;
      }),
  },

  {
    name: "groom-clarify-flow",
    exec: (driver) =>
      withHarness(driver, async ({ db, queue, worker }) => {
        const failures: string[] = [];
        const clarifyBody = "CLARIFY: Which region should host it? Recommended: eu-west-1 — it matches the current deployment.";
        const id = await queue.submit("p", "dana", { title: "vague ask", body: clarifyBody, evidence: [] });
        const job = await worker.waitForJob(
          await worker.enqueue("p", "groom", { taskId: id, submittedBy: "dana" }),
          JOB_WAIT_MS,
        );
        check(failures, job.status === "done", `job status: expected done, got ${job.status}`);
        const result = job.result ? JSON.parse(job.result) : {};
        check(failures, result.action === "clarify", `expected clarify, got ${JSON.stringify(result)}`);
        const q = await db
          .prepare("SELECT question, status, asked_by FROM questions WHERE task_id=?")
          .get<{ question: string; status: string; asked_by: string }>(id);
        check(failures, q !== undefined && q.status === "open", `expected an open question row, got ${JSON.stringify(q)}`);
        check(failures, q?.asked_by === "mediator", `question asked_by: expected mediator, got ${q?.asked_by}`);
        const kinds = await decisionKinds(db);
        check(failures, kinds.includes("clarify"), `decision_log: expected 'clarify', got ${kinds}`);
        return failures;
      }),
  },

  {
    // Dedup + continue-the-conversation: a submission that grooms to a clarify
    // must not be forked by a resubmission of the same content, and answering
    // the clarify re-grooms the SAME task rather than minting a new one.
    name: "dedup-resubmission-of-clarify-pending",
    exec: (driver) =>
      withHarness(driver, async ({ db, queue, worker }) => {
        const failures: string[] = [];
        const clarifyBody = "CLARIFY: Which region should host it? Recommended: eu-west-1 — it matches the current deployment.";
        const id = await queue.submit("p", "dana", { title: "vague ask", body: clarifyBody, evidence: [] });
        const groom = await worker.waitForJob(
          await worker.enqueue("p", "groom", { taskId: id, submittedBy: "dana" }),
          JOB_WAIT_MS,
        );
        check(failures, groom.status === "done", `groom status: expected done, got ${groom.status}`);

        // A same-submitter, in-window resubmission of the same content is a
        // duplicate of the live task, carrying its pending clarification.
        const dup = await queue.findDuplicate("p", "dana", "vague ask", clarifyBody);
        check(failures, dup?.id === id, `findDuplicate: expected ${id}, got ${dup?.id}`);
        const pending = await queue.pendingMediatorQuestion(id);
        check(failures, pending !== null && /which region/i.test(pending.question), `pending clarify: got ${JSON.stringify(pending)}`);

        // A different submitter is not deduped — parallel reports stay distinct.
        check(failures, (await queue.findDuplicate("p", "rui", "vague ask", clarifyBody)) === null, "different submitter must not dedup");

        // Answering re-grooms the SAME submission; the re-groom sees the Q&A and admits it.
        await queue.answerQuestion(pending!.id, "eu-west-1", "dana");
        const regroom = await worker.waitForJob(
          await worker.enqueue("p", "groom", { taskId: id, submittedBy: "dana" }),
          JOB_WAIT_MS,
        );
        const result = regroom.result ? JSON.parse(regroom.result) : {};
        check(failures, result.action === "accept", `re-groom: expected accept, got ${JSON.stringify(result)}`);

        // Exactly one task exists — nothing forked.
        const ids = (await queue.status("p")).tasks.map((t) => t.id);
        check(failures, ids.length === 1 && ids[0] === id, `queue must hold only the original task, got ${ids}`);
        return failures;
      }),
  },

  {
    // Grooming excellence: a clear chore is accepted as-is — no clarify
    // nagging, no factual-intake gate, verification content preserved.
    name: "groom-accept-chore-untouched",
    exec: (driver) =>
      withHarness(driver, async ({ db, queue, worker }) => {
        const failures: string[] = [];
        const id = await queue.submit("p", "dana", {
          title: "chore: bump eslint 9.1 to 9.2",
          body: "Bump eslint from 9.1 to 9.2 in package.json. Changelog reviewed: no rule changes affect this repo. Verify with pnpm lint.",
          evidence: [],
        });
        const job = await worker.waitForJob(await worker.enqueue("p", "groom", { taskId: id, submittedBy: "dana" }), JOB_WAIT_MS);
        check(failures, job.status === "done", `job status: expected done, got ${job.status}`);
        const result = job.result ? JSON.parse(job.result) : {};
        check(failures, result.action === "accept", `chore must accept, got ${JSON.stringify(result)}`);
        const brief = await queue.brief(id);
        check(failures, brief.state === "QUEUED", `task state: expected QUEUED, got ${brief.state}`);
        check(failures, /pnpm lint/.test(brief.body), "chore body must keep its verification command");
        const open = await db.prepare("SELECT COUNT(*) AS n FROM questions WHERE task_id=?").get(id) as { n: number };
        check(failures, open.n === 0, `a chore must not be clarified — found ${open.n} question(s)`);
        return failures;
      }),
  },

  {
    // Grooming excellence: a well-evidenced submission is accepted without
    // questions — gaps the groomer can fill (pointers, priority) are inferred.
    name: "groom-infer-silently",
    exec: (driver) =>
      withHarness(driver, async ({ db, queue, worker }) => {
        const failures: string[] = [];
        const id = await queue.submit("p", "dana", {
          title: "CSV export mangles non-ASCII names in Excel",
          body: "Expected: exported CSV opens correctly in Excel. Actual: mojibake for names like Müller. Repro: export any list containing non-ASCII and open in Excel. Cause: UTF-8 served without a BOM (src/export/csv.ts). Fix direction: prepend the BOM and add a regression test.",
          evidence: [{ kind: "code", path: "src/export/csv.ts", lines: "8-11" }],
        });
        const job = await worker.waitForJob(await worker.enqueue("p", "groom", { taskId: id, submittedBy: "dana" }), JOB_WAIT_MS);
        check(failures, job.status === "done", `job status: expected done, got ${job.status}`);
        const result = job.result ? JSON.parse(job.result) : {};
        check(failures, result.action === "accept", `detailed submission must accept, got ${JSON.stringify(result)}`);
        const open = await db.prepare("SELECT COUNT(*) AS n FROM questions WHERE task_id=?").get(id) as { n: number };
        check(failures, open.n === 0, `inferable gaps must not be asked back — found ${open.n} question(s)`);
        return failures;
      }),
  },

  {
    // Agentic default (#51): a borderline feature with an inferable gap — a
    // concrete deliverable naming a real module, but no explicit file pointer
    // or priority — is ACCEPTED with the groomer's inferences as stated
    // assumptions, not clarified. The gap (pointer/priority) is greppable, so
    // asking it back would be over-clarification.
    name: "groom-borderline-inferable-gap-accepts",
    exec: (driver) =>
      withHarness(driver, async ({ db, queue, worker }) => {
        const failures: string[] = [];
        const id = await queue.submit("p", "dana", {
          title: "Add a CSV export button to the reports page",
          body: "Members want to download the reports table as CSV. The reports table already renders from the reports module; add an export action that serializes the current rows to a downloadable CSV.",
          evidence: [],
        });
        const job = await worker.waitForJob(await worker.enqueue("p", "groom", { taskId: id, submittedBy: "dana" }), JOB_WAIT_MS);
        check(failures, job.status === "done", `job status: expected done, got ${job.status}`);
        const result = job.result ? JSON.parse(job.result) : {};
        check(failures, result.action === "accept", `borderline feature with an inferable gap must accept, got ${JSON.stringify(result)}`);
        check(failures, (await queue.brief(id)).state === "QUEUED", "accepted task must be QUEUED");
        const open = await db.prepare("SELECT COUNT(*) AS n FROM questions WHERE task_id=?").get(id) as { n: number };
        check(failures, open.n === 0, `an inferable gap (pointer/priority) must not be clarified — found ${open.n} question(s)`);
        return failures;
      }),
  },

  {
    // Grooming excellence: a vague feature yields exactly one grounded
    // decision question with a recommended answer.
    name: "groom-askback-vague-feature",
    exec: (driver) =>
      withHarness(driver, async ({ db, queue, worker }) => {
        const failures: string[] = [];
        const id = await queue.submit("p", "dana", {
          title: "Add an AI assistant",
          body: "CLARIFY: Which surface should the assistant live in — dashboard, CLI, or editor plugin? Recommended: dashboard — it is the existing human-facing surface.",
          evidence: [],
        });
        const job = await worker.waitForJob(await worker.enqueue("p", "groom", { taskId: id, submittedBy: "dana" }), JOB_WAIT_MS);
        check(failures, job.status === "done", `job status: expected done, got ${job.status}`);
        const result = job.result ? JSON.parse(job.result) : {};
        check(failures, result.action === "clarify", `vague feature must clarify, got ${JSON.stringify(result)}`);
        const q = await db.prepare("SELECT question FROM questions WHERE task_id=? AND asked_by='mediator' AND status='open'").get(id) as
          | { question: string }
          | undefined;
        check(failures, q !== undefined, "clarify must open a mediator question");
        const questionMarks = (q?.question.match(/\?/g) ?? []).length;
        check(failures, questionMarks === 1, `exactly one question is allowed per round, got ${questionMarks}`);
        check(failures, /Recommended:/.test(q?.question ?? ""), `question must carry a recommended answer, got: ${q?.question}`);
        return failures;
      }),
  },

  {
    // A concrete feature is not gated on research/library intake homework.
    // The mediator self-serves those factual implementation choices.
    name: "groom-feature-fact-gap-self-served",
    exec: (driver) =>
      withHarness(driver, async ({ db, queue, worker }) => {
        const failures: string[] = [];
        const id = await queue.submit("p", "dana", {
          title: "Add realtime collaborative editing",
          body: "FEATURE: add realtime collaborative editing to shared notes so two members can type in the same note simultaneously.",
          evidence: [],
        });
        const job = await worker.waitForJob(await worker.enqueue("p", "groom", { taskId: id, submittedBy: "dana" }), JOB_WAIT_MS);
        check(failures, job.status === "done", `job status: expected done, got ${job.status}`);
        const result = job.result ? JSON.parse(job.result) : {};
        check(failures, result.action === "accept", `concrete feature must accept, got ${JSON.stringify(result)}`);
        const open = await db.prepare("SELECT COUNT(*) AS n FROM questions WHERE task_id=?").get(id) as { n: number };
        check(failures, open.n === 0, `self-served fact gap must not open a question, got ${open.n}`);
        const body = (await queue.brief(id)).body;
        check(failures, /self-serve factual implementation choices/i.test(body), `accepted brief must record the self-served posture, got: ${body}`);
        return failures;
      }),
  },

  {
    // Research evidence remains useful context: the feature accepts and the
    // groomed body carries the ordered agent-ready brief fields.
    name: "groom-feature-with-research-accepts",
    exec: (driver) =>
      withHarness(driver, async ({ db, queue, worker }) => {
        const failures: string[] = [];
        const id = await queue.submit("p", "dana", {
          title: "Add realtime collaborative editing",
          body: "FEATURE: add realtime collaborative editing to shared notes so two members can type in the same note simultaneously.",
          evidence: [{ kind: "research", note: "compared yjs vs automerge vs OT: yjs wins on ecosystem and CRDT maturity" }],
        });
        const job = await worker.waitForJob(await worker.enqueue("p", "groom", { taskId: id, submittedBy: "dana" }), JOB_WAIT_MS);
        check(failures, job.status === "done", `job status: expected done, got ${job.status}`);
        const result = job.result ? JSON.parse(job.result) : {};
        check(failures, result.action === "accept", `researched feature must accept, got ${JSON.stringify(result)}`);
        const body = (await queue.brief(id)).body;
        const fields = ["Outcome", "Evidence", "Pointers", "Acceptance criteria", "Verification", "Out-of-scope", "Constraints"];
        const positions = fields.map((f) => body.indexOf(f));
        for (const [i, pos] of positions.entries()) {
          check(failures, pos !== -1, `groomed body missing brief field "${fields[i]}"`);
        }
        check(
          failures,
          positions.every((p, i) => i === 0 || p === -1 || positions[i - 1] === -1 || p > positions[i - 1]),
          `brief fields out of order in groomed body:\n${body}`,
        );
        const open = await db.prepare("SELECT COUNT(*) AS n FROM questions WHERE task_id=?").get(id) as { n: number };
        check(failures, open.n === 0, "researched feature must not be gated");
        return failures;
      }),
  },

  {
    // Bug fixes are never gated on factual implementation homework.
    name: "groom-bugfix-never-gated",
    exec: (driver) =>
      withHarness(driver, async ({ db, queue, worker }) => {
        const failures: string[] = [];
        const id = await queue.submit("p", "dana", {
          title: "OAuth login loops when the state cookie is missing",
          body: "Expected: callback validates state and signs the user in. Actual: browsers blocking third-party cookies drop the state cookie and the flow restarts forever. Repro: block third-party cookies, sign in with Google. Fix direction: SameSite=Lax on the state cookie (src/auth/oauth.ts:44).",
          evidence: [{ kind: "log", snippet: "WARN auth oauth callback missing state cookie, restarting flow" }],
        });
        const job = await worker.waitForJob(await worker.enqueue("p", "groom", { taskId: id, submittedBy: "dana" }), JOB_WAIT_MS);
        check(failures, job.status === "done", `job status: expected done, got ${job.status}`);
        const result = job.result ? JSON.parse(job.result) : {};
        check(failures, result.action === "accept", `bug fix must never hit a factual-intake gate, got ${JSON.stringify(result)}`);
        const open = await db.prepare("SELECT COUNT(*) AS n FROM questions WHERE task_id=?").get(id) as { n: number };
        check(failures, open.n === 0, `bug fix with repro must not be clarified — found ${open.n} question(s)`);
        return failures;
      }),
  },

  {
    // Groom guard: the driver tried to admit a research-only submission; the
    // pipeline bounces it to a clarify (research is a human precondition).
    name: "groom-guard-research-only-bounces",
    exec: () =>
      withHarness(
        scriptedGroomDriver((_ctx, s) => ({ action: "accept", title: s.title, body: s.body, priority: s.priority, rationale: "model wrongly accepted" })),
        async ({ db, queue, worker }) => {
          const failures: string[] = [];
          const id = await queue.submit("p", "dana", { title: "Research rate-limiter strategies", body: "Survey token-bucket vs leaky-bucket and report findings.", evidence: [] });
          const job = await worker.waitForJob(await worker.enqueue("p", "groom", { taskId: id, submittedBy: "dana" }), JOB_WAIT_MS);
          check(failures, job.status === "done", `job status: expected done, got ${job.status}`);
          const result = job.result ? JSON.parse(job.result) : {};
          check(failures, result.action === "clarify", `research-only must bounce to clarify, got ${JSON.stringify(result)}`);
          const q = await db.prepare("SELECT question, asked_by, status FROM questions WHERE task_id=?").get<{ question: string; asked_by: string; status: string }>(id);
          check(failures, q?.asked_by === "mediator" && q?.status === "open", `bounce must open a mediator question, got ${JSON.stringify(q)}`);
          check(failures, /research/i.test(q?.question ?? ""), `bounce must name the research hold, got: ${q?.question}`);
          check(failures, (await queue.brief(id)).state === "BLOCKED", "task stays BLOCKED while its clarification is open");
          return failures;
        },
      ),
  },

  {
    // Guard exemption: "investigate then fix" names an implementation change,
    // so the guard stays silent and the accept survives.
    name: "groom-guard-research-then-fix-accepts",
    exec: () =>
      withHarness(
        scriptedGroomDriver((_ctx, s) => ({ action: "accept", title: s.title, body: s.body, priority: s.priority, rationale: "actionable" })),
        async ({ db, queue, worker }) => {
          const failures: string[] = [];
          const id = await queue.submit("p", "dana", { title: "Investigate then fix the flaky upload test", body: "Investigate the flake, then fix the race in the upload retry.", evidence: [] });
          const job = await worker.waitForJob(await worker.enqueue("p", "groom", { taskId: id, submittedBy: "dana" }), JOB_WAIT_MS);
          const result = job.result ? JSON.parse(job.result) : {};
          check(failures, result.action === "accept", `investigate-then-fix must accept, got ${JSON.stringify(result)}`);
          const open = (await db.prepare("SELECT COUNT(*) AS n FROM questions WHERE task_id=?").get<{ n: number }>(id)) as { n: number };
          check(failures, open.n === 0, `must not bounce an implementation task — found ${open.n} question(s)`);
          return failures;
        },
      ),
  },

  {
    // Groom guard: a held-scope submission (the #39 better-auth shape) is
    // bounced even though the model accepted it; held topics come from memory.
    name: "groom-guard-held-scope-bounces",
    exec: () =>
      withHarness(
        scriptedGroomDriver((_ctx, s) => ({ action: "accept", title: s.title, body: s.body, priority: s.priority, rationale: "model wrongly accepted" })),
        async ({ db, queue, worker }) => {
          const failures: string[] = [];
          const memory = new MemoryStore(db);
          await memory.upsert("p", { path: "conventions/held-scope.md", type: "Convention", title: "Held scope", description: "on hold", tags: ["hold"], body: "- auth\n- phase-D" });
          const id = await queue.submit("p", "andrew", { title: "Research and integrate better-auth", body: "Add better-auth for OAuth login.", evidence: [] });
          const job = await worker.waitForJob(await worker.enqueue("p", "groom", { taskId: id, submittedBy: "andrew" }), JOB_WAIT_MS);
          const result = job.result ? JSON.parse(job.result) : {};
          check(failures, result.action === "clarify", `held-scope must bounce to clarify, got ${JSON.stringify(result)}`);
          const q = await db.prepare("SELECT question FROM questions WHERE task_id=?").get<{ question: string }>(id);
          check(failures, /held|hold/i.test(q?.question ?? ""), `bounce must name the hold, got: ${q?.question}`);
          check(failures, (await queue.brief(id)).state === "BLOCKED", "held submission stays BLOCKED, not merged/executed");
          return failures;
        },
      ),
  },

  {
    // Guard exemption: a normal fix in a held area (auth) passes through — the
    // hold gates new feature/research work, not bug fixes.
    name: "groom-guard-held-scope-fix-passes-through",
    exec: () =>
      withHarness(
        scriptedGroomDriver((_ctx, s) => ({ action: "accept", title: s.title, body: s.body, priority: s.priority, rationale: "clear fix" })),
        async ({ db, queue, worker }) => {
          const failures: string[] = [];
          const memory = new MemoryStore(db);
          await memory.upsert("p", { path: "conventions/held-scope.md", type: "Convention", title: "Held scope", description: "on hold", tags: ["hold"], body: "- auth" });
          const id = await queue.submit("p", "dana", { title: "fix: auth session cookie dropped on refresh", body: "Expected: session persists across refresh. Actual: cookie cleared. Repro: refresh while signed in.", evidence: [] });
          const job = await worker.waitForJob(await worker.enqueue("p", "groom", { taskId: id, submittedBy: "dana" }), JOB_WAIT_MS);
          const result = job.result ? JSON.parse(job.result) : {};
          check(failures, result.action === "accept", `a fix in held scope must accept, got ${JSON.stringify(result)}`);
          const open = (await db.prepare("SELECT COUNT(*) AS n FROM questions WHERE task_id=?").get<{ n: number }>(id)) as { n: number };
          check(failures, open.n === 0, `held-scope fix must not be bounced — found ${open.n} question(s)`);
          return failures;
        },
      ),
  },

  {
    // Groom guard: the model's best merge target is a DONE task; the pipeline
    // falls back to accept and leaves the shipped task untouched (#39/#29).
    name: "groom-guard-merge-into-DONE-falls-back",
    exec: () =>
      withHarness(
        scriptedGroomDriver((_ctx, s) => ({ action: "merge", into_task_id: s.taskId - 1, rationale: "dup of the shipped task" })),
        async ({ db, queue, worker }) => {
          const failures: string[] = [];
          const done = await queue.submit("p", "dana", { title: "shipped work", body: "b", evidence: [] });
          await db.prepare("UPDATE tasks SET state='DONE' WHERE id=?").run(done);
          const dup = await queue.submit("p", "rui", { title: "same as shipped", body: "plain body", evidence: [] });
          const job = await worker.waitForJob(await worker.enqueue("p", "groom", { taskId: dup, submittedBy: "rui" }), JOB_WAIT_MS);
          check(failures, job.status === "done", `job status: expected done, got ${job.status}`);
          const result = job.result ? JSON.parse(job.result) : {};
          check(failures, result.action === "accept", `merge into DONE must fall back to accept, got ${JSON.stringify(result)}`);
          check(failures, (await queue.brief(dup)).state === "QUEUED", "the new submission stays QUEUED as its own task");
          check(
            failures,
            /deterministic merge safety refused \d+ \(target_not_mergeable\)/.test(
              (await queue.brief(dup)).grooming_rationale ?? "",
            ),
            "fallback must log the deterministic target refusal",
          );
          const doneState = (await db.prepare("SELECT state FROM tasks WHERE id=?").get<{ state: string }>(done))?.state;
          check(failures, doneState === "DONE", `DONE task must be untouched, got ${doneState}`);
          const kinds = await decisionKinds(db);
          check(failures, !kinds.includes("merge"), `no 'merge' decision may be logged for a DONE target, got ${kinds}`);
          return failures;
        },
      ),
  },

  {
    name: "review-approve",
    exec: (driver) =>
      withHarness(driver, async ({ db, queue, worker }) => {
        const failures: string[] = [];
        const id = await queue.submit("p", "dana", { title: "t", body: "b", evidence: [] });
        await queue.claimNext("p", "cc-1", DEFAULT_LEASE_TTL_MS);
        const plan = "1. failing test. 2. fix. 3. run the suite.";
        const job = await worker.waitForJob(
          await worker.enqueue("p", "review", { taskId: id, plan, agent: "cc-1" }),
          JOB_WAIT_MS,
        );
        check(failures, job.status === "done", `job status: expected done, got ${job.status}`);
        const result = job.result ? JSON.parse(job.result) : {};
        check(failures, result.verdict === "approved", `expected approved, got ${JSON.stringify(result)}`);
        const brief = await queue.brief(id);
        check(failures, brief.state === "PLANNED", `task state: expected PLANNED, got ${brief.state}`);
        check(failures, brief.plan === plan, "approval must store the coder's plan verbatim");
        check(failures, brief.plan_deadline === null, "approval must close the plan window");
        const kinds = await decisionKinds(db);
        check(failures, kinds.includes("approve"), `decision_log: expected 'approve', got ${kinds}`);
        return failures;
      }),
  },

  {
    name: "review-revise",
    exec: (driver) =>
      withHarness(driver, async ({ db, queue, worker }) => {
        const failures: string[] = [];
        const id = await queue.submit("p", "dana", { title: "t", body: "b", evidence: [] });
        await queue.claimNext("p", "cc-1", DEFAULT_LEASE_TTL_MS);
        const job = await worker.waitForJob(
          await worker.enqueue("p", "review", { taskId: id, plan: "a bad plan", agent: "cc-1" }),
          JOB_WAIT_MS,
        );
        check(failures, job.status === "done", `job status: expected done, got ${job.status}`);
        const result = job.result ? JSON.parse(job.result) : {};
        check(failures, result.verdict === "revise", `expected revise, got ${JSON.stringify(result)}`);
        check(failures, typeof result.feedback === "string" && result.feedback.length > 0, "revise must carry feedback for the coder");
        const state = (await queue.brief(id)).state;
        check(failures, state === "CLAIMED", `task must stay CLAIMED on revise, got ${state}`);
        const kinds = await decisionKinds(db);
        check(failures, kinds.includes("revise"), `decision_log: expected 'revise', got ${kinds}`);
        return failures;
      }),
  },

  {
    name: "answer-direct",
    exec: (driver) =>
      withHarness(driver, async ({ db, queue, worker }) => {
        const failures: string[] = [];
        const id = await queue.submit("p", "dana", { title: "t", body: "b", evidence: [] });
        await queue.claimNext("p", "cc-1", DEFAULT_LEASE_TTL_MS);
        const job = await worker.waitForJob(
          await worker.enqueue("p", "answer", { taskId: id, question: "which port?", agent: "cc-1" }),
          JOB_WAIT_MS,
        );
        check(failures, job.status === "done", `job status: expected done, got ${job.status}`);
        const result = job.result ? JSON.parse(job.result) : {};
        check(failures, result.escalated === false, `expected escalated:false, got ${JSON.stringify(result)}`);
        check(failures, typeof result.answer === "string" && result.answer.length > 0, "answer must be non-empty");
        const kinds = await decisionKinds(db);
        check(failures, kinds.includes("answer"), `decision_log: expected 'answer', got ${kinds}`);
        const open = (await db.prepare("SELECT COUNT(*) AS n FROM questions WHERE status='open'").get<{ n: number }>()) as { n: number };
        check(failures, open.n === 0, "a direct answer must not open a human question");
        return failures;
      }),
  },

  {
    name: "answer-recalls-and-cites-stored-plan",
    exec: () => {
      let sourceTaskId = 0;
      const driver = scriptedAnswerDriver(async (ctx) => {
        const grep = (await ctx.tools!.dispatch("plan_grep", { query: "decorrelated jitter" })) as {
          matches: Array<{ task_id: number }>;
        };
        const found = grep.matches[0]?.task_id;
        const read = (await ctx.tools!.dispatch("plan_read", { taskId: found })) as { plan?: string };
        return {
          escalate: false,
          answer: `Retries use decorrelated jitter because the approved plan avoids synchronized clients. PLAN-${found}`,
          rationale: `plan search returned ${found}; ${read.plan ?? "missing plan"}`,
        };
      });
      return withHarness(driver, async ({ db, queue, worker }) => {
        const failures: string[] = [];
        sourceTaskId = await queue.submit("p", "dana", { title: "Choose retry policy", body: "b", evidence: [] });
        await db.prepare("UPDATE tasks SET plan=?, state='DONE' WHERE id=?").run(
          "Use decorrelated jitter so clients do not retry in lockstep.",
          sourceTaskId,
        );
        const askingTaskId = await queue.submit("p", "dana", { title: "Apply retry policy", body: "b", evidence: [] });
        await queue.claimNext("p", "cc-1", DEFAULT_LEASE_TTL_MS);
        const job = await worker.waitForJob(
          await worker.enqueue("p", "answer", { taskId: askingTaskId, question: "why was retry jitter done this way?", agent: "cc-1" }),
          JOB_WAIT_MS,
        );
        check(failures, job.status === "done", `job status: expected done, got ${job.status}`);
        const result = job.result ? JSON.parse(job.result) : {};
        check(failures, result.answer?.includes("decorrelated jitter"), `answer must surface plan content: ${JSON.stringify(result)}`);
        check(failures, result.answer?.includes(`PLAN-${sourceTaskId}`), `answer must cite PLAN-${sourceTaskId}`);
        check(
          failures,
          result.references?.some((ref: { label: string; url: string }) =>
            ref.label === `plan for task #${sourceTaskId}` && ref.url.endsWith(`?project=p&task=${sourceTaskId}#plan`)),
          `answer must include the server-minted plan deep link: ${JSON.stringify(result.references)}`,
        );
        return failures;
      });
    },
  },

  {
    name: "answer-escalate",
    exec: (driver) =>
      withHarness(driver, async ({ db, queue, worker }) => {
        const failures: string[] = [];
        const id = await queue.submit("p", "dana", { title: "t", body: "b", evidence: [] });
        await queue.claimNext("p", "cc-1", DEFAULT_LEASE_TTL_MS);
        const question = "please escalate this to the humans";
        const job = await worker.waitForJob(
          await worker.enqueue("p", "answer", { taskId: id, question, agent: "cc-1" }),
          JOB_WAIT_MS,
        );
        check(failures, job.status === "done", `job status: expected done, got ${job.status}`);
        const result = job.result ? JSON.parse(job.result) : {};
        check(failures, result.escalated === true, `expected escalated:true, got ${JSON.stringify(result)}`);
        const q = await db
          .prepare("SELECT asked_by, status FROM questions WHERE task_id=?")
          .get<{ asked_by: string; status: string }>(id);
        check(failures, q?.asked_by === "cc-1" && q?.status === "open", `escalation must open the coder's question for humans, got ${JSON.stringify(q)}`);
        const kinds = await decisionKinds(db);
        check(failures, kinds.includes("escalate"), `decision_log: expected 'escalate', got ${kinds}`);
        return failures;
      }),
  },

  {
    // Historian: the discuss context must carry the completed-task window (with
    // PR) and the server clock, so meta-Q&A is grounded in real records + time.
    name: "historian-context-carries-completed-and-clock",
    exec: () => {
      let seen: MediatorContext | undefined;
      const driver = scriptedDiscussDriver((ctx) => {
        seen = ctx;
        return { reply: "noted", actions: [], rationale: "record only" };
      });
      return withHarness(driver, async ({ db, worker }) => {
        const failures: string[] = [];
        const id = 1;
        const now = Date.now();
        await db
          .prepare(
            "INSERT INTO tasks (id, project_id, title, body, state, submitted_by, result_summary, result_pr_url, result_pr_number, created_at, updated_at) VALUES (?, 'p', 'fix login loop', 'b', 'DONE', 'dana', 'shipped SameSite fix', 'https://github.com/o/r/pull/12', 12, ?, ?)",
          )
          .run(id, now, now);
        const job = await worker.waitForJob(
          await worker.enqueue("p", "discuss", { message: "what got fixed recently?", from: "dana" }),
          JOB_WAIT_MS,
        );
        check(failures, job.status === "done", `job status: expected done, got ${job.status}`);
        check(failures, seen?.now?.now_iso !== undefined, "context must carry the server clock now_iso");
        check(failures, seen?.now?.timezone !== undefined, "context must carry the server timezone");
        const completed = seen?.completed ?? [];
        check(failures, completed.some((c) => c.id === id && c.result_pr_url?.includes("pull/12")), `completed window must include DONE task ${id} with its PR, got ${JSON.stringify(completed)}`);
        return failures;
      });
    },
  },

  {
    // Historian: a BLOCKED task and its reason must reach the context — the
    // discuss brain answers "what's blocked and why" from records, not guesses.
    name: "historian-blocked-in-context",
    exec: () => {
      let seen: MediatorContext | undefined;
      const driver = scriptedDiscussDriver((ctx) => {
        seen = ctx;
        return { reply: "noted", actions: [], rationale: "record only" };
      });
      return withHarness(driver, async ({ queue, worker }) => {
        const failures: string[] = [];
        const id = await queue.submit("p", "dana", { title: "migrate db", body: "b", evidence: [] });
        await queue.claimNext("p", "cc-1", DEFAULT_LEASE_TTL_MS);
        await queue.block(id, "cc-1", "needs prod credentials");
        const job = await worker.waitForJob(
          await worker.enqueue("p", "discuss", { message: "what's blocked and why?", from: "dana" }),
          JOB_WAIT_MS,
        );
        check(failures, job.status === "done", `job status: expected done, got ${job.status}`);
        check(failures, (seen?.queue ?? []).some((t) => t.id === id && t.state === "BLOCKED"), `blocked task ${id} must appear in the open-tasks context, got ${JSON.stringify(seen?.queue)}`);
        const activity = seen?.activity ?? [];
        check(failures, activity.some((a) => a.task_id === id && a.outcome === "blocked" && /prod credentials/.test(a.notes ?? "")), `agent activity must carry the block reason, got ${JSON.stringify(activity)}`);
        return failures;
      });
    },
  },

  {
    // Historian grounding: an id the model cites that no supplied record backs
    // is blanked; a real cited id survives. (Anthropic Citations post-validate.)
    name: "historian-strips-uncited-id",
    exec: () => {
      const driver = scriptedDiscussDriver((ctx) => {
        const real = (ctx.completed ?? [])[0]?.id;
        return {
          // Cites one real completed task (#real) plus an invented DEC-999 and #777.
          reply: `Fixed in #${real}. See DEC-999 and task #777 for context.`,
          actions: [],
          rationale: "mixes grounded and invented ids",
        };
      });
      return withHarness(driver, async ({ db, worker }) => {
        const failures: string[] = [];
        const id = 5;
        const now = Date.now();
        await db
          .prepare(
            "INSERT INTO tasks (id, project_id, title, body, state, submitted_by, result_summary, result_pr_url, result_pr_number, created_at, updated_at) VALUES (?, 'p', 'done thing', 'b', 'DONE', 'dana', 's', 'https://x/pull/3', 3, ?, ?)",
          )
          .run(id, now, now);
        const job = await worker.waitForJob(
          await worker.enqueue("p", "discuss", { message: "what got fixed?", from: "dana" }),
          JOB_WAIT_MS,
        );
        check(failures, job.status === "done", `job status: expected done, got ${job.status}`);
        const reply = job.result ? (JSON.parse(job.result) as { reply: string }).reply : "";
        check(failures, reply.includes(`#${id}`), `real cited id #${id} must survive, got: ${reply}`);
        check(failures, !/DEC-999/.test(reply), `invented DEC-999 must be blanked, got: ${reply}`);
        check(failures, !/#777/.test(reply), `invented #777 must be blanked, got: ${reply}`);
        return failures;
      });
    },
  },

  {
    // Historian honesty: a question no record answers gets an honest "no record",
    // no actions, no decision — the brain refuses to invent rather than confabulate.
    name: "historian-no-record-honest",
    exec: () => {
      const driver = scriptedDiscussDriver(() => ({
        reply: "no record of that in the window.",
        actions: [],
        rationale: "nothing in context supports an answer",
      }));
      return withHarness(driver, async ({ db, worker }) => {
        const failures: string[] = [];
        const job = await worker.waitForJob(
          await worker.enqueue("p", "discuss", { message: "what did we decide about billing?", from: "dana" }),
          JOB_WAIT_MS,
        );
        check(failures, job.status === "done", `job status: expected done, got ${job.status}`);
        const result = job.result ? JSON.parse(job.result) : {};
        check(failures, /no record/.test(result.reply ?? ""), `honest reply must survive, got: ${JSON.stringify(result)}`);
        check(failures, Array.isArray(result.applied) && result.applied.length === 0, "no actions may be applied for a no-record answer");
        const kinds = await decisionKinds(db);
        check(failures, kinds.length === 0, `no decision may be logged for a pure question, got ${kinds}`);
        return failures;
      });
    },
  },

  {
    name: "answer-steward-close-own-task",
    exec: (driver) =>
      withHarness(driver, async ({ db, queue, worker }) => {
        const failures: string[] = [];
        const id = await queue.submit("p", "dana", { title: "wrong premise", body: "b", evidence: [] });
        await queue.claimNext("p", "cc-1", DEFAULT_LEASE_TTL_MS);
        const job = await worker.waitForJob(
          await worker.enqueue("p", "answer", { taskId: id, question: `close task ${id}: premise is wrong`, agent: "cc-1" }),
          JOB_WAIT_MS,
        );
        check(failures, job.status === "done", `job status: expected done, got ${job.status}`);
        const result = job.result ? JSON.parse(job.result) : {};
        check(
          failures,
          Array.isArray(result.applied) && result.applied.some((a: { action: string; task_id: number }) => a.action === "close_task" && a.task_id === id),
          `expected close_task ${id} applied (own-task exemption), got ${JSON.stringify(result)}`,
        );
        const row = (await db
          .prepare("SELECT state, lease_agent FROM tasks WHERE id=?")
          .get<{ state: string; lease_agent: string | null }>(id)) as { state: string; lease_agent: string | null };
        check(failures, row.state === "DONE", `task state: expected DONE, got ${row.state}`);
        check(failures, row.lease_agent === null, "closing a leased task must release the lease");
        return failures;
      }),
  },
];

export interface RunPipelineEvalOptions {
  /** Override the golden suite (used by scoring unit tests). */
  fixtures?: PipelineFixture[];
}

export async function runPipelineEval(
  driverFactory: () => MediatorDriver,
  opts: RunPipelineEvalOptions = {},
): Promise<PipelineScorecard> {
  const fixtures = opts.fixtures ?? pipelineFixtures;
  const perCase: PipelineCaseResult[] = [];
  // Serial on purpose: each fixture owns a worker + sqlite handle; parallelism
  // buys nothing here and muddies latency attribution.
  for (const f of fixtures) {
    const start = performance.now();
    let failures: string[];
    try {
      failures = await f.exec(driverFactory());
    } catch (err) {
      failures = [`fixture crashed: ${err instanceof Error ? err.message : String(err)}`];
    }
    perCase.push({ name: f.name, ok: failures.length === 0, failures, ms: performance.now() - start });
  }
  const failed = perCase.filter((c) => !c.ok).length;
  return { passed: perCase.length - failed, failed, perCase };
}
