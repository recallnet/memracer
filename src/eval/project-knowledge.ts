import { openDb, type Db } from "../db.js";
import type {
  MediatorContext,
  ProjectKnowledgeRefreshInput,
  ProjectKnowledgeRefreshResult,
} from "../mediator/driver.js";
import { FakeDriver } from "../mediator/fake.js";
import { MemoryStore } from "../mediator/memory.js";
import { registerPipelines } from "../mediator/pipelines.js";
import {
  PROJECT_KNOWLEDGE_DOMAINS,
  ProjectKnowledgeState,
  type ProjectKnowledgeCandidate,
  type ProjectKnowledgeDomain,
  type ProjectKnowledgeTrigger,
} from "../mediator/project-knowledge.js";
import { MediatorWorker, type JobRow } from "../mediator/worker.js";
import { Queue } from "../queue.js";

export const PROJECT_KNOWLEDGE_MUTATIONS = [
  "fixed-ordering",
  "drop-answer-routing",
  "reverse-oldest",
  "unbound-channel",
] as const;

export type ProjectKnowledgeMutation = (typeof PROJECT_KNOWLEDGE_MUTATIONS)[number];

export interface ProjectKnowledgeCaseResult {
  name: string;
  ok: boolean;
  failures: string[];
  observations: Record<string, unknown>;
}

export interface ProjectKnowledgeScorecard {
  domainCount: number;
  cases: number;
  failed: number;
  mutations: ProjectKnowledgeMutation[];
  perCase: ProjectKnowledgeCaseResult[];
}

export interface ProjectKnowledgeEvalOptions {
  mutations?: ProjectKnowledgeMutation[];
}

interface DomainState {
  domain: ProjectKnowledgeDomain;
  last_refreshed_at: number | null;
  last_checked_at: number | null;
  requested_generation: number;
  applied_generation: number;
}

interface EvalHarness {
  db: Db;
  queue: Queue;
  worker: MediatorWorker;
  state: ProjectKnowledgeState;
  memory: MemoryStore;
  driver: ProjectKnowledgeEvalDriver;
  projectId: string;
}

const DAY_MS = 86_400_000;
const PROJECT_ID = "project-knowledge-eval";

function domainIndex(domain: ProjectKnowledgeDomain): number {
  return PROJECT_KNOWLEDGE_DOMAINS.findIndex((definition) => definition.id === domain);
}

function candidateAge(candidate: ProjectKnowledgeCandidate): number {
  return candidate.last_refreshed_at ?? Number.NEGATIVE_INFINITY;
}

function contextText(ctx: MediatorContext, input: ProjectKnowledgeRefreshInput): string {
  return [
    ctx.projectName,
    input.repo ?? "",
    ...ctx.queue.map((task) => task.title),
    ...ctx.decisions.flatMap((decision) => [decision.summary, decision.rationale]),
    ...(ctx.completed ?? []).flatMap((task) => [task.title, task.result_summary ?? ""]),
    ...input.candidates.flatMap((candidate) => candidate.reasons),
  ].join("\n").toLowerCase();
}

function relevance(candidate: ProjectKnowledgeCandidate, text: string): number {
  const definition = PROJECT_KNOWLEDGE_DOMAINS.find((domain) => domain.id === candidate.domain)!;
  return definition.signals.reduce((score, signal) => score + (text.includes(signal) ? 1 : 0), 0);
}

function matchesFrom(result: unknown): Array<{ path: string }> {
  if (!result || typeof result !== "object" || !("matches" in result)) return [];
  const matches = (result as { matches?: unknown }).matches;
  if (!Array.isArray(matches)) return [];
  return matches.filter(
    (match): match is { path: string } =>
      typeof match === "object" && match !== null && "path" in match && typeof match.path === "string",
  );
}

/**
 * A deterministic policy stand-in executed by the production refresh handler.
 * Mutations weaken one behavior at a time; the grader never inspects this
 * driver's source or prompt strings, only the resulting durable state.
 */
class ProjectKnowledgeEvalDriver extends FakeDriver {
  readonly toolNames: string[] = [];

  constructor(private readonly mutations: ReadonlySet<ProjectKnowledgeMutation>) {
    super();
  }

  private select(ctx: MediatorContext, input: ProjectKnowledgeRefreshInput): ProjectKnowledgeCandidate[] {
    const text = contextText(ctx, input);
    const candidates = [...input.candidates];
    if (this.mutations.has("fixed-ordering")) {
      candidates.sort((left, right) => domainIndex(left.domain) - domainIndex(right.domain));
    } else {
      candidates.sort((left, right) => {
        const leftAt = candidateAge(left);
        const rightAt = candidateAge(right);
        if (leftAt !== rightAt) {
          return this.mutations.has("reverse-oldest") ? rightAt - leftAt : leftAt - rightAt;
        }
        return relevance(right, text) - relevance(left, text) || domainIndex(left.domain) - domainIndex(right.domain);
      });
    }
    return candidates.slice(0, 3);
  }

  private async tool(ctx: MediatorContext, name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!ctx.tools) throw new Error("project-knowledge eval requires production scoped memory tools");
    this.toolNames.push(name);
    return ctx.tools.dispatch(name, args);
  }

  override async refreshProjectKnowledge(
    ctx: MediatorContext,
    input: ProjectKnowledgeRefreshInput,
  ): Promise<ProjectKnowledgeRefreshResult> {
    const selected = this.select(ctx, input);

    if (input.answer) {
      if (!this.mutations.has("drop-answer-routing")) {
        const grep = await this.tool(ctx, "okf_grep", { query: "release direction" });
        const path = matchesFrom(grep)[0]?.path;
        if (path) {
          await this.tool(ctx, "okf_read", { path });
          await this.tool(ctx, "okf_update", {
            path,
            body: [
              "# Direction",
              "",
              `Release direction: ${input.answer.answer}`,
              "",
              "# Citations",
              "",
              `Answered project question Q${input.answer.question_id}.`,
            ].join("\n"),
          });
        }
      }
      return {
        checked_domains: selected.map((candidate) => candidate.domain),
        questions: [],
        rationale: "applied the answered project context to durable memory",
      };
    }

    const humanOwnedGap = ctx.queue.some((task) => /human-owned/i.test(task.title));
    let questions = humanOwnedGap
      ? selected.map((candidate) => ({
          domain: candidate.domain,
          trigger: candidate.triggers[0]!,
          question: `${candidate.label}: which ${candidate.description.toLowerCase()} should remain authoritative?`,
        }))
      : [];
    if (this.mutations.has("unbound-channel") && questions.length > 0) {
      questions = questions.map((question, index) => index === 0
        ? { ...question, question: `${question.question} What else should change?` }
        : question);
    }
    return {
      checked_domains: selected.map((candidate) => candidate.domain),
      questions,
      rationale: humanOwnedGap
        ? "surfaced only consequential project-context gaps"
        : "current evidence was competent or defaultable, so no human question was warranted",
    };
  }
}

async function createHarness(mutations: ReadonlySet<ProjectKnowledgeMutation>, suffix: string): Promise<EvalHarness> {
  const db = openDb(":memory:");
  const projectId = `${PROJECT_ID}-${suffix}`;
  await db.prepare("INSERT INTO projects (id, name, repo) VALUES (?, ?, ?)")
    .run(projectId, "Project knowledge eval", "recallnet/eval-project");
  const queue = new Queue(db);
  const worker = new MediatorWorker(db, { tickMs: 5, jobTimeoutMs: 2_000 });
  const state = new ProjectKnowledgeState(db);
  const memory = new MemoryStore(db);
  const driver = new ProjectKnowledgeEvalDriver(mutations);
  registerPipelines({ db, queue, worker, driverFor: () => driver });
  await state.ensure(projectId);
  return { db, queue, worker, state, memory, driver, projectId };
}

async function stopHarness(harness: EvalHarness): Promise<void> {
  try {
    await harness.worker.stopAndWait();
  } finally {
    await harness.db.close();
  }
}

async function waitForRefresh(
  harness: EvalHarness,
  payload: Record<string, unknown> = { mode: "refresh" },
  allowFailedOutcome = false,
): Promise<JobRow> {
  const job = await harness.worker.waitForJob(
    await harness.worker.enqueue(harness.projectId, "refresh", payload),
    3_000,
  );
  if (job.status !== "done" && !allowFailedOutcome) {
    throw new Error(`project-knowledge refresh ${job.status}: ${job.error ?? "unknown error"}`);
  }
  return job;
}

async function states(harness: EvalHarness): Promise<DomainState[]> {
  return harness.db.prepare(
    `SELECT domain, last_refreshed_at, last_checked_at, requested_generation, applied_generation
       FROM project_context_domains WHERE project_id=? ORDER BY domain`,
  ).all<DomainState>(harness.projectId);
}

async function setAllFresh(harness: EvalHarness, now: number): Promise<void> {
  await harness.db.prepare(
    `UPDATE project_context_domains
        SET last_refreshed_at=?, last_checked_at=?, dirty_since=NULL, dirty_reason=NULL,
            requested_generation=0, applied_generation=0
      WHERE project_id=?`,
  ).run(now, now - 2 * DAY_MS, harness.projectId);
}

async function addContextTask(harness: EvalHarness, title: string): Promise<void> {
  await harness.queue.submit(harness.projectId, "eval", { title, body: "eval context", evidence: [] });
}

function changedDomains(before: DomainState[], after: DomainState[]): ProjectKnowledgeDomain[] {
  const prior = new Map(before.map((row) => [row.domain, row.last_checked_at]));
  return after
    .filter((row) => prior.get(row.domain) !== row.last_checked_at)
    .map((row) => row.domain);
}

function result(name: string, failures: string[], observations: Record<string, unknown>): ProjectKnowledgeCaseResult {
  return { name, ok: failures.length === 0, failures, observations };
}

async function equalAgeSelection(
  mutations: ReadonlySet<ProjectKnowledgeMutation>,
  suffix: string,
  taskTitle: string,
): Promise<{ selection: ProjectKnowledgeDomain[]; domainCount: number }> {
  const harness = await createHarness(mutations, suffix);
  try {
    const now = Date.now();
    await harness.db.prepare(
      `UPDATE project_context_domains
          SET last_refreshed_at=?, last_checked_at=?, requested_generation=0, applied_generation=0
        WHERE project_id=?`,
    ).run(now - 200 * DAY_MS, now - 2 * DAY_MS, harness.projectId);
    await addContextTask(harness, taskTitle);
    const before = await states(harness);
    await waitForRefresh(harness);
    const after = await states(harness);
    return { selection: changedDomains(before, after), domainCount: after.length };
  } finally {
    await stopHarness(harness);
  }
}

async function adaptiveCase(mutations: ReadonlySet<ProjectKnowledgeMutation>): Promise<{
  result: ProjectKnowledgeCaseResult;
  domainCount: number;
}> {
  const architecture = await equalAgeSelection(
    mutations,
    "adaptive-architecture",
    "Architecture repository service component technology and data flow are current",
  );
  const team = await equalAgeSelection(
    mutations,
    "adaptive-team",
    "Team people members owners expertise roles collaboration and handoffs are current",
  );
  const failures: string[] = [];
  if (architecture.domainCount !== 10 || team.domainCount !== 10 || PROJECT_KNOWLEDGE_DOMAINS.length !== 10) {
    failures.push(`expected exactly 10 persisted domains; observed ${architecture.domainCount} and ${team.domainCount}`);
  }
  if (!architecture.selection.includes("architecture-tech")) {
    failures.push(`architecture context did not select architecture-tech: ${architecture.selection.join(", ")}`);
  }
  if (!team.selection.includes("team-people") || !team.selection.includes("roles-collaboration")) {
    failures.push(`team context did not select team/role domains: ${team.selection.join(", ")}`);
  }
  if (architecture.selection.join("|") === team.selection.join("|")) {
    failures.push("equal-age selection stayed fixed instead of adapting to current context");
  }
  return {
    domainCount: architecture.domainCount,
    result: result("equal-age-adapts-to-current-context", failures, {
      architectureSelection: architecture.selection,
      teamSelection: team.selection,
    }),
  };
}

async function competentContextCase(
  mutations: ReadonlySet<ProjectKnowledgeMutation>,
): Promise<ProjectKnowledgeCaseResult> {
  const harness = await createHarness(mutations, "competent");
  try {
    const now = Date.now();
    await setAllFresh(harness, now);
    await harness.state.markEvent(
      harness.projectId,
      ["constraints-invariants"],
      "defaultable dependency choice already documented",
      now + 1,
    );
    await addContextTask(harness, "Defaultable library choice is already known and needs no human decision");
    await waitForRefresh(harness);
    const questions = await harness.db.prepare(
      "SELECT question FROM questions WHERE project_id=? AND status='open'",
    ).all<{ question: string }>(harness.projectId);
    const failures = questions.length === 0 ? [] : [`competent context created ${questions.length} question(s)`];
    return result("competent-context-asks-nothing", failures, { questionCount: questions.length });
  } finally {
    await stopHarness(harness);
  }
}

async function triggerAndChannelCases(
  mutations: ReadonlySet<ProjectKnowledgeMutation>,
): Promise<[ProjectKnowledgeCaseResult, ProjectKnowledgeCaseResult]> {
  const harness = await createHarness(mutations, "triggers");
  try {
    const now = Date.now();
    await setAllFresh(harness, now);
    await harness.db.prepare(
      `UPDATE project_context_domains SET last_refreshed_at=?, last_checked_at=?
        WHERE project_id=? AND domain='product-bounds'`,
    ).run(now - 181 * DAY_MS, now - 2 * DAY_MS, harness.projectId);
    await harness.db.prepare(
      `UPDATE project_context_domains SET last_refreshed_at=NULL, last_checked_at=?
        WHERE project_id=? AND domain='priorities-roadmap'`,
    ).run(now - 2 * DAY_MS, harness.projectId);
    await harness.state.markEvent(
      harness.projectId,
      ["architecture-tech"],
      "human-owned architecture boundary changed",
      now + 1,
    );
    await addContextTask(harness, "Human-owned project context decisions remain open");
    const refresh = await waitForRefresh(
      harness,
      { mode: "refresh" },
      mutations.has("unbound-channel"),
    );
    const questions = await harness.db.prepare(
      `SELECT domain, refresh_trigger, question FROM questions
        WHERE project_id=? AND task_id IS NULL AND status='open' ORDER BY id`,
    ).all<{ domain: ProjectKnowledgeDomain; refresh_trigger: ProjectKnowledgeTrigger; question: string }>(harness.projectId);
    const observedTriggers = [...new Set(questions.map((question) => question.refresh_trigger))].sort();
    const triggerFailures: string[] = [];
    if (refresh.status !== "done") {
      triggerFailures.push(`refresh was rejected before trigger delivery: ${refresh.error ?? "unknown error"}`);
    }
    if (observedTriggers.join("|") !== "EVENTS|STALENESS|TIME") {
      triggerFailures.push(`expected EVENTS, STALENESS, TIME; observed ${observedTriggers.join(", ")}`);
    }
    const questionMarks = questions.map((question) => question.question.match(/\?/g)?.length ?? 0);
    const channelFailures: string[] = [];
    if (refresh.status !== "done") {
      channelFailures.push(`invalid question channel was rejected: ${refresh.error ?? "unknown error"}`);
    }
    if (questions.length > 3) channelFailures.push(`question channel emitted ${questions.length}, expected at most 3`);
    if (questionMarks.some((count) => count !== 1)) {
      channelFailures.push(`each channel item must contain one question; observed marks ${questionMarks.join(", ")}`);
    }
    return [
      result("all-trigger-classes-reach-the-channel", triggerFailures, { triggers: observedTriggers }),
      result("question-channel-is-bounded", channelFailures, {
        questionCount: questions.length,
        questionMarks,
      }),
    ];
  } finally {
    await stopHarness(harness);
  }
}

async function oldestFirstCase(
  mutations: ReadonlySet<ProjectKnowledgeMutation>,
): Promise<ProjectKnowledgeCaseResult> {
  const harness = await createHarness(mutations, "oldest");
  try {
    const now = Date.now();
    await setAllFresh(harness, now);
    const ages: Array<[ProjectKnowledgeDomain, number]> = [
      ["product-bounds", now - 400 * DAY_MS],
      ["architecture-tech", now - 300 * DAY_MS],
      ["history-decisions-learnings", now - 100 * DAY_MS],
      ["priorities-roadmap", now - 40 * DAY_MS],
    ];
    for (const [domain, refreshedAt] of ages) {
      await harness.db.prepare(
        `UPDATE project_context_domains SET last_refreshed_at=?, last_checked_at=?
          WHERE project_id=? AND domain=?`,
      ).run(refreshedAt, now - 2 * DAY_MS, harness.projectId, domain);
    }
    await addContextTask(harness, "Current priority roadmap context is highly relevant");
    const before = await states(harness);
    await waitForRefresh(harness);
    const after = await states(harness);
    const selected = changedDomains(before, after);
    const ageByDomain = new Map(ages);
    const selectedAges = selected.map((domain) => ageByDomain.get(domain)).filter((age): age is number => age !== undefined);
    const unselectedAges = ages.filter(([domain]) => !selected.includes(domain)).map(([, age]) => age);
    const oldestFirst = selected.length === 3
      && selectedAges.length === 3
      && unselectedAges.length === 1
      && Math.max(...selectedAges) <= Math.min(...unselectedAges);
    const failures = oldestFirst ? [] : [`refresh did not retain the three oldest domains: ${selected.join(", ")}`];
    return result("oldest-knowledge-wins", failures, {
      oldestFirst,
      selected,
    });
  } finally {
    await stopHarness(harness);
  }
}

async function answerCurationCase(
  mutations: ReadonlySet<ProjectKnowledgeMutation>,
): Promise<ProjectKnowledgeCaseResult> {
  const harness = await createHarness(mutations, "answer");
  try {
    const now = Date.now();
    await setAllFresh(harness, now);
    await harness.memory.upsert(harness.projectId, {
      path: "roadmap.md",
      type: "Reference",
      title: "Roadmap",
      description: "Current release direction and priorities.",
      tags: ["roadmap", "release", "direction", "domain:priorities-roadmap"],
      body: "# Direction\n\nRelease direction is awaiting confirmation.\n\n# Citations\n",
    });
    const [questionId] = await harness.queue.addQuestions(harness.projectId, null, "mediator", {
      domain: "priorities-roadmap",
      trigger: "EVENTS",
      question: "Which release direction should remain authoritative?",
    });
    const answer = "Ship the dashboard completion before starting another platform phase.";
    await harness.queue.answerQuestion(questionId, answer, "eval-human");
    await harness.state.markEvent(
      harness.projectId,
      ["priorities-roadmap"],
      `human answered project question Q${questionId}`,
      now + 1,
    );
    await waitForRefresh(
      harness,
      {
        mode: "answer",
        answer: {
          question_id: questionId,
          question: "Which release direction should remain authoritative?",
          answer,
          domain: "priorities-roadmap",
        },
      },
    );
    const question = await harness.db.prepare(
      "SELECT status, answer FROM questions WHERE id=?",
    ).get<{ status: string; answer: string | null }>(questionId);
    const doc = await harness.memory.get(harness.projectId, "roadmap.md");
    const logs = await harness.db.prepare(
      "SELECT entry FROM memory_log WHERE project_id=? ORDER BY id",
    ).all<{ entry: string }>(harness.projectId);
    const domain = await harness.db.prepare(
      `SELECT last_refreshed_at FROM project_context_domains
        WHERE project_id=? AND domain='priorities-roadmap'`,
    ).get<{ last_refreshed_at: number | null }>(harness.projectId);
    const memoryUpdated = Boolean(
      doc?.body.includes(answer)
      && logs.some((row) => row.entry === "Updated knowledge: roadmap.md")
      && domain?.last_refreshed_at,
    );
    const failures: string[] = [];
    if (question?.status !== "answered" || question.answer !== answer) {
      failures.push("project question did not retain its answered operational state");
    }
    if (!memoryUpdated) failures.push("answer did not update the tagged standing memory concept");
    for (const required of ["okf_grep", "okf_read", "okf_update"]) {
      if (!harness.driver.toolNames.includes(required)) failures.push(`answer curation did not use ${required}`);
    }
    return result("project-answer-curates-memory", failures, {
      questionStatus: question?.status ?? null,
      memoryUpdated,
      toolNames: harness.driver.toolNames,
    });
  } finally {
    await stopHarness(harness);
  }
}

/**
 * Deterministic/offline hard gate for adaptive project-memory refresh. Every
 * case runs through the production Queue, worker, refresh pipeline, scoped
 * memory tools, and SQLite state transitions; grading reads durable outcomes.
 */
export async function runProjectKnowledgeEval(
  options: ProjectKnowledgeEvalOptions = {},
): Promise<ProjectKnowledgeScorecard> {
  const mutations = new Set(options.mutations ?? []);
  const adaptive = await adaptiveCase(mutations);
  const competent = await competentContextCase(mutations);
  const [triggers, channel] = await triggerAndChannelCases(mutations);
  const oldest = await oldestFirstCase(mutations);
  const answer = await answerCurationCase(mutations);
  const perCase = [adaptive.result, competent, triggers, channel, oldest, answer];
  return {
    domainCount: adaptive.domainCount,
    cases: perCase.length,
    failed: perCase.filter((caseResult) => !caseResult.ok).length,
    mutations: [...mutations],
    perCase,
  };
}
