import type { Db } from "../db.js";
import { authFor } from "../auth/instance.js";
import type { Queue } from "../queue.js";
import { insertDependency, removeDependency } from "../queue.js";
import { ConversationStore } from "../conversations.js";
import type { JobHandler, JobRow, MediatorWorker } from "./worker.js";
import { MemoryStore } from "./memory.js";
import { MemoryTools } from "./memory-tools.js";
import { runMetaQuery, MetaQueryError } from "./metaQuery.js";
import { groomSchema, projectKnowledgeRefreshSchema, type Reference } from "./schemas.js";
import {
  PROJECT_KNOWLEDGE_DOMAINS,
  PROJECT_KNOWLEDGE_SWEEP_MS,
  ProjectKnowledgeState,
  isProjectKnowledgeDomain,
  type ProjectKnowledgeDomain,
} from "./project-knowledge.js";
import { appendSessionEvents, lastEventForTask, type SessionEventInput } from "./session.js";
import {
  personOwnedFromClarify,
  type AgentActivity,
  type CompletedTaskSummary,
  type CompletionMeta,
  type CompletionUsage,
  type DecisionSummary,
  type DiscussAction,
  type LineageTaskSummary,
  type MediatorContext,
  type MediatorDriver,
  type QueueTaskSummary,
  type TaskLineage,
} from "./driver.js";
import { submissionContentIssue } from "../submission-content.js";
import { JobPolicyLog } from "./job-policy-log.js";
import { classifyTaskMerge, findContentCollision, type MergeTaskSnapshot } from "./merge-safety.js";
import { NegotiationStore } from "../negotiation.js";

export interface PipelineDeps {
  db: Db;
  queue: Queue;
  worker: MediatorWorker;
  /** May be async: the hosted path looks the project's model up in the db. */
  driverFor: (projectId: string, job?: JobRow) => MediatorDriver | Promise<MediatorDriver>;
  /**
   * Public base URL of the dashboard (MEMRACER_PUBLIC_URL). When set, discuss
   * and answer replies carry shareable reference links; when unset, references
   * degrade to an empty array — never an error.
   */
  publicUrl?: string;
  /** Optional live delivery after a task-bound mediator question is durable. */
  onClarification?: (input: {
    projectId: string;
    taskId: number;
    questionId: number;
    question: string;
    submittedBy: string;
    negotiationId?: string;
  }) => void | Promise<void>;
}

/** Cap on the verbatim own-thread transcript in a context pack (~chars). */

/** Cap on a related task's one-line summary in a context pack. */
const SUMMARY_LINE_MAX = 200;

/** Historian window: how many recently-completed tasks the mediator may narrate over. */
const COMPLETED_WINDOW = 25;

/** Historian window: how many recent agent activity rows (attempts) travel as context. */
const ACTIVITY_WINDOW = 30;

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * A related task as summary fields only: its threads' stored summaries
 * (written at completion/close), falling back to result_summary, then state.
 * Never a transcript — sibling and ancestor context stays cheap.
 */
async function taskSummaryLine(
  db: Db,
  task: { id: number; result_summary: string | null; state: string },
): Promise<string> {
  const summaries = await db
    .prepare("SELECT summary FROM threads WHERE task_id=? AND summary IS NOT NULL ORDER BY id")
    .all<{ summary: string }>(task.id);
  const text = summaries.map((s) => s.summary).join("; ") || task.result_summary || task.state;
  return oneLine(text, SUMMARY_LINE_MAX);
}

/** The task's own thread ids — the handles the mediator thread_reads for real content. */
async function threadIdsFor(db: Db, taskId: number): Promise<number[]> {
  const rows = await db.prepare("SELECT id FROM threads WHERE task_id=? ORDER BY id").all<{ id: number }>(taskId);
  return rows.map((r) => r.id);
}

/**
 * Provenance handles for a job on task T. Exact root and own-task conversation
 * content remains pull-only through the project-scoped thread_read tool.
 */
async function lineageFor(db: Db, taskId: number): Promise<TaskLineage | undefined> {
  const task = await db
    .prepare("SELECT id, parent_id, root_thread_id FROM tasks WHERE id=?")
    .get<{ id: number; parent_id: number | null; root_thread_id: number | null }>(taskId);
  if (!task) return undefined;

  const ancestors: LineageTaskSummary[] = [];
  const ancestorIds = new Set<number>([taskId]);
  let parentId = task.parent_id;
  while (parentId !== null && !ancestorIds.has(parentId)) {
    ancestorIds.add(parentId);
    const parent = await db
      .prepare("SELECT id, title, parent_id, result_summary, state FROM tasks WHERE id=?")
      .get<{ id: number; title: string; parent_id: number | null; result_summary: string | null; state: string }>(
        parentId,
      );
    if (!parent) break;
    ancestors.unshift({
      id: parent.id,
      title: parent.title,
      summary: await taskSummaryLine(db, parent),
      state: parent.state,
      thread_ids: await threadIdsFor(db, parent.id),
    });
    parentId = parent.parent_id;
  }

  const ownThreadIds = await threadIdsFor(db, taskId);

  const siblings: LineageTaskSummary[] = [];
  if (task.root_thread_id) {
    const rows = (
      await db
        .prepare("SELECT id, title, result_summary, state FROM tasks WHERE root_thread_id=? AND id != ? ORDER BY id")
        .all<{ id: number; title: string; result_summary: string | null; state: string }>(
          task.root_thread_id,
          taskId,
        )
    ).filter((s) => !ancestorIds.has(s.id));
    for (const s of rows) {
      siblings.push({
        id: s.id,
        title: s.title,
        summary: await taskSummaryLine(db, s),
        state: s.state,
        thread_ids: await threadIdsFor(db, s.id),
      });
    }
    // Causal ordering: completed-before-me siblings first (their work is
    // settled), then concurrent/in-flight ones — each stable by id within group.
    siblings.sort((a, b) => {
      const ad = a.state === "DONE" ? 0 : 1;
      const bd = b.state === "DONE" ? 0 : 1;
      return ad - bd || a.id - b.id;
    });
  }

  return { rootThreadId: task.root_thread_id, ancestors, ownThreadIds, siblings };
}

/**
 * Read the historian window: recently-completed tasks (the "what got fixed"
 * source, excluded from the live queue) and per-agent activity (attempt
 * outcomes plus live leases — "who's working on what"). Bounded so the pack
 * stays cheap; the discuss prompt refuses to narrate outside this window.
 */
async function historyFor(
  db: Db,
  projectId: string,
): Promise<{ completed: CompletedTaskSummary[]; activity: AgentActivity[] }> {
  const completed = await db
    .prepare(
      `SELECT id, title, result_summary, result_pr_url, result_pr_number, updated_at
       FROM tasks WHERE project_id=? AND state='DONE' ORDER BY updated_at DESC, id DESC LIMIT ?`,
    )
    .all<CompletedTaskSummary>(projectId, COMPLETED_WINDOW);
  const attempts = await db
    .prepare(
      `SELECT a.agent AS agent, a.task_id AS task_id, t.title AS title,
              a.outcome AS outcome, a.notes AS notes, a.created_at AS created_at
       FROM attempts a JOIN tasks t ON t.id = a.task_id
       WHERE t.project_id=? ORDER BY a.id DESC LIMIT ?`,
    )
    .all<AgentActivity>(projectId, ACTIVITY_WINDOW);
  // Live leases: an agent holding a task right now, not yet an attempt row.
  const leases = await db
    .prepare(
      `SELECT lease_agent AS agent, id AS task_id, title, updated_at AS created_at
       FROM tasks WHERE project_id=? AND lease_agent IS NOT NULL ORDER BY id`,
    )
    .all<{ agent: string; task_id: number; title: string; created_at: number }>(projectId);
  const activity: AgentActivity[] = [
    ...leases.map((l) => ({ ...l, outcome: "leased", notes: null })),
    ...attempts,
  ];
  return { completed, activity };
}

async function contextFor(
  db: Db,
  memoryTools: MemoryTools,
  projectId: string,
  opts: { excludeTaskId?: number; queryText?: string; taskId?: number; history?: boolean; queuedUnleasedOnly?: boolean } = {},
): Promise<MediatorContext> {
  const project = (await db
    .prepare("SELECT name FROM projects WHERE id=?")
    .get<{ name: string }>(projectId)) as { name: string };
  const queue = await db
    .prepare(
      // excludeTaskId keeps the task under grooming out of its own context —
      // otherwise the model sees the submission as an existing duplicate and
      // proposes a self-merge (observed live with GLM 5.2).
      `SELECT id, title, state, priority FROM tasks
       WHERE project_id=? AND id != ?
         AND ${opts.queuedUnleasedOnly ? "state='QUEUED' AND lease_agent IS NULL AND grooming_rationale IS NOT NULL" : "state NOT IN ('DONE')"}
       ORDER BY priority, id`,
    )
    .all<QueueTaskSummary>(projectId, opts.excludeTaskId ?? -1);
  const decisions = await db
    .prepare(
      "SELECT id, task_id, kind, summary, rationale, created_at FROM decision_log WHERE project_id=? ORDER BY id DESC LIMIT 20",
    )
    .all<DecisionSummary>(projectId);
  // No pushed digest: the mediator greps/reads its OKF and threads on demand
  // through the project-scoped tool loop (memory stays empty here by design).
  // The server owns the clock: injected so the historian narrates in real time
  // rather than inventing a date the model can't know (stateless per request).
  const now = { now_iso: new Date().toISOString(), timezone: serverTimezone() };
  const ctx: MediatorContext = {
    projectId,
    projectName: project.name,
    queue,
    decisions,
    memory: "",
    tools: memoryTools.bind(projectId, opts.taskId),
    now,
  };
  // Better-auth owns membership. Expose only the current project's display
  // names and project roles; never emails, profiles, ids, or another tenant.
  if (authFor(db)) {
    ctx.roster = await db.prepare(
      `SELECT u.name AS name, m.role AS role
         FROM "member" m JOIN "user" u ON u.id=m."userId"
        WHERE m."organizationId"=? ORDER BY u.name, m.role`,
    ).all<{ name: string; role: string }>(projectId);
  }
  if (opts.taskId && opts.taskId > 0) {
    const lineage = await lineageFor(db, opts.taskId);
    if (lineage) ctx.lineage = lineage;
  }
  if (opts.history) {
    const { completed, activity } = await historyFor(db, projectId);
    ctx.completed = completed;
    ctx.activity = activity;
  }
  return ctx;
}

function serverTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

interface PendingProjectAnswer {
  question_id: number;
  question: string;
  answer: string;
  domain?: ProjectKnowledgeDomain;
}

/** Reconstruct answer work from the durable audit row, never a transient job payload. */
async function pendingProjectAnswer(
  db: Db,
  projectId: string,
  questionId?: number,
): Promise<PendingProjectAnswer | null> {
  const row = questionId === undefined
    ? await db.prepare(
        `SELECT id, question, answer, domain FROM questions
          WHERE project_id=? AND task_id IS NULL AND status='answered'
            AND answer IS NOT NULL AND curated_at IS NULL
          ORDER BY COALESCE(answered_at, created_at), id LIMIT 1`,
      ).get<{ id: number; question: string; answer: string; domain: string | null }>(projectId)
    : await db.prepare(
        `SELECT id, question, answer, domain FROM questions
          WHERE project_id=? AND id=? AND task_id IS NULL AND status='answered'
            AND answer IS NOT NULL AND curated_at IS NULL`,
      ).get<{ id: number; question: string; answer: string; domain: string | null }>(projectId, questionId);
  if (!row) return null;
  return {
    question_id: row.id,
    question: row.question,
    answer: row.answer,
    ...(isProjectKnowledgeDomain(row.domain) ? { domain: row.domain } : {}),
  };
}

/**
 * Blank every id the model cited that no supplied record backs (Anthropic
 * Citations pattern: post-validate, don't trust). Scans DEC-<n>, task:<n>,
 * task <n>, and #<n> tokens; an id outside `allowed` keeps its prefix but
 * loses the number (DEC-?, task:?, #?), so an invented reference can't pass
 * as grounded. Actions are validated separately against the live queue.
 */
export function blankUncitedIds(reply: string, allowed: Set<number>): string {
  return reply
    .replace(/\bDEC-(\d+)\b/g, (m, n) => (allowed.has(Number(n)) ? m : "DEC-?"))
    .replace(/\btask[:\s]#?(\d+)\b/gi, (m, n) => (allowed.has(Number(n)) ? m : m.replace(n, "?")))
    // PR #<n> is its own grounded entity and must reach mintReferences intact;
    // never reinterpret its number as a task id.
    .replace(/(^|[^\w])(?<!\bPR\s)#(\d+)\b/gi, (m, pre, n) => (allowed.has(Number(n)) ? m : `${pre}#?`));
}

/** The id universe a historian reply may cite: live queue, decisions, completed tasks, activity. */
function citableIds(ctx: MediatorContext): Set<number> {
  const ids = new Set<number>();
  for (const t of ctx.queue) ids.add(t.id);
  for (const d of ctx.decisions) {
    if (d.id !== undefined) ids.add(d.id);
    if (d.task_id != null) ids.add(d.task_id);
  }
  for (const c of ctx.completed ?? []) ids.add(c.id);
  for (const a of ctx.activity ?? []) ids.add(a.task_id);
  // Escape-hatch rows widen the citable universe: an id the query returned is
  // grounded evidence the reply may cite (Anthropic Citations post-validation).
  for (const id of ctx.queryResult?.taskIds ?? []) ids.add(id);
  for (const id of ctx.queryResult?.decisionIds ?? []) ids.add(id);
  for (const id of ctx.tools?.citablePlanIds?.() ?? []) ids.add(id);
  return ids;
}

/** The citable id universe split by entity type, for reference minting. */
export interface CitableRefs {
  tasks: Set<number>;
  decisions: Set<number>;
  /** Task ids whose stored plans may be cited as PLAN-<id>. */
  plans?: Set<number>;
  /** Project scope required to restore internal dashboard references safely. */
  projectId?: string;
  /** Evidence id -> owning task id, used to mint an in-overlay target. */
  evidence?: Map<number, number>;
  /** Pull request number -> externally verified URL from a completed task. */
  prs?: Map<number, string>;
  /** Decision id -> owning task id, when the decision is task-bound. */
  decisionOwners?: Map<number, number>;
}

/**
 * Split the citable universe into task ids and decision ids. Tasks come from
 * the live queue, completed window, agent activity, and each decision's
 * task_id; decisions are the decision-log row ids (cited as DEC-<n>).
 */
export function citableRefs(
  ctx: MediatorContext,
  evidenceRows: Array<{ id?: number; taskId?: number }> = [],
): CitableRefs {
  const tasks = new Set<number>();
  const decisions = new Set<number>();
  const evidence = new Map<number, number>();
  const prs = new Map<number, string>();
  const decisionOwners = new Map<number, number>();
  const plans = new Set(ctx.tools?.citablePlanIds?.() ?? []);
  for (const t of ctx.queue) tasks.add(t.id);
  for (const c of ctx.completed ?? []) tasks.add(c.id);
  for (const a of ctx.activity ?? []) tasks.add(a.task_id);
  for (const d of ctx.decisions) {
    if (d.task_id != null) {
      tasks.add(d.task_id);
      if (d.id !== undefined) {
        decisions.add(d.id);
        decisionOwners.set(d.id, d.task_id);
      }
    }
  }
  for (const c of ctx.completed ?? []) {
    if (c.result_pr_number != null && c.result_pr_url) prs.set(c.result_pr_number, c.result_pr_url);
  }
  for (const row of evidenceRows) {
    if (row.id !== undefined && row.taskId !== undefined) evidence.set(row.id, row.taskId);
  }
  for (const id of ctx.queryResult?.taskIds ?? []) tasks.add(id);
  for (const id of plans) tasks.add(id);
  // Query-only decision ids have no owner task. They are deliberately not
  // citable because the dashboard has no honest in-overlay destination for a
  // taskless/unowned decision.
  return { tasks, decisions, plans, projectId: ctx.projectId, evidence, prs, decisionOwners };
}

/** Mint a shareable dashboard deep link for a project entity. */
export function refUrl(
  base: string,
  type: Reference["type"],
  id: number,
  ownerTaskId?: number,
  projectId?: string,
): string {
  const root = `${base.replace(/\/+$/, "")}/dashboard`;
  const params = new URLSearchParams();
  if (projectId) params.set("project", projectId);
  if (type === "evidence" || (type === "decision" && ownerTaskId !== undefined)) {
    params.set("task", String(ownerTaskId ?? ""));
    return `${root}?${params.toString()}#${type}-${id}`;
  }
  params.set(type, String(id));
  return `${root}?${params.toString()}`;
}

/**
 * Blank every unsupported typed citation token before model prose is stored.
 * This uses the same entity-specific allowlists as mintReferences, so an id
 * collision across task/evidence/decision/PR cannot make fabricated proof
 * appear grounded.
 */
export function sanitizeReferenceTokens(text: string, refs: CitableRefs): string {
  const token = /\bPR[-:\s]#?(\d+)\b|\bEVID-(\d+)\b|\bDEC-(\d+)\b|\bPLAN-(\d+)\b|\btask[:\s]#?(\d+)\b|(?:^|[^\w])#(\d+)\b/gi;
  return text.replace(token, (match, pr, evidence, decision, plan, task, bare) => {
    const raw = pr ?? evidence ?? decision ?? plan ?? task ?? bare;
    const id = Number(raw);
    const valid = pr !== undefined
      ? refs.prs?.has(id) === true
      : evidence !== undefined
        ? refs.evidence?.has(id) === true
        : decision !== undefined
          ? refs.decisions.has(id) && refs.decisionOwners?.has(id) === true
          : plan !== undefined
            ? refs.plans?.has(id) === true
            : refs.tasks.has(id);
    return valid ? match : match.replace(raw, "?");
  });
}

/**
 * Derive a structured, post-validated reference array from the ids a reply
 * cites inline (#<id>, task:<id>, DEC-<n>, EVID-<n>, PR #<n>). The server mints the URLs — the
 * model never authors links. Every id is validated against the live context
 * pack (fabricated ids are dropped, mirroring blankUncitedIds). An unset base
 * degrades to no references, never an error. References preserve first-mention
 * order and are deduped per entity.
 */
export function mintReferences(base: string | undefined, text: string, refs: CitableRefs): Reference[] {
  if (!base) return [];
  const out: Reference[] = [];
  const seen = new Set<string>();
  const add = (type: "task" | "decision", allowed: Set<number>, raw: string) => {
    const id = Number(raw);
    const key = `${type}:${id}`;
    if (!allowed.has(id) || seen.has(key)) return;
    seen.add(key);
    const label = type === "decision" ? `DEC-${id}` : `task #${id}`;
    const owner = type === "decision" ? refs.decisionOwners?.get(id) : undefined;
    out.push({ type, id, url: refUrl(base, type, id, owner, refs.projectId), label });
  };
  const addEvidence = (raw: string) => {
    const id = Number(raw);
    const owner = refs.evidence?.get(id);
    const key = `evidence:${id}`;
    if (owner === undefined || seen.has(key)) return;
    seen.add(key);
    out.push({ type: "evidence", id, url: refUrl(base, "evidence", id, owner, refs.projectId), label: `EVID-${id}` });
  };
  const addPr = (raw: string) => {
    const id = Number(raw);
    const url = refs.prs?.get(id);
    const key = `pr:${id}`;
    if (!url || seen.has(key)) return;
    seen.add(key);
    out.push({ type: "pr", id, url, label: `PR #${id}` });
  };
  const addPlan = (raw: string) => {
    const id = Number(raw);
    const key = `plan:${id}`;
    if (refs.plans?.has(id) !== true || seen.has(key)) return;
    seen.add(key);
    out.push({
      type: "task",
      id,
      url: `${refUrl(base, "task", id, undefined, refs.projectId)}#plan`,
      label: `plan for task #${id}`,
    });
  };
  // Walk the whole text once so references keep first-mention order across types.
  const token = /\bPR[-:\s]#?(\d+)\b|\bEVID-(\d+)\b|\bDEC-(\d+)\b|\bPLAN-(\d+)\b|\btask[:\s]#?(\d+)\b|(?:^|[^\w])#(\d+)\b/gi;
  for (const m of text.matchAll(token)) {
    if (m[1] !== undefined) addPr(m[1]);
    else if (m[2] !== undefined) addEvidence(m[2]);
    else if (m[3] !== undefined) add("decision", refs.decisions, m[3]);
    else if (m[4] !== undefined) addPlan(m[4]);
    else if (m[5] !== undefined) add("task", refs.tasks, m[5]);
    else if (m[6] !== undefined) add("task", refs.tasks, m[6]);
  }
  return out;
}


/**
 * Groom validation guards (#39, #72): the driver's groom decision is advisory.
 * A research-only, held-scope, or invisible-slice-feature submission that the
 * model tried to admit (accept/merge) is bounced back to the submitter as a
 * clarify. Fixes and chores are never gated — they pass through every guard.
 */

/**
 * Corrective / hardening intent that is not net-new capability. Used so the
 * invisible-slice reshape guard never bounces a bug/gap/race/sanitize fix
 * just because the description is backend-only or preserves existing behavior.
 */
// Note: bare "regression" is NOT a signal — it matches "regression eval"
// (a feature). Require fix-adjacent phrasing for regressions.
const CORRECTIVE_SIGNAL =
  /\b(bug\s*fix|fix(?:es|ing)?\s+(?:a\s+)?(?:bug|gap|race|leak|regression)|(?:gap|race|hot|regression)\s*fix|harden(?:ing)?|saniti[sz]\w*|scrub|correct(?:ness|ive)?|info[-\s]?disclosure|leak(?:s|ing)?|mis-?(?:tag|rout|fir)\w*|make[\s\w-]{0,40}required|required[\s\w-]{0,20}(?:arg|argument|param|field)|typo\b|nits?\b|upkeep)\b/i;

/**
 * A fix/chore never hits a guard: leading fix|chore|bug label, expected-vs-actual
 * repro, or broader corrective/hardening language (gap fix, make-arg-required,
 * sanitize/scrub, race, etc.). Net-new features must not match.
 */
export function isFixOrChore(title: string, body: string): boolean {
  const text = `${title}\n${body}`;
  if (/^\s*(fix|chore|bug)\b/i.test(title) || /^\s*(fix|chore|bug)\b/im.test(body)) return true;
  if (/\bexpected\b[\s\S]*\bactual\b/i.test(text)) return true;
  if (CORRECTIVE_SIGNAL.test(text)) return true;
  // Explicit class labels only — not bare "fix" (that would match implement-a-feature prose).
  if (
    /\b(?:fix\/chore|chore\/fix)\b/i.test(text) ||
    /\b(?:this\s+(?:is|task\s+is)\s+a\s+|treat\s+(?:this\s+)?(?:as\s+)?|class(?:ify|ified)?\s+as\s+)(?:fix|chore)\b/i.test(
      text,
    )
  ) {
    return true;
  }
  return false;
}

/**
 * Any concrete build signal — a verb stem or a file-path/extension token — that
 * marks an actionable core. Broad on purpose (#51): over-matching here only
 * makes a submission accept instead of bounce, the safe direction.
 */
const IMPL_SIGNAL =
  /\b(fix|implement|add|build|integrat|refactor|wir|migrat|patch|ship|remov|renam|replac|enforc|render|expos|persist|creat|writ|chang|updat|surfac|emit|prepend|append|cach|schedul|reduc|slim|switch|throttl|paginat|upgrad|bump|purg|drain|rotat|deflak|dedup|backfill|index)\w*|\bsrc\/|\b\w+\.(ts|tsx|js|sql|md|json|ya?ml)\b/i;

/** A research verb leading a phrase (title or the first sentence of the body). */
function leadsWithResearch(text: string): boolean {
  const firstSentence = text.trim().split(/[.!?\n]/)[0] ?? "";
  return /^\W*(research|investigat|explor|spike|survey|study|assess|evaluat|look\s+into|figure\s+out|find\s+out)/i.test(
    firstSentence,
  );
}

/**
 * True when the submission's ENTIRE deliverable is open-ended research with no
 * actionable core (#51): a research verb LEADS the title or the body's first
 * sentence AND no implementation signal appears anywhere. Any concrete build
 * step means it has an actionable core — accept it. "research X" -> true;
 * "investigate then fix Y" -> false; "reduce image size; survey layers" -> false.
 */
function isResearchOnly(title: string, body: string): boolean {
  if (IMPL_SIGNAL.test(`${title}\n${body}`)) return false;
  return leadsWithResearch(title) || leadsWithResearch(body);
}

/**
 * Invisible-slice anti-pattern (#72). A FEATURE whose stated outcome is
 * backend-only / preserves existing behavior / changes nothing the human can
 * see or use — the shape that repeatedly shipped "done" work delivering no
 * observable value (better-auth #64 preserved the token flow; #39 shipped a
 * design doc). DONE means delivered-and-usable, so such scope is bounced to be
 * reshaped into a complete working vertical (or a phase that still ships
 * something observable).
 */
const INVISIBLE_SIGNAL =
  /\b(preserv\w*\s+(the\s+|its\s+|existing\s+|current\s+)*(token\s+|auth\s+|login\s+)?(behavior|behaviour|flow|path)|no(thing)?\s+(user-?facing|visible|observable)\s+(change|delta|difference)|nothing\s+(visible|user-?facing)\s+changes?|no\s+visible\s+(change|delta|difference)|zero\s+(visible|user-?facing|observable)|backend[-\s]only|backend\s+seam|seam[-\s]only|behind\s+the\s+seam|internal[-\s]only|non[-\s]user[-\s]facing|invisible)\b/i;

/** The entire deliverable is a design doc/plan — a milestone, never a DONE feature. */
const DOC_ONLY_SIGNAL =
  /\b(design\s+doc(ument)?|design\s+note|no\s+code\s+ships?|documents?\s+the\s+design|spec(ification)?\s+doc|rfc\s+doc)\b/i;

/**
 * Escape: the submission already names visible, usable delivery — a working
 * vertical. Mirrors isResearchOnly's impl-signal escape so the safe direction
 * is accept: a scope that says how a human sees/uses the result is never
 * bounced by the visibility guard.
 */
const OBSERVABLE_SIGNAL =
  /\b(dashboard|UI|screen|\bpage\b|user\s+(sees|can\s+see|uses|can\s+use|signs?\s+in)|visible\s+to\s+the\s+(user|human)|human\s+can\s+(see|use)|renders?|displays?|demonstrat\w*|usable|observable|sign[-\s]in\s+(page|screen|flow)|button|\bview\b|surfaces?\s+to\s+the\s+(user|human))\b/i;

/**
 * True when a feature submission's deliverable is an invisible backend-only
 * slice or a design-doc/plan AND it names no observable, usable delivery.
 * Fixes/chores are exempt upstream (isFixOrChore gates the guard chain).
 */
function invisibleFeatureKind(title: string, body: string): "invisible" | "doc-only" | null {
  const text = `${title}\n${body}`;
  if (OBSERVABLE_SIGNAL.test(text)) return null; // a working vertical — never bounce
  if (/^\s*(docs?|design)\s*:/i.test(title) || DOC_ONLY_SIGNAL.test(text)) return "doc-only";
  if (INVISIBLE_SIGNAL.test(text)) return "invisible";
  return null;
}

/** Held-scope topics: bullet/line entries in the 'conventions/held-scope.md' memory note. */
async function heldScopeTopics(memory: MemoryStore, projectId: string): Promise<string[]> {
  const doc = await memory.get(projectId, "conventions/held-scope.md");
  if (!doc) return [];
  return doc.body
    .split(/\n/)
    .map((l) => l.replace(/^[-*\s]+/, "").trim().toLowerCase())
    .filter(Boolean);
}

/** The held topic a submission touches (case-insensitive word match), or undefined. */
function heldTopicHit(title: string, body: string, topics: string[]): string | undefined {
  const text = `${title}\n${body}`.toLowerCase();
  return topics.find((t) => new RegExp(`(^|[^a-z0-9])${escapeRe(t)}([^a-z0-9]|$)`).test(text));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The clarify-bounce a guard produces for an admitting decision, or null when
 * nothing is held. Fixes/chores are exempt; research-only is checked before
 * held-scope so a research shape reports the clearer reason.
 */
/**
 * Admit-side groom hold (research / held-scope / invisible-slice). Exported for
 * eval harnesses that exercise the same guard chain without a full worker.
 */
export function groomHold(
  title: string,
  body: string,
  heldTopics: string[] = [],
): { question: string; rationale: string } | null {
  if (isFixOrChore(title, body)) return null;
  if (isResearchOnly(title, body)) {
    return {
      question:
        "Which concrete implementation should this research produce, or should this submission be withdrawn? Recommended: withdraw — research without a named implementation is tracked outside the coder queue.",
      rationale: "research-only submission; research is a precondition the human owns, not a coder task",
    };
  }
  const topic = heldTopicHit(title, body, heldTopics);
  if (topic) {
    return {
      question: `Should the explicit hold on "${topic}" be lifted, or should this be narrowed to unheld scope? Recommended: keep held — the recorded operator decision remains authoritative until explicitly changed.`,
      rationale: `held scope ("${topic}"); operator-deferred, not queued for coders`,
    };
  }
  const invisible = invisibleFeatureKind(title, body);
  if (invisible === "invisible") {
    return {
      question:
        "What visible, usable delivery should complete this backend-only feature slice? Recommended: reshape it as a working vertical whose acceptance names how a human observes or uses the result.",
      rationale:
        "invisible/backend-only feature slice; DONE requires observable, usable value — reshape into a working vertical",
    };
  }
  if (invisible === "doc-only") {
    return {
      question:
        "Which complete working vertical should this design document lead to, or should it be tracked only as a milestone? Recommended: treat it as a milestone and scope the usable implementation separately.",
      rationale: "design-doc/plan submission; a doc is a milestone, not a DONE feature",
    };
  }
  return null;
}

function contentFreeHold(field: "title" | "body", reason: "blank" | "placeholder") {
  return {
    question:
      "What concrete work should this submission describe? Recommended: replace the placeholder with a specific title and body that state the requested outcome.",
    rationale: `content-free submission; ${field} is ${reason} and cannot be admitted to the coder queue`,
  };
}

async function logDecision(
  db: Db,
  projectId: string,
  taskId: number | null,
  kind: string,
  summary: string,
  rationale: string,
  citations: Reference[] = [],
): Promise<number> {
  const row = await db
    .prepare(
      "INSERT INTO decision_log (project_id, task_id, kind, summary, rationale, created_at, citations) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .get<{ id: number }>(projectId, taskId, kind, summary, rationale, Date.now(), JSON.stringify(citations));
  return row!.id;
}

export async function markPolicyQuality(
  db: Db,
  taskId: number,
  signal: "rejected" | "reopened",
  at = Date.now(),
): Promise<void> {
  try {
    await new JobPolicyLog(db).markQualityForTask(taskId, signal, at);
  } catch (error) {
    // Quality annotation follows an already-durable semantic mutation. Never
    // replay that mutation merely because optional telemetry could not attach.
    console.error(`[job-policy-quality-failure] ${JSON.stringify({
      task_id: taskId,
      signal,
      error: error instanceof Error ? error.message : String(error),
    })}`);
  }
}

/** Non-terminal states a task can be held from. DONE is terminal (reopen it). */
const HOLDABLE_STATES = ["QUEUED", "CLAIMED", "PLANNED", "EXECUTING", "BLOCKED", "PARKED"];

export interface ApplyActionsOptions {
  /** Where this action originated — recorded as the attribution on close/hold.
   * Only "operator:<name>" when a human operator directed it; coder-initiated
   * and autonomous-mediator actions never fabricate operator attribution. */
  trigger: string;
  /** Tasks exempt from the active-state refusal (the asking coder's own task). */
  allowTaskIds?: number[];
  memory: MemoryStore;
  /** Task 53's mediator memory-write capability. Off until 53 lands. */
  memoryRescindEnabled: boolean;
}

type RefusedAction = { action: string; task_id?: number; path?: string; reason: string };

/**
 * Validate and apply mediator queue actions (from discuss, reconcile, or answer).
 * Actions are model output — each is checked against the live queue; invalid
 * ones are refused with a stated reason instead of failing the job.
 * `allowTaskIds` exempts named tasks from the active-state refusal (close/
 * set_priority/update_task): the ask path may act on the asking coder's own
 * CLAIMED/EXECUTING task. hold/reopen are lifecycle transitions with their
 * own state rules and are exempt from that blanket refusal; rescind_memory
 * targets a memory doc, not a task.
 */
async function applyDiscussActions(
  db: Db,
  projectId: string,
  actions: DiscussAction[],
  opts: ApplyActionsOptions,
): Promise<{ applied: DiscussAction[]; refused: RefusedAction[] }> {
  const { trigger, allowTaskIds = [], memory, memoryRescindEnabled } = opts;
  const applied: DiscussAction[] = [];
  const refused: RefusedAction[] = [];
  for (const a of actions) {
    // Dependency edges carry no single task_id — validate and apply them
    // through the shared helper (cross-project / self-edge / cycle → refused
    // with the stated reason, same refuse-don't-crash contract as close_task).
    if (a.action === "add_dependency" || a.action === "remove_dependency") {
      try {
        if (a.action === "add_dependency") {
          await insertDependency(db, projectId, a.dependent_task_id, a.depends_on_task_id);
          await logDecision(
            db, projectId, a.dependent_task_id, "update",
            `task ${a.dependent_task_id} now depends on ${a.depends_on_task_id}`, a.reason,
          );
        } else {
          await removeDependency(db, a.dependent_task_id, a.depends_on_task_id);
          await logDecision(
            db, projectId, a.dependent_task_id, "update",
            `removed dependency ${a.dependent_task_id}->${a.depends_on_task_id}`, a.reason,
          );
        }
        applied.push(a);
      } catch (err) {
        refused.push({ action: a.action, task_id: a.dependent_task_id, reason: (err as Error).message });
      }
      continue;
    }

    const now = Date.now();

    // rescind_memory has no task — gated on task 53's memory-write capability.
    if (a.action === "rescind_memory") {
      if (!memoryRescindEnabled) {
        refused.push({
          action: a.action,
          path: a.path,
          reason: "rescind_memory unavailable — task 53 (mediator memory-write tools) not landed",
        });
        continue;
      }
      const doc = await memory.get(projectId, a.path);
      if (!doc) {
        refused.push({ action: a.action, path: a.path, reason: `memory doc ${a.path} not found` });
        continue;
      }
      await memory.remove(projectId, a.path);
      await memory.appendLog(projectId, `rescinded ${a.path} (${trigger}): ${a.reason}`);
      await logDecision(db, projectId, null, "update", `rescinded memory doc ${a.path}`, a.reason);
      applied.push(a);
      continue;
    }

    const task = await db
      .prepare("SELECT state, result_pr_url FROM tasks WHERE id=? AND project_id=?")
      .get<{ state: string; result_pr_url: string | null }>(a.task_id, projectId);
    if (!task) {
      refused.push({ action: a.action, task_id: a.task_id, reason: `task ${a.task_id} not found in project` });
      continue;
    }

    if (a.action === "hold") {
      if (task.state === "DONE") {
        refused.push({ action: a.action, task_id: a.task_id, reason: `task ${a.task_id} is DONE — use reopen` });
        continue;
      }
      if (task.state === "HELD") {
        refused.push({ action: a.action, task_id: a.task_id, reason: `task ${a.task_id} is already HELD` });
        continue;
      }
      // Holding a leased task releases the lease with it (in-flight work parks).
      await db
        .prepare(
          "UPDATE tasks SET state='HELD', result_summary=?, hold_cause='explicit', block_kind=NULL, block_requeue_at=NULL, lease_agent=NULL, lease_expires_at=NULL, updated_at=? WHERE id=?",
        )
        .run(`held (${trigger}): ${a.reason}`, now, a.task_id);
      await db
        .prepare("UPDATE questions SET status='answered', answer=? WHERE task_id=? AND status='open'")
        .run(`resolved: task held (${a.reason})`, a.task_id);
      await logDecision(db, projectId, a.task_id, "hold", `held task ${a.task_id}`, a.reason);
      applied.push(a);
      continue;
    }

    if (a.action === "reopen") {
      const reopenable = task.state === "HELD" || (task.state === "DONE" && task.result_pr_url === null);
      if (!reopenable) {
        const reason =
          task.state === "DONE"
            ? `task ${a.task_id} is DONE with a PR — a real completion, not reopenable`
            : `task ${a.task_id} is ${task.state}, not HELD`;
        refused.push({ action: a.action, task_id: a.task_id, reason });
        continue;
      }
      await db
        .prepare(
          "UPDATE tasks SET state='QUEUED', result_summary=NULL, hold_cause=NULL, block_kind=NULL, block_requeue_at=NULL, lease_agent=NULL, lease_expires_at=NULL, queued_at=?, queue_generation=queue_generation+1, updated_at=? WHERE id=?",
        )
        .run(now, now, a.task_id);
      await logDecision(db, projectId, a.task_id, "reopen", `reopened task ${a.task_id}`, a.reason);
      await markPolicyQuality(db, a.task_id, "reopened", now);
      applied.push(a);
      continue;
    }

    // close_task / set_priority / update_task keep the active-state refusal.
    if (["CLAIMED", "EXECUTING", "PLANNED", "DONE"].includes(task.state) && !allowTaskIds.includes(a.task_id)) {
      refused.push({ action: a.action, task_id: a.task_id, reason: `task ${a.task_id} is ${task.state}` });
      continue;
    }
    if (a.action === "close_task") {
      // Closing a leased task (ask path) must release the lease with it.
      await db
        .prepare(
          "UPDATE tasks SET state='DONE', result_summary=?, lease_agent=NULL, lease_expires_at=NULL, updated_at=? WHERE id=?",
        )
        .run(`closed (${trigger}): ${a.reason}`, now, a.task_id);
      // A closed task leaves no zombie asks in the needs-you strip.
      await db
        .prepare("UPDATE questions SET status='answered', answer=? WHERE task_id=? AND status='open'")
        .run(`resolved: task closed (${a.reason})`, a.task_id);
      // A closed task's threads get their cheap summaries now (ancestor refs).
      await summarizeTaskThreads(db, a.task_id);
      await logDecision(db, projectId, a.task_id, "close", `closed task ${a.task_id} without work`, a.reason);
    } else if (a.action === "set_priority") {
      await db.prepare("UPDATE tasks SET priority=?, updated_at=? WHERE id=?").run(a.priority, now, a.task_id);
      await logDecision(db, projectId, a.task_id, "priority", `set task ${a.task_id} to P${a.priority}`, a.reason);
    } else {
      // update_task: the mediator IS the groomer — its edit is final, no re-groom.
      // Misattribution guard: on a full content rewrite (both title+body given —
      // the observed corruption signature), refuse if the new content canonically
      // duplicates a DIFFERENT live task. Here the model supplies task_id AND
      // content as independent free fields, so a wrong-row/wrong-content swap is
      // possible; this catches it before it lands.
      if (a.title != null && a.body != null) {
        const collision = await findContentCollision(db, projectId, a.task_id, a.title, a.body);
        if (collision !== null) {
          refused.push({ action: a.action, task_id: a.task_id, reason: `content matches live task ${collision} (misattribution guard)` });
          continue;
        }
      }
      await db
        .prepare("UPDATE tasks SET title=COALESCE(?, title), body=COALESCE(?, body), updated_at=? WHERE id=?")
        .run(a.title ?? null, a.body ?? null, now, a.task_id);
      await logDecision(db, projectId, a.task_id, "update", `updated task ${a.task_id}`, a.reason);
    }
    applied.push(a);
  }
  return { applied, refused };
}

/**
 * One typed step in a session transcript. Beyond role/author/content, a step
 * may carry the sidecar the mediator produced: the model's reasoning trace,
 * the structured decision object, the model id, and token usage (#45). The
 * sidecar is captured for readability — never fed back into a later call.
 */
interface ThreadStep {
  role: "human" | "coder" | "mediator" | "system";
  author: string;
  content: string;
  reasoning?: string;
  structured?: unknown;
  model?: string;
  usage?: CompletionUsage;
}

/** A mediator step: structured decision in `content` (back-compat) and columns, plus the completion sidecar. */
function mediatorStep(structured: unknown, meta: CompletionMeta | undefined): ThreadStep {
  return {
    role: "mediator",
    author: "mediator",
    content: JSON.stringify(structured),
    structured,
    reasoning: meta?.reasoning,
    model: meta?.model,
    usage: meta?.usage,
  };
}

async function persistMediatorUsage(db: Db, job: JobRow, usage: CompletionUsage): Promise<void> {
  await db.prepare(
    `INSERT INTO mediator_usage (
       job_id, project_id, kind, requested_model, resolved_model,
       prompt_tokens, completion_tokens, cached_tokens, cache_write_tokens,
       cache_discount_usd, cost_usd, completion_count, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(job_id) DO UPDATE SET
       requested_model=excluded.requested_model,
       resolved_model=excluded.resolved_model,
       prompt_tokens=excluded.prompt_tokens,
       completion_tokens=excluded.completion_tokens,
       cached_tokens=excluded.cached_tokens,
       cache_write_tokens=excluded.cache_write_tokens,
       cache_discount_usd=excluded.cache_discount_usd,
       cost_usd=excluded.cost_usd,
       completion_count=excluded.completion_count`,
  ).run(
    job.id,
    job.project_id,
    job.kind,
    usage.requestedModel ?? null,
    usage.resolvedModel ?? null,
    usage.promptTokens,
    usage.completionTokens,
    usage.cachedTokens ?? 0,
    usage.cacheWriteTokens ?? 0,
    usage.cacheDiscountUsd ?? null,
    usage.costUsd ?? null,
    usage.completionCount ?? 1,
    Date.now(),
  );
}

async function captureDriverMeta(db: Db, job: JobRow, driver: MediatorDriver): Promise<CompletionMeta | undefined> {
  const meta = driver.takeMeta?.();
  const usage = driver.takeUsage?.() ?? meta?.usage;
  if (usage) await persistMediatorUsage(db, job, usage);
  if (!meta && !usage) return undefined;
  return {
    ...meta,
    model: usage?.resolvedModel ?? meta?.model,
    usage,
  };
}

async function recordThread(
  db: Db,
  projectId: string,
  kind: "groom" | "review" | "answer" | "discuss",
  taskId: number | null,
  exchanges: ThreadStep[],
  // The typed, ordered session events for this cycle (reasoning, tool_call,
  // tool_result, verdict, …). When omitted, one is derived per exchange so
  // every recorded thread still contributes to its session stream.
  sessionEvents?: SessionEventInput[],
  // For a forked child task's FIRST recorded cycle: the parent task's last
  // event, so this cycle branches off it via parent_id.
  forkParentEventId?: number | null,
): Promise<number> {
  const now = Date.now();
  // Every interaction thread anchors to its task's root submission thread;
  // task-less threads (project discussions, merge grooms) stay roots.
  const rootId =
    taskId !== null
      ? ((
          await db
            .prepare("SELECT root_thread_id FROM tasks WHERE id=?")
            .get<{ root_thread_id: number | null }>(taskId)
        )?.root_thread_id ?? null)
      : null;
  const inserted = await db
    .prepare(
      "INSERT INTO threads (project_id, kind, task_id, root_id, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id",
    )
    .get<{ id: number }>(projectId, kind, taskId, rootId, now);
  const threadId = inserted!.id;
  const stmt = db.prepare(
    `INSERT INTO thread_messages (thread_id, role, author, content, created_at, reasoning, structured, model, usage)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // Each step gets a strictly-increasing created_at (now + i) so the transcript
  // reads in true chronological order; message id stays the hard anchor.
  for (let i = 0; i < exchanges.length; i++) {
    const e = exchanges[i];
    await stmt.run(
      threadId,
      e.role,
      e.author,
      e.content,
      now + i,
      e.reasoning ?? null,
      e.structured !== undefined ? JSON.stringify(e.structured) : null,
      e.model ?? null,
      e.usage !== undefined ? JSON.stringify(e.usage) : null,
    );
  }

  // ONE ordered, typed, parent-linked session stream. A thread with no root
  // (task-less discuss, merge groom) is its own session root.
  const sessionId = rootId ?? threadId;
  const events: SessionEventInput[] =
    sessionEvents ??
    exchanges.map((e) => ({
      type: e.role === "mediator" ? "verdict" : "request",
      role: e.role,
      author: e.author,
      content: e.content,
    }));
  await appendSessionEvents(
    db,
    { projectId, sessionId, threadId, taskId, firstParentEventId: forkParentEventId ?? null },
    events,
  );
  return threadId;
}

/**
 * A discuss/reconcile cycle as a typed stream: the request, the model's
 * reasoning, each queue action woven in as a tool_call plus a matching
 * tool_result (status 'error' for actions the steward refused), then the
 * reply verdict.
 */
function discussEvents(
  author: string,
  message: string,
  reasoning: string | undefined,
  applied: { action: string; [k: string]: unknown }[],
  refused: { action: string; [k: string]: unknown }[],
  reply: string,
  role: "human" | "coder" = "human",
): SessionEventInput[] {
  const events: SessionEventInput[] = [
    { type: "request", role, author, content: message },
  ];
  if (reasoning) {
    events.push({ type: "reasoning", role: "mediator", author: "mediator", content: reasoning });
  }
  for (const a of applied) {
    events.push({ type: "tool_call", role: "mediator", author: "mediator", content: JSON.stringify(a) });
    events.push({ type: "tool_result", role: "mediator", author: "mediator", content: JSON.stringify({ ...a, outcome: "applied" }) });
  }
  for (const a of refused) {
    events.push({ type: "tool_call", role: "mediator", author: "mediator", content: JSON.stringify(a) });
    events.push({ type: "tool_result", role: "mediator", author: "mediator", content: JSON.stringify({ ...a, outcome: "refused" }), status: "error" });
  }
  events.push({ type: "verdict", role: "mediator", author: "mediator", content: reply });
  return events;
}

async function forkParentFor(db: Db, taskId: number): Promise<number | null> {
  const row = await db
    .prepare("SELECT parent_id FROM tasks WHERE id=?")
    .get<{ parent_id: number | null }>(taskId);
  if (row?.parent_id == null) return null;
  const prior = await db
    .prepare("SELECT id FROM session_events WHERE task_id=? LIMIT 1")
    .get<{ id: number }>(taskId);
  if (prior) return null;
  return lastEventForTask(db, row.parent_id);
}

/** Cap on a stored thread summary (1-2 lines). */
const THREAD_SUMMARY_MAX = 240;

/**
 * Write a 1-2 line summary onto each of a task's threads that lacks one
 * (Pi branch_summary pattern) so future ancestor/sibling references are
 * cheap. The summary is mediator-authored text lifted from the thread's
 * recorded mediator message (action/verdict + rationale) — no model call.
 * Fired when a task completes (reconcile) or is closed.
 */
async function summarizeTaskThreads(db: Db, taskId: number): Promise<void> {
  const threads = await db
    .prepare("SELECT id, kind FROM threads WHERE task_id=? AND summary IS NULL")
    .all<{ id: number; kind: string }>(taskId);
  for (const th of threads) {
    const last = await db
      .prepare("SELECT content FROM thread_messages WHERE thread_id=? AND role='mediator' ORDER BY id DESC LIMIT 1")
      .get<{ content: string }>(th.id);
    const first = await db
      .prepare("SELECT content FROM thread_messages WHERE thread_id=? ORDER BY id LIMIT 1")
      .get<{ content: string }>(th.id);
    let gist = "";
    if (last) {
      try {
        const r = JSON.parse(last.content) as Record<string, unknown>;
        const head =
          (r.action as string) ??
          (r.verdict as string) ??
          (r.escalate === true ? "escalated" : r.escalate === false ? "answered" : undefined);
        const tail = (r.rationale as string) ?? (r.reply as string) ?? (r.answer as string) ?? "";
        gist = [head, tail].filter(Boolean).join(": ");
      } catch {
        gist = last.content;
      }
    }
    const summary = oneLine(`${th.kind} → ${gist || first?.content || "(empty)"}`, THREAD_SUMMARY_MAX);
    await db.prepare("UPDATE threads SET summary=? WHERE id=?").run(summary, th.id);
  }
}

// --- "Catch me up": windowed activity digest (structure-then-generate) ---

/** The time windows a catch-up request can resolve to. */
export type WindowSpec = "today" | "yesterday" | "this_week" | "last_7_days" | "since_last_catchup";

/** A resolved absolute window [start, end) with a label and pre-formatted ISO boundaries. */
export interface ResolvedWindow {
  spec: WindowSpec;
  label: string;
  start: number;
  end: number;
  startIso: string;
  endIso: string;
}

const DAY_MS = 86_400_000;

const WINDOW_LABELS: Record<WindowSpec, string> = {
  today: "today",
  yesterday: "yesterday",
  this_week: "this week",
  last_7_days: "the last 7 days",
  since_last_catchup: "since your last catch-up",
};

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Map a member's phrasing to a window spec. A bare "catch me up" resolves to
 * since_last_catchup (per-caller high-water mark); explicit time words win.
 */
export function parseWindowSpec(message: string): WindowSpec {
  const m = message.toLowerCase();
  if (/\byesterday\b/.test(m)) return "yesterday";
  if (/\bthis week\b|\bthis_week\b/.test(m)) return "this_week";
  if (/\blast 7 days\b|\blast_7_days\b|\bpast week\b|\blast week\b/.test(m)) return "last_7_days";
  if (/\btoday\b/.test(m)) return "today";
  return "since_last_catchup";
}

/**
 * Resolve a spec to an absolute [start, end) window. The server owns the clock —
 * the model never parses a date. ISO-week aware (this_week starts Monday 00:00);
 * since_last_catchup starts at the caller's stored watermark.
 */
export function resolveWindow(spec: WindowSpec, nowMs: number, watermarkAt: number): ResolvedWindow {
  const startToday = startOfDay(nowMs);
  let start: number;
  let end = nowMs;
  switch (spec) {
    case "today":
      start = startToday;
      break;
    case "yesterday":
      start = startOfDay(startToday - 1);
      end = startToday;
      break;
    case "this_week": {
      const dow = (new Date(startToday).getDay() + 6) % 7; // days since Monday
      start = startOfDay(startToday - dow * DAY_MS);
      break;
    }
    case "last_7_days":
      start = nowMs - 7 * DAY_MS;
      break;
    case "since_last_catchup":
      start = watermarkAt > 0 ? watermarkAt : 0;
      break;
  }
  return {
    spec,
    label: WINDOW_LABELS[spec],
    start,
    end,
    startIso: new Date(start).toISOString(),
    endIso: new Date(end).toISOString(),
  };
}

/** Event-type salience: decisions/escalations/blocks/closes rank above routine churn. */
const DECISION_WEIGHT: Record<string, number> = {
  escalate: 5,
  close: 4,
  merge: 3,
  create: 3,
  revise: 2,
  approve: 2,
  clarify: 2,
  priority: 1,
  answer: 1,
  update: 1,
};

interface GatheredWindow {
  decisions: DecisionSummary[];
  completed: CompletedTaskSummary[];
  activity: AgentActivity[];
  bullets: string[];
  maxDecisionId: number;
  empty: boolean;
}

/**
 * Deterministic gather over the resolved window: decisions, completed tasks,
 * and agent activity dated inside [start, end), each salience-sorted. Produces
 * the cited core-change bullets the digest leads with — "what got fixed"
 * (completed tasks + their PRs) ahead of routine decisions.
 */
async function gatherWindow(
  db: Db,
  projectId: string,
  start: number,
  end: number,
): Promise<GatheredWindow> {
  const decisions = (
    await db
      .prepare(
        "SELECT id, task_id, kind, summary, rationale, created_at FROM decision_log WHERE project_id=? AND created_at >= ? AND created_at < ? ORDER BY id DESC",
      )
      .all<DecisionSummary>(projectId, start, end)
  ).sort(
    (a, b) =>
      (DECISION_WEIGHT[b.kind] ?? 0) - (DECISION_WEIGHT[a.kind] ?? 0) ||
      (b.created_at ?? 0) - (a.created_at ?? 0),
  );
  const completed = await db
    .prepare(
      `SELECT id, title, result_summary, result_pr_url, result_pr_number, updated_at
       FROM tasks WHERE project_id=? AND state='DONE' AND updated_at >= ? AND updated_at < ?
       ORDER BY updated_at DESC, id DESC`,
    )
    .all<CompletedTaskSummary>(projectId, start, end);
  const attempts = await db
    .prepare(
      `SELECT a.agent AS agent, a.task_id AS task_id, t.title AS title,
              a.outcome AS outcome, a.notes AS notes, a.created_at AS created_at
       FROM attempts a JOIN tasks t ON t.id = a.task_id
       WHERE t.project_id=? AND a.created_at >= ? AND a.created_at < ? ORDER BY a.id DESC`,
    )
    .all<AgentActivity>(projectId, start, end);

  const bullets: string[] = [];
  for (const c of completed) {
    const pr = c.result_pr_number ? ` (PR #${c.result_pr_number})` : "";
    bullets.push(oneLine(`- #${c.id} ${c.title} — ${c.result_summary ?? "done"}${pr}`, SUMMARY_LINE_MAX));
  }
  // High-salience decisions not already represented by a completed-task bullet.
  const completedIds = new Set(completed.map((c) => c.id));
  for (const d of decisions) {
    if ((DECISION_WEIGHT[d.kind] ?? 0) < 3) continue;
    if (d.task_id != null && completedIds.has(d.task_id)) continue;
    bullets.push(oneLine(`- DEC-${d.id} ${d.kind}: ${d.summary}`, SUMMARY_LINE_MAX));
  }

  const maxDecisionId = decisions.reduce((m, d) => Math.max(m, d.id ?? 0), 0);
  const empty = decisions.length === 0 && completed.length === 0 && attempts.length === 0;
  return { decisions, completed, activity: attempts, bullets, maxDecisionId, empty };
}

async function readCatchupWatermark(
  db: Db,
  projectId: string,
  member: string,
): Promise<{ watermark_at: number; last_decision_id: number } | undefined> {
  return db
    .prepare("SELECT watermark_at, last_decision_id FROM catchup_watermarks WHERE project_id=? AND member=?")
    .get<{ watermark_at: number; last_decision_id: number }>(projectId, member);
}

/** Advance a member's catch-up high-water mark so the next since_last_catchup only sees newer changes. */
async function writeCatchupWatermark(
  db: Db,
  projectId: string,
  member: string,
  watermarkAt: number,
  lastDecisionId: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO catchup_watermarks (project_id, member, watermark_at, last_decision_id) VALUES (?, ?, ?, ?)
       ON CONFLICT (project_id, member) DO UPDATE SET watermark_at=excluded.watermark_at, last_decision_id=excluded.last_decision_id`,
    )
    .run(projectId, member, watermarkAt, lastDecisionId);
}

export function registerPipelines(deps: PipelineDeps): void {
  const { db, queue, worker, driverFor, publicUrl, onClarification } = deps;
  const memory = new MemoryStore(db);
  const memoryTools = new MemoryTools(db);
  const projectKnowledge = new ProjectKnowledgeState(db);
  let nextBlockRecoveryAt = 0;
  worker.registerSweep(async () => {
    const now = Date.now();
    if (now < nextBlockRecoveryAt) return;
    nextBlockRecoveryAt = now + 1_000;
    await queue.recoverBlockedTasks(now);
    await queue.recoverDependencyHolds({ now });
    // Expired leases / closed plan windows are time-based transitions into
    // claimability that no mutation signals. Reclaiming them here emits the
    // `changed` that wakes a coder parked on the SSE stream (`memracer wait`),
    // and frees a crashed coder's task without waiting for the next claim.
    await queue.recoverExpiredLeases(now);
  });
  // Stale multi-round negotiations (interactive interrogation #420 / #441).
  // Default max age 7 days; cancel so non-terminal rows cannot accumulate forever.
  const NEGOTIATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  let nextNegotiationSweepAt = 0;
  worker.registerSweep(async () => {
    const now = Date.now();
    if (now < nextNegotiationSweepAt) return;
    nextNegotiationSweepAt = now + 60 * 60 * 1000;
    await new NegotiationStore(db).sweepStale(now, NEGOTIATION_TTL_MS);
  });
  const conversations = new ConversationStore(db, queue);
  // Mediator memory self-rescind is owned by task 53's write tools. Gated by
  // MEMRACER_MEMORY_RESCIND=1: off, the rescind_memory action degrades to an
  // explicit "unavailable" refusal instead of touching the bundle.
  const memoryRescindEnabled = process.env.MEMRACER_MEMORY_RESCIND === "1";
  const knowledgeLastSweep = new Map<string, number>();
  const CONSOLIDATION_SWEEP_MS = 60 * 60 * 1000;
  const consolidationScheduling = new Set<string>();

  const consolidationWatermark = async (projectId: string): Promise<string> => JSON.stringify(
    await db
      .prepare(
        `SELECT id, queue_generation FROM tasks
         WHERE project_id=? AND state='QUEUED' AND lease_agent IS NULL
           AND grooming_rationale IS NOT NULL
         ORDER BY id`,
      )
      .all<{ id: number; queue_generation: number }>(projectId),
  );

  // The groom pass is shared: submission grooming ("groom") and the warming
  // seal groom ("seal", #61) run the identical refinement pipeline. Only the
  // seal wrapper adds the graduation flip afterward.
  const groomHandler: JobHandler = async (payload, job) => {
    const { taskId, submittedBy } = payload as { taskId: number; submittedBy: string };
    const brief = await queue.brief(taskId);
    // Deferred work must not open Needs-You items. warm_for submissions are
    // born INCUBATING and still get an immediate groom; seal reuses this
    // handler at graduation and is allowed to interrogate again. Explicit HELD
    // never raises questions until the task is reopened.
    const suppressInterrogation =
      brief.state === "HELD" ||
      (brief.state === "INCUBATING" && job.kind !== "seal");
    // Duplicate-divergent conflict (#77): a DIFFERENT member's still-open twin
    // of this submission. Rather than silently merge or guess whose framing
    // wins, open a multi-human conversation between both submitters, hold both
    // tasks off the coder queue, and let it close into a recorded decision.
    if (!(await queue.taskInOpenConversation(taskId))) {
      const twin = await queue.findConflictingSubmission(
        job.project_id,
        taskId,
        submittedBy,
        brief.title,
        brief.body,
      );
      if (twin) {
        const topic = `Conflicting submissions: #${twin.id} (${twin.submitted_by}) and #${taskId} (${submittedBy}) — "${brief.title}"`;
        const opening =
          `${submittedBy} and ${twin.submitted_by} filed overlapping tasks (#${taskId}, #${twin.id}): "${brief.title}". ` +
          `Both are held pending your resolution. Reply to say whether to merge them (and into which), split them, or hold. ` +
          `Mark your decision with "RESOLVE: merge into <id>", "RESOLVE: split", or "RESOLVE: hold".`;
        const conversationId = await conversations.open(job.project_id, {
          topic,
          taskIds: [twin.id, taskId],
          participants: [submittedBy, twin.submitted_by],
          opening,
        });
        await queue.holdForConversation(taskId, `conflict with #${twin.id}`);
        await queue.holdForConversation(twin.id, `conflict with #${taskId}`);
        const decisionId = await logDecision(
          db,
          job.project_id,
          taskId,
          "clarify",
          `opened conflict conversation ${conversationId} over #${taskId} and #${twin.id}`,
          `duplicate-divergent submissions from ${submittedBy} and ${twin.submitted_by}`,
        );
        await conversations.linkDecision(conversationId, decisionId);
        queue.notifyChanged(job.project_id);
        return { action: "conflict", task_id: taskId, with_task_id: twin.id, conversation_id: conversationId };
      }
    }
    const driver = await driverFor(job.project_id, job);
    const ctx = await contextFor(db, memoryTools, job.project_id, {
      excludeTaskId: taskId,
      queryText: `${brief.title}\n${brief.body}`,
      taskId,
      history: true,
    });
    // Answered mediator clarifications (live elicitation or human_answer)
    // travel with the submission so a re-groom sees the Q&A.
    const clarifications = await db
      .prepare(
        "SELECT question, answer FROM questions WHERE task_id=? AND asked_by='mediator' AND status='answered' ORDER BY id",
      )
      .all<{ question: string; answer: string }>(taskId);
    const body =
      clarifications.length === 0
        ? brief.body
        : `${brief.body}\n\n## Clarifications from the submitter\n${clarifications
            .map((c) => `Q: ${c.question}\nA: ${c.answer}`)
            .join("\n")}`;
    // Pre-classifier (task #488): route fix/chore BEFORE the model sees the
    // submission. Emphatic prompt text alone does not stop GLM from issuing
    // invisible-slice reshape clarifies on corrective/hardening work (#470).
    // Deterministic accept skips the feature-reshape path entirely.
    const modelResult = isFixOrChore(brief.title, body)
      ? {
          action: "accept" as const,
          title: brief.title,
          body,
          priority: brief.priority,
          rationale: "pre-classified fix/chore; skipped feature reshape path",
        }
      : await driver.groom(ctx, {
          taskId,
          title: brief.title,
          body,
          priority: brief.priority,
          submittedBy,
          evidence: brief.evidence,
        });
    // Groom validation guards: the model's decision is advisory. An admitting
    // decision (accept/merge) for a research-only or held-scope submission is
    // overridden to a clarify-bounce (#39). Fixes/chores are exempt.
    const admitting = modelResult.action === "accept" || modelResult.action === "merge";
    const sourceIssue = admitting && clarifications.length === 0
      ? submissionContentIssue(brief.title, brief.body)
      : null;
    const admittedIssue = modelResult.action === "accept"
      ? submissionContentIssue(modelResult.title, modelResult.body)
      : modelResult.action === "merge"
        ? submissionContentIssue(brief.title, body)
        : null;
    const contentIssue = sourceIssue ?? admittedIssue;
    const hold = admitting
      ? contentIssue
        ? contentFreeHold(contentIssue.field, contentIssue.reason)
        : groomHold(brief.title, body, await heldScopeTopics(memory, job.project_id))
      : null;
    const result = hold
      ? ({
          action: "clarify",
          question: hold.question,
          rationale: hold.rationale,
          project_questions: modelResult.project_questions,
          knowledge_events: modelResult.knowledge_events,
        } as const)
      : modelResult;
    // All drivers share the same output boundary. OpenRouter/Pi already use
    // this schema to retry malformed model JSON; validating again here keeps
    // custom/test drivers from persisting a bundled or recommendation-free
    // clarification.
    const checkedResult = groomSchema.safeParse(result);
    if (!checkedResult.success) {
      const issues = checkedResult.error.issues.map((issue) => issue.message).join("; ");
      throw new Error(`invalid groom result: ${issues}`);
    }
    for (const event of result.knowledge_events ?? []) {
      if (!isProjectKnowledgeDomain(event.domain)) continue;
      await projectKnowledge.markEvent(
        job.project_id,
        [event.domain],
        `groom contradiction: ${event.reason}`,
      );
    }
    // Model text cites compact server-owned tokens. Resolve them while the
    // source evidence still exists; a merge points those rows at the surviving
    // destination task because applyGroomMerge moves them before deleting the
    // duplicate submission.
    const claimFor = (ownerTaskId: number) => {
      const refs = citableRefs(ctx, brief.evidence.map((row) => ({ id: row.id, taskId: ownerTaskId })));
      const rationale = sanitizeReferenceTokens(result.rationale, refs);
      return { rationale, citations: mintReferences(publicUrl, rationale, refs) };
    };
    const claim = claimFor(result.action === "merge" ? result.into_task_id : taskId);
    const groundedResult = { ...result, rationale: claim.rationale };
    // Project questions surface in Needs-You with no task link. Skip them for
    // held/incubating work so a deferred submission cannot flood the human.
    const projectQuestions = suppressInterrogation ? [] : (result.project_questions ?? []);
    if (projectQuestions.length > 0) {
      await queue.addQuestions(
        job.project_id,
        null,
        "mediator",
        projectQuestions,
      );
    }
    const meta = await captureDriverMeta(db, job, driver);
    // Weave the answered clarification Q&A into the transcript as ordered
    // steps (mediator asked, submitter answered) — not just concatenated into
    // the model prompt — so the thread reads as one conversation.
    const clarifySteps: ThreadStep[] = clarifications.flatMap((c) => [
      { role: "mediator", author: "mediator", content: c.question },
      { role: "human", author: submittedBy, content: c.answer },
    ]);
    // The same cycle as a typed session stream: the submission request, any
    // answered clarifications folded back in, the model's reasoning, the groom
    // tool call, then the verdict (or the clarifying question).
    const groomEvents: SessionEventInput[] = [
      { type: "request", role: "human", author: submittedBy, content: `${brief.title}\n${brief.body}` },
    ];
    for (const c of clarifications) {
      groomEvents.push({ type: "clarification_a", role: "human", author: submittedBy, content: `Q: ${c.question}\nA: ${c.answer}` });
    }
    const groomReasoning = modelResult.reasoning;
    if (groomReasoning) {
      groomEvents.push({ type: "reasoning", role: "mediator", author: "mediator", content: groomReasoning });
    }
    groomEvents.push({ type: "tool_call", role: "mediator", author: "mediator", content: JSON.stringify({ tool: "groom", action: groundedResult.action }) });
    if (result.action === "clarify") {
      groomEvents.push({ type: "clarification_q", role: "mediator", author: "mediator", content: result.question });
    } else {
      groomEvents.push({ type: "verdict", role: "mediator", author: "mediator", content: JSON.stringify(groundedResult) });
    }
    await recordThread(
      db,
      job.project_id,
      "groom",
      result.action === "merge" || result.action === "refuse" ? null : taskId,
      [
        { role: "human", author: submittedBy, content: `${brief.title}\n${brief.body}` },
        ...clarifySteps,
        mediatorStep(groundedResult, meta),
      ],
      groomEvents,
      result.action === "merge" || result.action === "refuse" ? null : await forkParentFor(db, taskId),
    );
    if (result.action === "refuse") {
      let removed = false;
      await db.transaction(async () => {
        removed = await queue.applyGroomRefuse(taskId, job.project_id);
        await logDecision(
          db,
          job.project_id,
          null,
          "escalate",
          `refused submission "${brief.title}"`,
          removed ? claim.rationale : `${claim.rationale} (provisional task changed concurrently and was retained)`,
        );
      });
      try {
        const open = await new NegotiationStore(db).openForSubject(taskId);
        if (open) await new NegotiationStore(db).finalize(open.id, "declined");
      } catch { /* additive */ }
      queue.notifyChanged(job.project_id);
      return { action: "refuse", task_id: taskId, removed, rationale: claim.rationale };
    }
    if (result.action === "accept") {
      // Misattribution guard (output-to-source binding): fire ONLY when the
      // groomed content canonically duplicates a DIFFERENT live task AND does
      // not derive from THIS task's own submission. That distinguishes the bug
      // (the model regurgitated a neighbor's body — content ≠ this submission)
      // from a genuine duplicate submission (content = its own submission, which
      // the merge/consolidate path handles). Only the former is a silent swap.
      const collision = await findContentCollision(db, job.project_id, taskId, result.title, result.body);
      const derivesFromOwnSubmission = collision === null || classifyTaskMerge(
        { id: taskId, title: result.title, body: result.body, evidencePaths: [] },
        { id: -1, title: brief.title, body: brief.body, evidencePaths: [] },
      ).allowed;
      if (collision !== null && !derivesFromOwnSubmission) {
        const rationale = `groom misattribution guard: proposed content matched live task ${collision} but not this task's own submission; kept the original submission. ${claim.rationale}`;
        await queue.applyGroomMergeFallback(taskId, brief.title, brief.body, brief.priority, { rationale, citations: claim.citations });
        await logDecision(db, job.project_id, taskId, "create", `created "${brief.title}" (misattribution guard: kept original submission)`, rationale, claim.citations);
        queue.notifyChanged(job.project_id);
        return { action: "accept", task_id: taskId };
      }
      // Fidelity backstop (flag-gated): nothing unconfirmed becomes claimable.
      // (a) the accept must carry its grounded extraction; (b) a fresh-context
      // judge must confirm the brief serves the same request as the submission.
      // A faithful brief with extraction falls through to applyGroomAccept.
      if (process.env.MEMRACER_GROOM_FIDELITY_ENABLED === "1") {
        // Enforce extraction presence here — the schema keeps it optional for
        // back-compat (flag-off / retry paths), so the pipeline is the gate.
        if (!result.extraction?.subject) {
          await queue.holdForMediatorClarification(
            taskId,
            job.project_id,
            `Re-groom: the accept is missing its grounded extraction (subject + in/out-of-scope). ` +
              `Restate the submission's intent first, then write the brief from it — can you re-groom this?`,
          );
          await logDecision(db, job.project_id, taskId, "hold", "groom blocked: missing grounded extraction", claim.rationale, claim.citations);
          queue.notifyChanged(job.project_id);
          return { action: "hold", task_id: taskId, reason: "missing extraction" };
        }
        const verdict = await driver.eligibility({
          submission: `${brief.title}\n${brief.body}`,
          brief: `${result.title}\n${result.body}`,
        });
        if (!verdict.serves_request) {
          await queue.holdForMediatorClarification(
            taskId,
            job.project_id,
            `Groom could not faithfully represent this submission (eligibility: ${verdict.reason}). ` +
              `The brief was about "${result.extraction.subject}" but the submission asks for something else. Re-groom or confirm the intended task?`,
          );
          await logDecision(db, job.project_id, taskId, "hold", `groom blocked: brief does not serve the submission (${verdict.reason})`, claim.rationale, claim.citations);
          await markPolicyQuality(db, taskId, "rejected");
          queue.notifyChanged(job.project_id);
          return { action: "hold", task_id: taskId, reason: verdict.reason };
        }
      }
      await queue.applyGroomAccept(taskId, result.title, result.body, result.priority, claim.rationale);
      await logDecision(db, job.project_id, taskId, "create", `created "${result.title}"`, claim.rationale, claim.citations);
      // Thread the grounded extraction into the job result so human_submit can
      // echo the reading back to the submitter for confirmation (Phase 4).
      const acceptExtraction = result.extraction;
      // Ordering edges the mediator recognized (#57): gate this task on each
      // named predecessor. An invalid/cyclic/cross-project id is skipped and
      // logged, never failing the groom — same refuse-don't-crash contract as
      // the invalid-merge fallback.
      for (const depId of result.depends_on ?? []) {
        try {
          await insertDependency(db, job.project_id, taskId, depId);
          await logDecision(db, job.project_id, taskId, "update", `task ${taskId} depends on ${depId}`, claim.rationale, claim.citations);
        } catch (err) {
          await logDecision(db, job.project_id, taskId, "update", `skipped invalid dependency ${taskId}->${depId}`, (err as Error).message);
        }
      }
      try {
        const open = await new NegotiationStore(db).openForSubject(taskId);
        if (open) await new NegotiationStore(db).finalize(open.id, "accepted");
      } catch { /* additive */ }
      queue.notifyChanged(job.project_id);
      return { action: "accept", task_id: taskId, extraction: acceptExtraction };
    }
    if (result.action === "merge") {
      const mergeResult = await queue.applyGroomMerge(taskId, result.into_task_id, {
        rationale: claim.rationale,
        citations: claim.citations,
        mode: "groom",
      });
      if (!mergeResult.merged) {
        // A stale source means another lifecycle writer won while the model
        // was running. It is no longer ours to rewrite or log as newly
        // accepted work. Target/classifier refusals may still retain the
        // source, but only through a fresh QUEUED/unleased compare-and-set.
        if (mergeResult.reason === "source_not_mergeable") {
          return { action: "merge_refused", task_id: taskId, reason: mergeResult.reason };
        }
        const fallbackClaim = claimFor(taskId);
        const rationale = `deterministic merge safety refused ${result.into_task_id} (${mergeResult.reason}); kept as its own task. Original rationale: ${fallbackClaim.rationale}`;
        const retained = await queue.applyGroomMergeFallback(
          taskId,
          brief.title,
          brief.body,
          brief.priority,
          { rationale, citations: fallbackClaim.citations },
        );
        if (!retained) {
          return { action: "merge_refused", task_id: taskId, reason: "source_not_mergeable" };
        }
        try {
          const open = await new NegotiationStore(db).openForSubject(taskId);
          if (open) await new NegotiationStore(db).finalize(open.id, "accepted");
        } catch { /* additive */ }
        return { action: "accept", task_id: taskId };
      }
      try {
        const open = await new NegotiationStore(db).openForSubject(taskId);
        if (open) await new NegotiationStore(db).finalize(open.id, "accepted");
      } catch { /* additive */ }
      return { action: "merge", into_task_id: result.into_task_id };
    }
    // Hold/incubate means "do not interrogate me about this now." Park the
    // clarify without opening a Needs-You item or flipping state to BLOCKED.
    if (suppressInterrogation) {
      await logDecision(
        db,
        job.project_id,
        taskId,
        "clarify",
        `clarification deferred while ${brief.state}`,
        claim.rationale,
        claim.citations,
      );
      queue.notifyChanged(job.project_id);
      return {
        action: "clarify_deferred",
        task_id: taskId,
        question: result.question,
        state: brief.state,
      };
    }
    const questionId = await queue.holdForMediatorClarification(taskId, job.project_id, result.question);
    // Durable multi-round interrogation (#420): open/advance a negotiation
    // keyed to the submitter identity so reconnect can resume this prompt.
    // person_owned is a structured driver field (not a regex scrape here).
    const personOwned = personOwnedFromClarify(result);
    const negotiations = new NegotiationStore(db);
    let negotiationId: string | undefined;
    try {
      const existing = await negotiations.openForSubject(taskId);
      const neg = existing ?? await negotiations.open({
        projectId: job.project_id,
        subjectKind: "submission",
        subjectTaskId: taskId,
        partyIdentity: submittedBy,
        partyRole: "human",
      });
      await negotiations.ask(neg.id, "mediator", result.question, {
        personOwned,
        questionId,
      });
      negotiationId = neg.id;
    } catch {
      // Negotiation is additive; clarify still parks the durable question.
    }
    await logDecision(db, job.project_id, taskId, "clarify", `needs clarification`, claim.rationale, claim.citations);
    queue.notifyChanged(job.project_id);
    if (onClarification) {
      void Promise.resolve(onClarification({
        projectId: job.project_id,
        taskId,
        questionId,
        question: result.question,
        submittedBy,
        negotiationId,
      })).catch(() => undefined);
    }
    return {
      action: "clarify",
      task_id: taskId,
      question: result.question,
      question_id: questionId,
      ...(negotiationId ? { negotiation_id: negotiationId } : {}),
    };
  };
  worker.register("groom", groomHandler);

  // Queue consolidation is the deterministic subset of groom merge semantics:
  // only exact, scope-compatible duplicates reach the atomic Queue recheck. It
  // is not a second grooming path and never invokes a mediator driver.
  worker.register("consolidate", async (_payload, job) => {
    const logSkip = (candidateId: number, reason: string, targetId?: number) => {
      console.info(`[queue-dedup-skip] ${JSON.stringify({
        project_id: job.project_id,
        candidate_id: candidateId,
        ...(targetId === undefined ? {} : { target_id: targetId }),
        reason,
      })}`);
    };
    const candidateRows = await db
      .prepare(
        `SELECT id, title, body, priority FROM tasks
         WHERE project_id=? AND state='QUEUED' AND lease_agent IS NULL
           AND grooming_rationale IS NOT NULL
         ORDER BY priority DESC, id`,
      )
      .all<{ id: number; title: string; body: string; priority: number }>(job.project_id);
    const evidenceRows = await db
      .prepare(
        `SELECT e.task_id, e.path FROM evidence e
         JOIN tasks t ON t.id=e.task_id
         WHERE t.project_id=? AND t.state='QUEUED' AND t.lease_agent IS NULL
           AND t.grooming_rationale IS NOT NULL AND e.path IS NOT NULL
         ORDER BY e.id`,
      )
      .all<{ task_id: number; path: string }>(job.project_id);
    const evidenceByTask = new Map<number, string[]>();
    for (const row of evidenceRows) {
      const paths = evidenceByTask.get(row.task_id) ?? [];
      paths.push(row.path);
      evidenceByTask.set(row.task_id, paths);
    }
    const candidates: Array<MergeTaskSnapshot & { priority: number }> = candidateRows.map((row) => ({
      ...row,
      evidencePaths: evidenceByTask.get(row.id) ?? [],
    }));
    const survivingIds = new Set(candidates.map((candidate) => candidate.id));
    const calls = 0;
    let merges = 0;
    const promptTokens = 0;
    const completionTokens = 0;
    const costUsd = 0;
    for (const [candidateIndex, candidate] of candidates.entries()) {
      if (!survivingIds.has(candidate.id)) continue;
      const targets = candidates.slice(0, candidateIndex).filter((possibleTarget) =>
        survivingIds.has(possibleTarget.id)
        && classifyTaskMerge(candidate, possibleTarget).allowed,
      );
      for (const target of targets) {
        const mergeResult = await queue.applyQueuedGroomMerge(
          candidate.id,
          target.id,
          job.project_id,
          {
            rationale: "deterministic exact duplicate",
            mode: "consolidate",
          },
        );
        if (!mergeResult.merged) {
          logSkip(candidate.id, mergeResult.reason, target.id);
          if (mergeResult.reason === "source_not_mergeable") {
            survivingIds.delete(candidate.id);
            break;
          }
          if (mergeResult.reason === "target_not_mergeable") survivingIds.delete(target.id);
          continue;
        }
        survivingIds.delete(candidate.id);
        merges += 1;
        break;
      }
    }
    await persistMediatorUsage(db, job, {
      promptTokens,
      completionTokens,
      costUsd,
      completionCount: 0,
    });
    const result = {
      calls,
      merges,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      cost_usd: costUsd,
      watermark: await consolidationWatermark(job.project_id),
    };
    console.info(`[queue-dedup-sweep] ${JSON.stringify({ project_id: job.project_id, ...result })}`);
    return result;
  });

  // Re-examine the durable queue at a bounded cadence. Only already-groomed,
  // QUEUED, unleased tasks enter the job; pending grooms, claims, and all other
  // lifecycle states are excluded.
  worker.registerSweep(async () => {
    const now = Date.now();
    const projects = await db.prepare("SELECT id FROM projects").all<{ id: string }>();
    for (const project of projects) {
      if (consolidationScheduling.has(project.id)) continue;
      consolidationScheduling.add(project.id);
      try {
        const latest = await db
          .prepare(
            `SELECT created_at, status, result FROM jobs
             WHERE project_id=? AND kind='consolidate'
             ORDER BY id DESC LIMIT 1`,
          )
          .get<{ created_at: number; status: string; result: string | null }>(project.id);
        if (latest && (latest.status === "pending" || latest.status === "running")) continue;
        if (latest && now - latest.created_at < CONSOLIDATION_SWEEP_MS) continue;
        const watermark = await consolidationWatermark(project.id);
        if (watermark === "[]") continue;
        let previousWatermark: string | undefined;
        try {
          previousWatermark = latest?.result
            ? (JSON.parse(latest.result) as { watermark?: string }).watermark
            : undefined;
        } catch {
          previousWatermark = undefined;
        }
        if (watermark === previousWatermark) continue;
        if (previousWatermark !== undefined) {
          try {
            const previous = new Set(
              (JSON.parse(previousWatermark) as Array<{ id: number; queue_generation: number }>)
                .map((row) => `${row.id}:${row.queue_generation}`),
            );
            const hasNewQueuedWork = (
              JSON.parse(watermark) as Array<{ id: number; queue_generation: number }>
            ).some((row) => !previous.has(`${row.id}:${row.queue_generation}`));
            if (!hasNewQueuedWork) continue;
          } catch {
            // A legacy or malformed watermark gets one repair sweep.
          }
        }
        await worker.findOrEnqueue(project.id, "consolidate", { watermark });
      } finally {
        consolidationScheduling.delete(project.id);
      }
    }
  });

  // Seal groom (#61): at incubate_until the warming task gets the full groom
  // pass, then graduates INCUBATING -> QUEUED and becomes claimable. graduate()
  // is state-guarded, so if the groom merged/closed the task it safely no-ops.
  worker.register("seal", async (payload, job) => {
    const { taskId } = payload as { taskId: number };
    const groomed = await groomHandler(payload, job);
    await queue.graduate(taskId);
    return { action: "seal", task_id: taskId, groom: groomed };
  });

  // The graduation clock: each tick, enqueue a seal groom for every INCUBATING
  // task whose incubate_until has struck. findOrEnqueue dedupes so a task past
  // due across several ticks gets exactly one in-flight seal.
  worker.registerSweep(async () => {
    for (const t of await queue.dueIncubations()) {
      await worker.findOrEnqueue(t.project_id, "seal", { taskId: t.id, submittedBy: t.submitted_by });
    }
  });

  // Incubation curation (#62): a project human contributes to an INCUBATING
  // task's warming period; the mediator arbitrates ONE contribution — merge it
  // into the canonical body, refuse it with a stated reason, or ask a
  // clarifying question — and the contribution -> mediator -> decision loop is
  // recorded on the task's incubation thread (ties to #45/#47). Reuses the
  // shared context/thread/decision machinery, not a parallel pipeline.
  worker.register("enhance", async (payload, job) => {
    const { taskId, contribution, from } = payload as { taskId: number; contribution: string; from: string };
    const brief = await queue.brief(taskId);
    // Only INCUBATING tasks are curated here; a task that graduated (or never
    // warmed) before the job ran is a no-op, recorded and returned.
    if (brief.state !== "INCUBATING") {
      await recordThread(db, job.project_id, "discuss", taskId, [
        { role: "human", author: from, content: contribution },
        { role: "system", author: "mediator", content: `task ${taskId} is ${brief.state}, not INCUBATING — no longer curatable` },
      ]);
      return { action: "skipped", task_id: taskId, state: brief.state };
    }
    const driver = await driverFor(job.project_id, job);
    const ctx = await contextFor(db, memoryTools, job.project_id, {
      excludeTaskId: taskId,
      queryText: `${brief.title}\n${contribution}`,
      taskId,
    });
    const result = await driver.enhance(ctx, {
      taskId,
      title: brief.title,
      body: brief.body,
      contribution,
      from,
    });
    const meta = await captureDriverMeta(db, job, driver);
    await recordThread(db, job.project_id, "discuss", taskId, [
      { role: "human", author: from, content: contribution },
      mediatorStep(result, meta),
    ]);
    if (result.action === "merge") {
      await db
        .prepare("UPDATE tasks SET body=?, updated_at=? WHERE id=? AND state='INCUBATING'")
        .run(result.body, Date.now(), taskId);
      await logDecision(db, job.project_id, taskId, "merge", `merged ${from}'s contribution into task ${taskId}`, result.rationale);
    } else if (result.action === "refuse") {
      await logDecision(db, job.project_id, taskId, "revise", `refused ${from}'s contribution to task ${taskId}`, result.rationale);
    } else {
      await logDecision(db, job.project_id, taskId, "clarify", `clarification on task ${taskId}: ${result.question}`, result.rationale);
    }
    queue.notifyChanged(job.project_id);
    return { ...result, task_id: taskId };
  });

  // Conciliate a multi-human conflict conversation (#77): judge whether it is
  // settled and apply the outcome over the conflicting tasks. Fired when every
  // participant has replied (early close) and by the timeout sweep with
  // expire=true (close on deadline with partial input). Idempotent: a
  // conversation already CLOSED/EXPIRED no-ops.
  worker.register("conciliate", async (payload, job) => {
    const { conversationId, expire } = payload as { conversationId: number; expire?: boolean };
    const view = await conversations.get(conversationId);
    if (!view || view.state !== "OPEN") return { noop: true, conversation_id: conversationId };
    const expired = !!expire;
    const allReplied = view.participants.every((p) => p.replied_at != null);
    // A non-expired run only conciliates once everyone has weighed in.
    if (!expired && !allReplied) return { waiting: true, conversation_id: conversationId };

    const tasks: { id: number; title: string; body: string; submittedBy: string }[] = [];
    for (const id of view.task_ids) {
      const t = await db
        .prepare("SELECT id, title, body, submitted_by FROM tasks WHERE id=?")
        .get<{ id: number; title: string; body: string; submitted_by: string }>(id);
      if (t) tasks.push({ id: t.id, title: t.title, body: t.body, submittedBy: t.submitted_by });
    }
    const driver = await driverFor(job.project_id, job);
    const ctx = await contextFor(db, memoryTools, job.project_id, { queryText: view.topic });
    const result = await driver.conciliate(ctx, {
      conversationId,
      topic: view.topic,
      tasks,
      // Only participant replies drive the verdict — the mediator's own framing
      // and prior notes are not re-fed as "what was said".
      messages: view.messages
        .filter((m) => m.role !== "mediator")
        .map((m) => ({ author: m.author, content: m.content })),
      expired,
    });
    await captureDriverMeta(db, job, driver);

    // Not settled and the deadline has not forced a decision — record the
    // mediator's note and leave the conversation OPEN for more input.
    if (!result.settled && !expired) {
      await conversations.addMediatorMessage(conversationId, result.summary || "no consensus yet — conversation stays open");
      queue.notifyChanged(job.project_id);
      return { settled: false, conversation_id: conversationId };
    }

    // Settle: release the conflict hold so the shared apply path acts on live
    // tasks, then apply the outcome (merge=close / split=annotate / hold /
    // reprioritize), write ONE conversation-linked close decision, and close.
    for (const id of view.task_ids) await queue.clearConflictHold(id);
    const { applied, refused } = await applyDiscussActions(db, job.project_id, result.actions, {
      trigger: "mediator",
      allowTaskIds: view.task_ids,
      memory,
      memoryRescindEnabled,
    });
    const state = expired ? "EXPIRED" : "CLOSED";
    const decisionId = await logDecision(
      db,
      job.project_id,
      view.task_ids[0] ?? null,
      "close",
      `conflict conversation ${conversationId} ${state.toLowerCase()}: ${result.summary}`,
      result.rationale,
    );
    await conversations.linkDecision(conversationId, decisionId);
    await conversations.addMediatorMessage(conversationId, `Settlement: ${result.summary}`);
    await conversations.close(conversationId, state, result.summary);
    queue.notifyChanged(job.project_id);
    return { settled: true, state, applied, refused, conversation_id: conversationId };
  });

  // The conversation deadline clock: each tick, force-close every OPEN
  // conversation past its deadline with whatever partial input arrived.
  // findOrEnqueue dedupes so one past-due conversation gets exactly one expire.
  worker.registerSweep(async () => {
    for (const c of await conversations.dueForTimeout()) {
      await worker.findOrEnqueue(c.project_id, "conciliate", { conversationId: c.id, expire: true });
    }
  });

  worker.register("review", async (payload, job) => {
    const { taskId, plan, filesTouched, risk, agent } = payload as {
      taskId: number; plan: string; filesTouched?: string[]; risk?: string; agent: string;
    };
    const driver = await driverFor(job.project_id, job);
    const task = (await db
      .prepare("SELECT title, body, grooming_rationale FROM tasks WHERE id=?")
      .get<{ title: string; body: string; grooming_rationale: string }>(taskId)) as {
        title: string;
        body: string;
        grooming_rationale: string;
      };
    const ctx = await contextFor(db, memoryTools, job.project_id, { queryText: `${task.title}\n${task.body}`, taskId });
    const result = await driver.review(ctx, {
      taskId,
      task: {
        title: task.title,
        body: task.body,
        groomingRationale: task.grooming_rationale,
      },
      plan,
      filesTouched,
      risk,
    });
    const meta = await captureDriverMeta(db, job, driver);
    const reviewEvents: SessionEventInput[] = [
      { type: "request", role: "coder", author: agent, content: plan },
    ];
    if (result.reasoning) {
      reviewEvents.push({ type: "reasoning", role: "mediator", author: "mediator", content: result.reasoning });
    }
    reviewEvents.push({ type: "verdict", role: "mediator", author: "mediator", content: JSON.stringify(result) });
    await recordThread(
      db,
      job.project_id,
      "review",
      taskId,
      [
        { role: "coder", author: agent, content: plan },
        mediatorStep(result, meta),
      ],
      reviewEvents,
      await forkParentFor(db, taskId),
    );
    if (result.verdict === "approved") {
      await queue.approvePlan(taskId, plan);
      await logDecision(db, job.project_id, taskId, "approve", `approved plan for task ${taskId}`, result.rationale);
      const open = await new NegotiationStore(db).openForSubject(taskId);
      if (open) await new NegotiationStore(db).finalize(open.id, "accepted");
    } else if (result.verdict === "clarify") {
      // Persist the plan draft so coder_answer / live elicit can re-review it.
      await db.prepare("UPDATE tasks SET plan = ?, updated_at = ? WHERE id = ?").run(plan, Date.now(), taskId);
      const negotiations = new NegotiationStore(db);
      let negotiationId: string | undefined;
      try {
        const existing = await negotiations.openForSubject(taskId);
        const neg = existing ?? await negotiations.open({
          projectId: job.project_id,
          subjectKind: "coder_plan",
          subjectTaskId: taskId,
          partyIdentity: agent,
          partyRole: "coder",
        });
        await negotiations.ask(neg.id, "mediator", result.feedback);
        negotiationId = neg.id;
      } catch {
        /* additive */
      }
      await logDecision(db, job.project_id, taskId, "clarify", `plan needs clarification on task ${taskId}`, result.rationale);
      queue.notifyChanged(job.project_id);
      if (onClarification && negotiationId) {
        void Promise.resolve(onClarification({
          projectId: job.project_id,
          taskId,
          questionId: 0,
          question: result.feedback,
          submittedBy: agent,
          negotiationId,
        })).catch(() => undefined);
      }
      return {
        verdict: "clarify" as const,
        feedback: result.feedback,
        ...(negotiationId ? { negotiation_id: negotiationId } : {}),
      };
    } else {
      await logDecision(db, job.project_id, taskId, "revise", `revision requested on task ${taskId}`, result.rationale);
      await markPolicyQuality(db, taskId, "rejected");
      const open = await new NegotiationStore(db).openForSubject(taskId);
      if (open) await new NegotiationStore(db).finalize(open.id, "declined");
    }
    queue.notifyChanged(job.project_id);
    return { verdict: result.verdict, feedback: result.feedback };
  });

  worker.register("answer", async (payload, job) => {
    const { taskId, question, agent } = payload as { taskId: number; question: string; agent: string };
    // taskId 0 = project-level discussion (human_discuss without a task):
    // thread and decision rows carry NULL, and escalation cannot park a task.
    const realTaskId = taskId > 0 ? taskId : null;
    const driver = await driverFor(job.project_id, job);
    const ctx = await contextFor(db, memoryTools, job.project_id, {
      queryText: question,
      taskId: realTaskId ?? undefined,
    });
    const result = await driver.answer(ctx, { taskId, question });
    const meta = await captureDriverMeta(db, job, driver);
    const answerEvents: SessionEventInput[] = [
      { type: "request", role: "coder", author: agent, content: question },
    ];
    if (result.reasoning) {
      answerEvents.push({ type: "reasoning", role: "mediator", author: "mediator", content: result.reasoning });
    }
    if (!result.escalate) {
      for (const a of result.actions ?? []) {
        answerEvents.push({ type: "tool_call", role: "mediator", author: "mediator", content: JSON.stringify(a) });
      }
    }
    answerEvents.push({ type: "verdict", role: "mediator", author: "mediator", content: JSON.stringify(result) });
    await recordThread(
      db,
      job.project_id,
      "answer",
      realTaskId,
      [
        { role: "coder", author: agent, content: question },
        mediatorStep(result, meta),
      ],
      answerEvents,
      realTaskId !== null ? await forkParentFor(db, realTaskId) : null,
    );
    if (result.escalate) {
      if (realTaskId !== null) {
        await queue.addQuestions(job.project_id, realTaskId, agent, question);
      }
      await logDecision(db, job.project_id, realTaskId, "escalate", `escalated coder question to humans`, result.rationale);
      queue.notifyChanged(job.project_id);
      return { escalated: true };
    }
    // Steward hands: the answer may carry queue actions (e.g. the question
    // revealed the task premise is wrong). The asking task itself is exempt
    // from the active-state refusal — it is CLAIMED/EXECUTING by definition.
    const { applied, refused } = await applyDiscussActions(db, job.project_id, result.actions ?? [], {
      trigger: `coder:${agent}`,
      allowTaskIds: realTaskId !== null ? [realTaskId] : [],
      memory,
      memoryRescindEnabled,
    });
    await logDecision(db, job.project_id, realTaskId, "answer", `answered coder question`, result.rationale);
    queue.notifyChanged(job.project_id);
    const references = mintReferences(publicUrl, result.answer, citableRefs(ctx));
    return { escalated: false, answer: result.answer, applied, refused, references };
  });

  worker.register("discuss", async (payload, job) => {
    const { message, from } = payload as { message: string; from: string };
    const driver = await driverFor(job.project_id, job);
    // Historian mode: the discuss brain answers meta questions over records,
    // so it needs the completed-task + agent-activity window in context.
    let ctx = await contextFor(db, memoryTools, job.project_id, { queryText: message, history: true });
    let result = await driver.discuss(ctx, { message, from });
    // Escape hatch (C9): the fixed packs missed and the historian asked for a
    // bounded read-only query. Run it ONCE, inject the rows, and re-ask — a
    // single agentic round, never a loop, never on turns the packs answered.
    if (result.query) {
      try {
        const queryResult = await runMetaQuery(db, job.project_id, result.query);
        ctx = { ...ctx, queryResult };
        result = await driver.discuss(ctx, { message, from });
      } catch (err) {
        // A refusal at the capability boundary (raw SQL, cross-project, bad
        // shape) degrades to the first-pass reply — it never fails the job.
        if (!(err instanceof MetaQueryError)) throw err;
      }
    }
    const meta = await captureDriverMeta(db, job, driver);
    // A human member is directing this — the only path where operator
    // attribution is legitimate.
    const { applied, refused } = await applyDiscussActions(db, job.project_id, result.actions, {
      trigger: `operator:${from}`,
      memory,
      memoryRescindEnabled,
    });
    // Post-validate cited ids against the supplied records; blank any the model invented.
    const reply = blankUncitedIds(result.reply, citableIds(ctx));
    await recordThread(
      db,
      job.project_id,
      "discuss",
      null,
      [
        { role: "human", author: from, content: message },
        mediatorStep({ ...result, reply }, meta),
      ],
      discussEvents(from, message, result.reasoning, applied, refused, reply),
    );
    queue.notifyChanged(job.project_id);
    const references = mintReferences(publicUrl, reply, citableRefs(ctx));
    return { reply, applied, refused, references };
  });

  worker.register("catchup", async (payload, job) => {
    const { spec, from } = payload as { spec: WindowSpec; from: string };
    const nowMs = Date.now();
    const wm = await readCatchupWatermark(db, job.project_id, from);
    const window = resolveWindow(spec, nowMs, wm?.watermark_at ?? 0);
    const gathered = await gatherWindow(db, job.project_id, window.start, window.end);
    const boundary = `${window.startIso} – ${window.endIso}`;
    // Advance the caller's high-water mark to this window's end regardless of
    // outcome, so the next since_last_catchup only reports newer changes.
    await writeCatchupWatermark(
      db,
      job.project_id,
      from,
      window.end,
      Math.max(gathered.maxDecisionId, wm?.last_decision_id ?? 0),
    );

    if (gathered.empty) {
      const reply = `No activity in ${window.label} (${boundary}).`;
      await recordThread(db, job.project_id, "discuss", null, [
        { role: "human", author: from, content: `catch me up: ${window.label}` },
        { role: "mediator", author: "mediator", content: JSON.stringify({ reply, window }) },
      ]);
      queue.notifyChanged(job.project_id);
      return { reply, window, empty: true };
    }

    // Structure gathered; now generate. Reuse the discuss/historian brain
    // (the reconcile pattern) over a context scoped to this window only.
    const driver = await driverFor(job.project_id, job);
    const ctx = await contextFor(db, memoryTools, job.project_id, { queryText: `catch up: ${window.label}` });
    ctx.decisions = gathered.decisions;
    ctx.completed = gathered.completed;
    ctx.activity = gathered.activity;
    const message =
      `Catch me up on ${window.label} (server window ${boundary}). ` +
      `Give a one-to-two sentence headline of the most important changes in this window, then nothing else — ` +
      `the cited bullet list is appended for you. Ground every claim ONLY in the supplied window records; ` +
      `cite decisions as DEC-<id> and tasks as #<id>. Take no actions.`;
    const result = await driver.discuss(ctx, { message, from });
    const meta = await captureDriverMeta(db, job, driver);
    const narrative = blankUncitedIds(result.reply, citableIds(ctx)).trim();
    const reply = [`Catch-up: ${window.label} (${boundary})`, narrative, ...gathered.bullets]
      .filter(Boolean)
      .join("\n");
    await recordThread(db, job.project_id, "discuss", null, [
      { role: "human", author: from, content: `catch me up: ${window.label}` },
      mediatorStep({ reply, window }, meta),
    ]);
    queue.notifyChanged(job.project_id);
    return { reply, window, empty: false };
  });

  worker.register("reconcile", async (payload, job) => {
    const { taskId, agent, prUrl, prDescription } = payload as {
      taskId: number; agent: string; prUrl: string; prDescription: string;
    };
    const task = (await db
      .prepare("SELECT title FROM tasks WHERE id=?")
      .get<{ title: string }>(taskId)) as { title: string };
    const message =
      `Coder ${agent} completed task #${taskId} '${task.title}'. PR: ${prUrl} — description:\n${prDescription}\n\n` +
      `Review the open queue against this completion: close now-redundant tasks, edit tasks whose scope this PR ` +
      `partially absorbed. Only act where the PR text clearly justifies it.`;
    const driver = await driverFor(job.project_id, job);
    const ctx = await contextFor(db, memoryTools, job.project_id, { queryText: message, taskId, history: true });
    // Reuse the discuss brain: same driver method, same validation/apply path.
    const result = await driver.discuss(ctx, { message, from: agent });
    const meta = await captureDriverMeta(db, job, driver);
    // Autonomous mediator review of a completion — not the coder's directive
    // and not the operator's; attribute to the mediator itself.
    const { applied, refused } = await applyDiscussActions(db, job.project_id, result.actions, {
      trigger: "mediator",
      memory,
      memoryRescindEnabled,
    });
    const reply = blankUncitedIds(result.reply, citableIds(ctx));
    await recordThread(
      db,
      job.project_id,
      "discuss",
      taskId,
      [
        { role: "coder", author: agent, content: message },
        mediatorStep({ ...result, reply }, meta),
      ],
      discussEvents(agent, message, result.reasoning, applied, refused, reply, "coder"),
      await forkParentFor(db, taskId),
    );
    // The task is complete — write the cheap 1-2 line summaries its future
    // descendants and siblings will read instead of transcripts.
    await summarizeTaskThreads(db, taskId);
    if (applied.length > 0) {
      await projectKnowledge.markEvent(
        job.project_id,
        ["priorities-roadmap", "architecture-tech", "history-decisions-learnings"],
        `completion reconciliation for task #${taskId} changed ${applied.length} queue item(s)`,
      );
    }
    queue.notifyChanged(job.project_id);
    const references = mintReferences(publicUrl, reply, citableRefs(ctx));
    return { reply, applied, refused, references };
  });

  worker.register("refresh", async (payload, job) => {
    const project = await db
      .prepare("SELECT repo FROM projects WHERE id=?")
      .get<{ repo: string | null }>(job.project_id);
    if (!project) return { action: "skipped", reason: "project deleted" };
    const payloadRequest = payload as {
      mode?: "refresh" | "answer";
      answer?: {
        question_id: number;
        question: string;
        answer: string;
        domain?: ProjectKnowledgeDomain;
      };
    };
    const durableAnswer = await pendingProjectAnswer(
      db,
      job.project_id,
      payloadRequest.answer?.question_id,
    );
    if (payloadRequest.answer && !durableAnswer) {
      return { action: "skipped", reason: "project answer is already curated or no longer eligible" };
    }
    const requested = {
      ...payloadRequest,
      ...(durableAnswer ? { mode: "answer" as const, answer: durableAnswer } : {}),
    };
    let candidates = await projectKnowledge.candidates(job.project_id);
    if (requested.answer?.domain && !candidates.some((candidate) => candidate.domain === requested.answer!.domain)) {
      candidates = [
        await projectKnowledge.answerCandidate(
          job.project_id,
          requested.answer.domain,
          requested.answer.question_id,
        ),
        ...candidates,
      ];
    } else if (requested.answer && !requested.answer.domain) {
      const present = new Set(candidates.map((candidate) => candidate.domain));
      const forced = await Promise.all(PROJECT_KNOWLEDGE_DOMAINS
        .filter((domain) => !present.has(domain.id))
        .map((domain) => projectKnowledge.answerCandidate(job.project_id, domain.id, requested.answer!.question_id)));
      candidates = [...candidates, ...forced];
    }
    if (candidates.length === 0) return { action: "none" };
    const ctx = await contextFor(db, memoryTools, job.project_id, {
      queryText: requested.answer
        ? `${requested.answer.question}\n${requested.answer.answer}`
        : candidates.flatMap((candidate) => candidate.reasons).join("\n"),
      history: true,
    });
    const driver = await driverFor(job.project_id, job);
    if (!driver.refreshProjectKnowledge) {
      return { action: "skipped", reason: "configured mediator driver does not support project knowledge refresh" };
    }
    const modelResult = await driver.refreshProjectKnowledge(ctx, {
      candidates,
      repo: project.repo,
      answer: requested.answer,
    });
    await captureDriverMeta(db, job, driver);
    const parsedResult = projectKnowledgeRefreshSchema.safeParse(modelResult);
    if (!parsedResult.success) {
      const issues = parsedResult.error.issues.map((issue) => issue.message).join("; ");
      throw new Error(`invalid project knowledge refresh result: ${issues}`);
    }
    const result = parsedResult.data;
    const byDomain = new Map(candidates.map((candidate) => [candidate.domain, candidate]));
    const diagnostics = result.checked_domains
      .filter((domain) => !byDomain.has(domain))
      .map((domain) => `ignored non-candidate checked domain ${domain}`);
    const checked = [...new Set(result.checked_domains)]
      .filter((domain): domain is ProjectKnowledgeDomain => isProjectKnowledgeDomain(domain) && byDomain.has(domain))
      .slice(0, 3);
    if (requested.answer?.domain && !checked.includes(requested.answer.domain)) {
      diagnostics.push(`answer cycle did not check ${requested.answer.domain}`);
    }
    const questions = result.questions.filter((question) => {
      const candidate = byDomain.get(question.domain);
      return candidate !== undefined && checked.includes(question.domain) && candidate.triggers.includes(question.trigger);
    }).slice(0, 3);
    const writtenPaths = [...(ctx.tools?.writtenMemoryPaths?.() ?? [])];
    const refreshed = new Set<ProjectKnowledgeDomain>();
    for (const path of writtenPaths) {
      const row = await db
        .prepare("SELECT tags FROM memory_docs WHERE project_id=? AND path=?")
        .get<{ tags: string }>(job.project_id, path);
      if (!row) continue;
      const tags = JSON.parse(row.tags) as unknown[];
      for (const tag of tags) {
        if (typeof tag !== "string" || !tag.startsWith("domain:")) continue;
        const domain = tag.slice("domain:".length);
        if (isProjectKnowledgeDomain(domain)) refreshed.add(domain);
      }
    }
    if (requested.answer?.domain && !refreshed.has(requested.answer.domain)) {
      diagnostics.push(`answer cycle did not write a concept tagged domain:${requested.answer.domain}`);
    }
    if (requested.answer && !requested.answer.domain && !checked.some((domain) => refreshed.has(domain))) {
      diagnostics.push("unclassified answer cycle did not write a domain-tagged concept in a checked domain");
    }
    if (diagnostics.length > 0) {
      console.warn(`[project-knowledge-refresh-degraded] ${JSON.stringify({
        job_id: job.id,
        project_id: job.project_id,
        mode: requested.answer ? "answer" : "refresh",
        diagnostics,
      })}`);
    }
    const ids = questions.length > 0
      ? await queue.addQuestions(job.project_id, null, "mediator", questions)
      : [];
    const refreshedChecked = [...refreshed].filter((domain) => checked.includes(domain));
    await projectKnowledge.recordCheck(
      job.project_id,
      checked.map((domain) => ({ domain, event_generation: byDomain.get(domain)!.event_generation })),
      refreshedChecked,
      Date.now(),
      requested.answer?.question_id,
    );
    const nextAnswer = await pendingProjectAnswer(db, job.project_id);
    if (nextAnswer) {
      await worker.findOrEnqueue(job.project_id, "refresh", {
        mode: "answer",
        answer: nextAnswer,
      });
    }
    const lateEvents = await db
      .prepare(
        `SELECT domain, requested_generation FROM project_context_domains
          WHERE project_id=? AND requested_generation > applied_generation`,
      )
      .all<{ domain: string; requested_generation: number }>(job.project_id);
    const genuinelyLateEvents = lateEvents.filter((event) =>
      event.requested_generation > (byDomain.get(event.domain as ProjectKnowledgeDomain)?.event_generation ?? 0)
    );
    if (genuinelyLateEvents.length > 0) {
      await worker.findOrEnqueue(job.project_id, "refresh", {
        mode: "refresh",
        after_generation: Math.max(...genuinelyLateEvents.map((event) => event.requested_generation)),
      });
    }
    queue.notifyChanged(job.project_id);
    return {
      action: refreshedChecked.length > 0 ? "refreshed" : "checked",
      checked_domains: checked,
      refreshed_domains: refreshedChecked,
      question_ids: ids,
      rationale: result.rationale,
      diagnostics,
    };
  });

  worker.registerSweep(async () => {
    const now = Date.now();
    const projects = await db.prepare("SELECT id FROM projects").all<{ id: string }>();
    for (const project of projects) {
      if (now - (knowledgeLastSweep.get(project.id) ?? 0) < PROJECT_KNOWLEDGE_SWEEP_MS) continue;
      knowledgeLastSweep.set(project.id, now);
      if (await pendingProjectAnswer(db, project.id) || (await projectKnowledge.candidates(project.id, now)).length > 0) {
        await worker.findOrEnqueue(project.id, "refresh", { mode: "refresh" });
      }
    }
  });
}
