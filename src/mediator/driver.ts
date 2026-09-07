import type { EvidenceInput } from "../queue.js";
import type { MetaQuery, MetaQueryResult } from "./metaQuery.js";
import type { ProjectKnowledgeCandidate, ProjectKnowledgeDomain, ProjectKnowledgeTrigger } from "./project-knowledge.js";

export interface QueueTaskSummary {
  id: number;
  title: string;
  state: string;
  priority: number;
}

export interface DecisionSummary {
  kind: string;
  summary: string;
  rationale: string;
  /** Provenance — present when read from the decision_log (absent in bare fixtures). */
  id?: number;
  task_id?: number | null;
  created_at?: number;
}

/** The server's clock, injected so the model narrates in real time instead of guessing. */
export interface ServerClock {
  now_iso: string;
  timezone: string;
}

/** A completed task, read in a bounded window so "what got fixed" cites real records. */
export interface CompletedTaskSummary {
  id: number;
  title: string;
  result_summary: string | null;
  result_pr_url: string | null;
  result_pr_number: number | null;
  updated_at: number;
}

/** Per-agent activity: an attempt outcome or a live lease — grounds "who's working on what". */
export interface AgentActivity {
  agent: string;
  task_id: number;
  title: string;
  /** attempt outcome (completed/blocked/released/…) or "leased" for an active lease. */
  outcome: string;
  notes: string | null;
  created_at: number;
}

/**
 * A related task as summary fields plus the handles to pull its real content:
 * `state` distinguishes completed-before-me from concurrent work, and
 * `thread_ids` are the task's own threads — the mediator thread_reads them
 * (project-sandboxed) for the actual conversation instead of the one-liner.
 */
export interface LineageTaskSummary {
  id: number;
  title: string;
  summary: string;
  state: string;
  thread_ids: number[];
}

/**
 * Pull-based provenance pack. Conversation bytes remain behind project-scoped
 * thread_read; the pushed context carries handles and bounded task summaries.
 */
export interface TaskLineage {
  rootThreadId: number | null;
  ancestors: LineageTaskSummary[];
  ownThreadIds: number[];
  siblings: LineageTaskSummary[];
}

/** An OpenAI/OpenRouter function-calling tool definition. */
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * Agentic access to the mediator's own memory + threads: the driver's
 * tool-calling loop advertises toolDefinitions() and routes each model
 * tool-call through dispatch(). Every implementation is bound to one project,
 * so a call can never reach another tenant's OKF (see MemoryTools.bind).
 */
export interface MemoryToolExecutor {
  toolDefinitions(): ToolDefinition[];
  dispatch(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** Plans successfully retrieved during this turn and therefore citable. */
  citablePlanIds?(): ReadonlySet<number>;
  /** Successful server-observed OKF writes in this turn. */
  writtenMemoryPaths?(): ReadonlySet<string>;
}

export interface MediatorContext {
  projectId: string;
  projectName: string;
  queue: QueueTaskSummary[];
  decisions: DecisionSummary[];
  /** Rendered digest of the mediator's private OKF memory; empty when none. */
  memory: string;
  /** Current identities and project roles for this project only. */
  roster?: Array<{ name: string; role: string }>;
  /**
   * Agentic, project-scoped memory + thread tools. When present, a tool-aware
   * driver greps/reads/writes its OKF and opens cited threads on demand,
   * replacing the pushed digest. Absent for FakeDriver and isolation evals.
   */
  tools?: MemoryToolExecutor;
  /** Present only for jobs anchored to a task. */
  lineage?: TaskLineage;
  /** Server-owned clock for time-anchored narration; set on every context pack. */
  now?: ServerClock;
  /** Windowed completed-task records — the historian's "what got fixed" source. */
  completed?: CompletedTaskSummary[];
  /** Recent per-agent activity (attempts + live leases) — "who's working on what". */
  activity?: AgentActivity[];
  /**
   * Rows from the dynamic read-only query escape hatch (C9), injected on the
   * SECOND discuss pass when the fixed packs missed and the first pass asked
   * for a bounded query. Absent on the common path (packs sufficed).
   */
  queryResult?: MetaQueryResult;
}

export interface Submission {
  taskId: number;
  title: string;
  body: string;
  priority: number;
  submittedBy: string;
  evidence: EvidenceInput[];
}

/**
 * Optional model reasoning (GLM chain-of-thought), captured off the API's
 * separate reasoning channel — NOT parsed from the JSON body. Recorded as a
 * `reasoning` session event; absent for drivers/models that don't surface it.
 */
export interface WithReasoning {
  reasoning?: string;
}

export type GroomResult = (
  | {
      action: "accept";
      title: string;
      body: string;
      priority: number;
      rationale: string;
      /** Open task ids that must finish before this one (#57) — ordering edges the mediator recognized. */
      depends_on?: number[];
      /** Grounded restatement of the submission's intent (extract-then-transform). Optional for back-compat; enforced by the pipeline when the fidelity flag is on. */
      extraction?: {
        subject: string;
        current_behavior: string;
        desired_behavior: string;
        in_scope: string[];
        out_of_scope: string[];
      };
    }
  | { action: "merge"; into_task_id: number; rationale: string }
  | { action: "refuse"; rationale: string }
  | {
      action: "clarify";
      question: string;
      rationale: string;
      /**
       * When true, route the negotiation to awaiting_person (genuine human
       * decision). Drivers should set this explicitly; parsers default it when
       * absent rather than scraping model text in pipelines.
       */
      person_owned?: boolean;
    }
) &
  WithReasoning & {
    /** Durable, non-blocking product unknowns discovered during grooming. */
    project_questions?: string[];
    /** Explicit contradictions/stale context the refresh service should revisit. */
    knowledge_events?: Array<{ domain: ProjectKnowledgeDomain; reason: string }>;
  };

/** Normalize clarify person_owned once at the driver/parse boundary. */
export function personOwnedFromClarify(result: {
  question: string;
  person_owned?: boolean;
}): boolean {
  if (typeof result.person_owned === "boolean") return result.person_owned;
  // Default for drivers that omit the field: Recommended: answers are agent-owned defaults.
  return !/\brecommended\s*:/i.test(result.question);
}

export interface ReviewInput {
  taskId: number;
  task: {
    title: string;
    body: string;
    groomingRationale: string;
  };
  plan: string;
  filesTouched?: string[];
  risk?: string;
}

export interface ReviewResult extends WithReasoning {
  verdict: "approved" | "revise" | "clarify";
  feedback: string;
  rationale: string;
}

export interface AnswerInput {
  taskId: number;
  question: string;
}

export type AnswerResult = (
  | { escalate: false; answer: string; actions?: DiscussAction[]; rationale: string }
  | { escalate: true; rationale: string }
) &
  WithReasoning;

/**
 * A human contribution to an INCUBATING task's warming period (#62). Any
 * project human — not only the submitter — may enhance the canonical spec:
 * attach research, propose scope changes, or argue for cuts. The mediator
 * arbitrates, converging the spec toward its best form before graduation.
 */
export interface EnhanceInput {
  taskId: number;
  title: string;
  /** The current canonical body the contribution is evaluated against. */
  body: string;
  contribution: string;
  from: string;
}

export type EnhanceResult =
  | { action: "merge"; body: string; rationale: string }
  | { action: "refuse"; rationale: string }
  | { action: "clarify"; question: string; rationale: string };

export interface DiscussInput {
  message: string;
  from: string;
}

export type DiscussAction =
  | { action: "close_task"; task_id: number; reason: string }
  | { action: "set_priority"; task_id: number; priority: 0 | 1 | 2 | 3; reason: string }
  | { action: "update_task"; task_id: number; title?: string; body?: string; reason: string }
  | { action: "add_dependency"; dependent_task_id: number; depends_on_task_id: number; reason: string }
  | { action: "remove_dependency"; dependent_task_id: number; depends_on_task_id: number; reason: string }
  | { action: "hold"; task_id: number; reason: string }
  | { action: "reopen"; task_id: number; reason: string }
  | { action: "rescind_memory"; path: string; reason: string };

export interface DiscussResult extends WithReasoning {
  reply: string;
  actions: DiscussAction[];
  rationale: string;
  /**
   * Escape hatch (C9): when the supplied context packs cannot answer the
   * member's question, the historian may request ONE bounded, whitelisted,
   * read-only query over tasks/decisions/threads instead of guessing. The
   * pipeline runs it once, injects the rows as ctx.queryResult, and re-asks.
   * Omitted whenever the packs sufficed — a query never fires on every turn.
   */
  query?: MetaQuery;
}

/**
 * Sidecar metadata for the completion that produced the most recent driver
 * result: the model's reasoning trace (when the provider surfaces it), the
 * model id, and token usage. Captured for the thread transcript — never fed
 * back into a subsequent call.
 */
export interface CompletionUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
  cacheDiscountUsd?: number;
  costUsd?: number;
  completionCount?: number;
  /** Provider-reported cache reads in completion order, used by cache canaries. */
  cacheReadByCompletion?: number[];
  requestedModel?: string;
  resolvedModel?: string;
}

export interface CompletionMeta {
  reasoning?: string;
  model?: string;
  usage?: CompletionUsage;
}

/** A conflicting task as the conciliator sees it — enough to judge and act. */
export interface ConciliationTask {
  id: number;
  title: string;
  body: string;
  submittedBy: string;
}

/** One reply in a conflict conversation, in order. */
export interface ConciliationMessage {
  author: string;
  content: string;
}

export interface ConciliateInput {
  conversationId: number;
  topic: string;
  /** The 2+ conflicting tasks under discussion. */
  tasks: ConciliationTask[];
  /** The conversation so far (mediator framing + participant replies), in order. */
  messages: ConciliationMessage[];
  /**
   * True when the conversation hit its deadline: decide from whatever partial
   * input arrived rather than wait. The conciliator must return settled=true on
   * an expired conversation (a hold action is the natural "no consensus yet"
   * outcome) so the conversation always closes.
   */
  expired: boolean;
}

/**
 * The conciliator's verdict on a conflict conversation. settled=false keeps the
 * conversation OPEN for more input (never legal when expired); settled=true
 * applies the actions (merge/split/hold/annotate over the conflicting tasks,
 * expressed as the shared DiscussAction verbs) and closes it into a decision.
 */
export type ConciliateResult = {
  settled: boolean;
  summary: string;
  actions: DiscussAction[];
  rationale: string;
} & WithReasoning;

export interface ProjectKnowledgeRefreshInput {
  candidates: ProjectKnowledgeCandidate[];
  repo: string | null;
  answer?: {
    question_id: number;
    question: string;
    answer: string;
    /** Absent for legacy/groom-authored project questions; the mediator routes those. */
    domain?: ProjectKnowledgeDomain;
  };
}

export interface ProjectKnowledgeQuestion {
  domain: ProjectKnowledgeDomain;
  trigger: ProjectKnowledgeTrigger;
  question: string;
}

export interface ProjectKnowledgeRefreshResult extends WithReasoning {
  checked_domains: ProjectKnowledgeDomain[];
  questions: ProjectKnowledgeQuestion[];
  rationale: string;
}

export interface MediatorDriver {
  groom(ctx: MediatorContext, submission: Submission): Promise<GroomResult>;
  review(ctx: MediatorContext, input: ReviewInput): Promise<ReviewResult>;
  answer(ctx: MediatorContext, input: AnswerInput): Promise<AnswerResult>;
  discuss(ctx: MediatorContext, input: DiscussInput): Promise<DiscussResult>;
  /** Arbitrate one human contribution to an INCUBATING task's warming period (#62). */
  enhance(ctx: MediatorContext, input: EnhanceInput): Promise<EnhanceResult>;
  /**
   * Judge a multi-human conflict conversation: is it settled, and what queue
   * actions apply the outcome? Called when all participants have replied, and
   * again (with expired=true) when the deadline strikes with partial input.
   */
  conciliate(ctx: MediatorContext, input: ConciliateInput): Promise<ConciliateResult>;
  /**
   * Fresh-minimal-context faithfulness gate: does a groomed brief serve the same
   * request as its submission? Runs on the cheap tier with no tool loop — the
   * point is an independent verdict that can't inherit the groom loop's drift.
   */
  eligibility(input: { submission: string; brief: string }): Promise<{ serves_request: boolean; reason: string }>;
  /** Agentically check and curate the highest-salience project knowledge domains. */
  refreshProjectKnowledge?(ctx: MediatorContext, input: ProjectKnowledgeRefreshInput): Promise<ProjectKnowledgeRefreshResult>;
  /**
   * Return and CLEAR the metadata for the last completion this driver ran
   * (reasoning/model/usage), or undefined when the driver captures none.
   * Optional: the fake and Pi drivers omit it and the capture layer degrades
   * to no sidecar.
   */
  takeMeta?(): CompletionMeta | undefined;
  /** Return and CLEAR usage accumulated across every completion in the last driver operation. */
  takeUsage?(): CompletionUsage | undefined;
}
