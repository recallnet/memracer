import type {
  AnswerInput,
  AnswerResult,
  ConciliateInput,
  ConciliateResult,
  DiscussAction,
  DiscussInput,
  DiscussResult,
  EnhanceInput,
  EnhanceResult,
  GroomResult,
  MediatorContext,
  MediatorDriver,
  ProjectKnowledgeRefreshInput,
  ProjectKnowledgeRefreshResult,
  ReviewInput,
  ReviewResult,
  Submission,
} from "./driver.js";
import { groomClarificationQuestionSchema } from "./schemas.js";

/** Deterministic agent-ready brief with the ordered fields the groom prompt mandates. */
function orderedBrief(s: Submission): string {
  const research = s.evidence.find((e) => e.kind === "research");
  return [
    `Outcome: ${s.body.replace(/^FEATURE:\s*/, "")}`,
    `Evidence: ${research ? `research attached — ${research.note ?? "see evidence"}` : "submission names a concrete feature"}`,
    "Pointers: none verified yet",
    "Acceptance criteria: feature works as described; tests cover it",
    "Verification: pnpm test",
    "Out-of-scope: unrelated changes",
    `Constraints: ${research ? "follow the researched library decision" : "self-serve factual implementation choices"}`,
  ].join("\n");
}

const topicSignals: RegExp[] = [
  /\b(?:rate[ -]?limit\w*|throttl\w*|request rates?|quota|429|retry-after)\b/,
  /\b(?:public (?:rest )?api|public rest endpoints?|\/v1\/)\b/,
  /\b(?:uploads?|upload service|file uploads?)\b/,
  /\b(?:502s?|bad gateway|gateway error)\b/,
  /\b(?:sessions?|last_seen_at)\b/,
  /\b(?:json blobs?|jsonb|sessions\.data)\b/,
  /\b(?:safari(?: 17)?|apple pay|applepaysession)\b/,
  /\b(?:checkout(?: page)?)\b/,
  /\b(?:postgres|postgresql)\b/,
  /\b(?:tls certificates?|server certificates?|cert expiry|certificates? expire|new certs?)\b/,
  /\b(?:queue[.-]?wait|waitforwork|long[ -]?poll)\b/,
  /\b(?:ci|pipeline|runners?)\b/,
  /\b(?:oauth|sign[ -]?in)\b/,
  /\b(?:redirect|loops?|bounce back)\b/,
  /\b(?:state cookie|third[ -]?party cookies?)\b/,
  /\b(?:docker(?:file)?|container)\b/,
  /\b(?:worker image|image size|production layer)\b/,
  /\b(?:devdependencies|pnpm install --prod|multi[ -]?stage build)\b/,
  /\b(?:chart)\b/,
  /\b(?:tooltips?|hover labels?)\b/,
  /\b(?:modal|dialog|overlay|z-index)\b/,
];

const intentSignals: RegExp[] = [
  /\b(?:rate[ -]?limit\w*|throttl\w*|cap(?:ping)? request|429)\b/,
  /\b(?:fix|fail\w*|error|intermittent|502s?|bad gateway)\b/,
  /\b(?:migrat\w*|extract\w*|promot\w*|move .{0,30}(?:column|out of))\b/,
  /\b(?:crash\w*|typeerror|undefined is not an object)\b/,
  /\b(?:rotat\w*|roll\w*|expir\w*|new certs?)\b/,
  /\b(?:deflake|flak\w*|timeout|times out|deterministic)\b/,
  /\b(?:loops?|redirect|bounce back)\b/,
  /\b(?:reduc\w*|slim\w*|cut|stop shipping|prun\w*)\b/,
  /\b(?:hidden|behind|render underneath|z-index)\b/,
];

function normalized(text: string): string {
  return text.toLowerCase().replace(/[’']/g, "'").replace(/[_–—]/g, " ").replace(/\s+/g, " ");
}

function naturalMergeTarget(ctx: MediatorContext, s: Submission): number | undefined {
  const submission = normalized(`${s.title} ${s.body}`);
  const scored = ctx.queue.map((task) => {
    const title = normalized(task.title);
    const signals = topicSignals.filter((signal) => signal.test(submission) && signal.test(title)).length;
    const sharedIntent = intentSignals.some((signal) => signal.test(submission) && signal.test(title));
    return { id: task.id, signals, sharedIntent };
  });
  const best = Math.max(0, ...scored.map((candidate) => candidate.signals));
  const winners = scored.filter((candidate) => candidate.signals === best && candidate.sharedIntent);
  return best >= 2 && winners.length === 1 ? winners[0].id : undefined;
}

function needsClarification(s: Submission): boolean {
  if (s.evidence.length > 0) return false;
  const text = normalized(`${s.title} ${s.body}`);
  return [
    /\bmake (?:the app|it|everything) faster\b/,
    /\b(?:the )?thing from standup\b/,
    /\b(?:users? (?:are )?complaining|complaints? from users?)\b/,
    /\b(?:refresh|modernize|redesign) the (?:ui|interface)\b/,
    /\bit'?s broken for\b/,
    /\badd (?:some )?ai (?:to the product|features?)\b/,
    /\bclean up the database\b/,
  ].some((signal) => signal.test(text));
}

function revisionFeedback(input: ReviewInput): string | undefined {
  const spec = `${input.task.title} ${input.task.body}`.toLowerCase();
  const plan = input.plan.toLowerCase();
  const combined = `${plan} ${(input.risk ?? "").toLowerCase()}`;

  if (/regression test/.test(spec) && !/\b(?:test|regression)\b/.test(plan)) {
    return "Add an automated regression test that asserts the required behavior; manual verification alone does not cover the stated acceptance criterion.";
  }
  if (/create index concurrently/.test(spec) && !/\bconcurrently\b/.test(plan)) {
    return "Use CREATE INDEX CONCURRENTLY (and a concurrent rollback) so the migration satisfies the explicit no-write-lock acceptance criterion.";
  }
  if (/no user receives two digests/.test(spec) && !/\b(?:last[_ -]?digest|already sent|skip|dedup|idempoten|local date)\b/.test(plan)) {
    return "Add a persisted per-user local-date send guard and a duplicate-send test so DST transitions cannot deliver two digests in one local day.";
  }
  if (/up to 25s/.test(spec) && !/\b25\s*(?:s|sec|second)/.test(plan)) {
    return "Add the explicit 25-second force-exit bound and test it; waiting indefinitely for server.close does not satisfy the shutdown contract.";
  }
  if (/test simulates the retry/.test(spec) && !/\b(?:test|assert).{0,100}\b(?:same (?:stripe )?event|twice|replayed event|retry delivery)|\b(?:same (?:stripe )?event|twice).{0,100}\b(?:test|assert)\b/.test(plan)) {
    return "Add a replay regression test that delivers the same Stripe event twice and proves both responses are 200 with exactly one invoice side effect.";
  }
  if (/zero downtime/.test(spec) && /single update|whole table|drops? the keys|at the same time/.test(combined)) {
    return "Replace the whole-table rewrite with a resumable batched backfill and a staged dual-read/dual-write rollout so old and new readers remain compatible with zero downtime.";
  }
  if (/tokens beyond the leeway still fail/.test(spec) && /delete the iat check|remov(?:e|ing) the iat/.test(plan)) {
    return "Keep iat/nbf validation, add only the 60-second leeway, and test both the accepted skew boundary and rejection beyond it while preserving exp behavior.";
  }
  if (/root cause identified/.test(spec) && (!/root cause|investigat|diagnos/.test(plan) || !/100x|100\s*(?:uploads?|times)|soak/.test(plan) || !/alert/.test(plan))) {
    return "Diagnose and document the 502 root cause before changing nginx, then add the required 100-by-60MB upload soak and upload-5xx alert verification.";
  }
  if (/rollback path documented/.test(spec) && (/self-signed|restart postgres/.test(plan) || !/rollback/.test(plan))) {
    return "Preserve CA trust and client continuity with a staged certificate rollout; document rollback and add the required 30-day expiry alert before scheduling any restart.";
  }
  return undefined;
}

function isHumanOwnedQuestion(question: string): boolean {
  const text = normalized(question);
  return [
    /\b(?:passphrase|password|secret|credentials?|signing key)\b/,
    /\b(?:budget approval|spend approval|licen[cs]e approval|(?:do|can|should) we (?:buy|purchase|pay|spend)|(?:buy|purchase) the)\b/,
    /\b(?:contracts?|contractual|allowed to remove|deprecation window)\b/,
    /\b(?:which customers?|customer notification|customers? should we notify|who owns (?:that )?communication)\b/,
    /\b(?:business priority|customer-visible).{0,80}\b(?:tradeoff|or should|do we)\b/,
  ].some((signal) => signal.test(text));
}

export class FakeDriver implements MediatorDriver {
  async refreshProjectKnowledge(_ctx: MediatorContext, input: ProjectKnowledgeRefreshInput): Promise<ProjectKnowledgeRefreshResult> {
    const ranked = input.answer
      ? [
          ...input.candidates.filter((candidate) => candidate.domain === input.answer!.domain),
          ...input.candidates.filter((candidate) => candidate.domain !== input.answer!.domain),
        ]
      : input.candidates;
    return {
      checked_domains: ranked.slice(0, 3).map((candidate) => candidate.domain),
      questions: [],
      rationale: "checked ranked project knowledge without inventing human questions",
    };
  }

  async groom(ctx: MediatorContext, s: Submission): Promise<GroomResult> {
    const result = await this.groomImpl(ctx, s);
    // Deterministic stand-in for GLM chain-of-thought so the session's
    // reasoning event is stable across test runs.
    return { ...result, reasoning: `weighing submission "${s.title}" → ${result.action}` };
  }

  private async groomImpl(ctx: MediatorContext, s: Submission): Promise<GroomResult> {
    const refuse = /^REFUSE:\s*(.*)$/.exec(s.body);
    if (refuse) return { action: "refuse", rationale: refuse[1] || "requested outcome crosses a security boundary" };
    const merge = /^MERGE:(\d+)/.exec(s.body);
    if (merge) return { action: "merge", into_task_id: Number(merge[1]), rationale: `duplicate of task ${merge[1]}` };
    // CLARIFY-OWNED: drives person_owned:true through the full groom pipeline
    // (post-#307 e2e). Checked before plain CLARIFY: so the longer prefix wins.
    const clarifyOwned = /^CLARIFY-OWNED:\s*(.*)$/.exec(s.body);
    if (clarifyOwned) {
      const question = groomClarificationQuestionSchema.parse(clarifyOwned[1]);
      return {
        action: "clarify",
        question,
        rationale: "submission needs a human decision",
        person_owned: true,
      };
    }
    const clarify = /^CLARIFY:\s*(.*)$/.exec(s.body);
    if (clarify) {
      const question = groomClarificationQuestionSchema.parse(clarify[1]);
      return {
        action: "clarify",
        question,
        rationale: "submission is ambiguous",
        person_owned: false,
      };
    }
    // DEPENDS:<id> markers → accept with ordering edges (deterministic #57 hook).
    const deps = [...s.body.matchAll(/DEPENDS:(\d+)/g)].map((m) => Number(m[1]));
    if (deps.length > 0) {
      return { action: "accept", title: s.title, body: s.body, priority: s.priority, rationale: "accepted with dependency", depends_on: deps };
    }
    // FEATURE: marker — factual implementation gaps are self-served; a
    // concrete feature is accepted with assumptions instead of research-gated.
    if (/^FEATURE:/.test(s.body)) {
      return {
        action: "accept",
        title: s.title,
        body: orderedBrief(s),
        priority: s.priority,
        rationale: s.evidence.some((e) => e.kind === "research")
          ? "feature with research evidence"
          : "concrete feature; factual implementation gaps are self-served",
      };
    }
    const target = naturalMergeTarget(ctx, s);
    if (target !== undefined) {
      return { action: "merge", into_task_id: target, rationale: `natural-language duplicate of task ${target}` };
    }
    if (needsClarification(s)) {
      const question = groomClarificationQuestionSchema.parse(
        "What single bounded observable outcome should this task deliver? Recommended: name the smallest user-visible result that would count as done — it supplies an actionable decision without inventing broader product intent.",
      );
      return {
        action: "clarify",
        question,
        rationale: "submission has no actionable core or supporting evidence",
        person_owned: false,
      };
    }
    return { action: "accept", title: s.title, body: s.body, priority: s.priority, rationale: "accepted as submitted" };
  }

  async review(ctx: MediatorContext, input: ReviewInput): Promise<ReviewResult> {
    const result = await this.reviewImpl(ctx, input);
    return { ...result, reasoning: `assessing plan for task ${input.taskId} → ${result.verdict}` };
  }

  private async reviewImpl(_ctx: MediatorContext, input: ReviewInput): Promise<ReviewResult> {
    const clarify = /^CLARIFY:\s*(.*)$/m.exec(input.plan);
    if (clarify) {
      return {
        verdict: "clarify",
        feedback: clarify[1]?.trim() || "Need a plan decision?",
        rationale: "plan leaves an ambiguity Frigg must resolve with the coder",
      };
    }
    if (/\bbad\b/.test(input.plan)) {
      return { verdict: "revise", feedback: "plan flagged as bad", rationale: "plan contains known defect marker" };
    }
    // Wholeness bar (treatment): feature work revises hollow plans even when
    // the leased body omits standing wholeness language (historical miss).
    const spec = `${input.task.title}\n${input.task.body}\n${input.task.groomingRationale ?? ""}`;
    const featureish =
      /\bFEATURE\b/i.test(spec) ||
      /feature/i.test(input.task.groomingRationale ?? "") ||
      /wired path|demonstrated working|complete criteria|user-facing/i.test(spec);
    const plan = input.plan;
    if (featureish) {
      const deniesPath = /no browser|no end-to-end|no e2e|unit[- ]tests? only|in isolation|store only|instead of wiring/i.test(plan);
      const hasRealPath =
        !deniesPath &&
        /integration test|browser test|end-to-end test|\be2e\b|wire[sd]? (the|to|path)|live path|GET \/api|user-facing path/i.test(
          plan,
        );
      const hollowSignal =
        deniesPath ||
        /dormant|types-only|design note|markdown design|helper only|component only|document the/i.test(plan);
      if (hollowSignal && !hasRealPath) {
        return {
          verdict: "revise",
          feedback: "Wholeness gap: plan leaves the user-facing path unwired or only unit-tests a sub-component in isolation — add a wired path and integration coverage.",
          rationale: "wholeness bar: isolation/unwired feature plan",
        };
      }
    }
    const feedback = revisionFeedback(input);
    if (feedback) return { verdict: "revise", feedback, rationale: "plan misses a stated acceptance or rollout requirement" };
    return { verdict: "approved", feedback: "", rationale: "plan is sound" };
  }

  async answer(ctx: MediatorContext, input: AnswerInput): Promise<AnswerResult> {
    const result = await this.answerImpl(ctx, input);
    return { ...result, reasoning: `resolving question → ${result.escalate ? "escalate" : "answer"}` };
  }

  private async answerImpl(_ctx: MediatorContext, input: AnswerInput): Promise<AnswerResult> {
    const close = /close task (\d+): ([^\n]+)/.exec(input.question);
    if (close) {
      return {
        escalate: false,
        answer: `closed task ${close[1]}: ${close[2]}`,
        actions: [{ action: "close_task", task_id: Number(close[1]), reason: close[2] }],
        rationale: "question revealed the task premise is wrong",
      };
    }
    if (/escalate/.test(input.question)) return { escalate: true, rationale: "needs a human" };
    if (isHumanOwnedQuestion(input.question)) return { escalate: true, rationale: "requires a human-owned decision or credential" };
    return { escalate: false, answer: "42", rationale: "answered from context" };
  }

  async discuss(ctx: MediatorContext, input: DiscussInput): Promise<DiscussResult> {
    const result = await this.discussImpl(ctx, input);
    return { ...result, reasoning: `parsed ${result.actions.length} directive(s) from message` };
  }

  private async discussImpl(ctx: MediatorContext, input: DiscussInput): Promise<DiscussResult> {
    // Escape hatch: the query already ran (rows injected). Ground the reply in
    // the first returned row's id — deterministic stand-in for the historian
    // citing real query evidence. A fabricated id is included to prove the
    // pipeline blanks uncited ids.
    if (ctx.queryResult) {
      const first = ctx.queryResult.rows[0] as { id?: number; task_id?: number } | undefined;
      const id = first?.id ?? first?.task_id;
      const cited = id !== undefined ? `#${id}` : "no matching record";
      return { reply: `found ${cited} (and phantom #999999)`, actions: [], rationale: "grounded in query rows" };
    }
    // QUERY:<entity> [kind=<k>] [actor=<a>] marker simulates a pack-miss: the
    // fixed packs can't answer, so request one bounded parameterized query.
    const q = /QUERY:(tasks|decisions|threads)(?:\s+kind=(\S+))?(?:\s+actor=(\S+))?/.exec(input.message);
    if (q) {
      return {
        reply: "",
        actions: [],
        rationale: "packs missed — requesting a bounded query",
        query: {
          entity: q[1] as "tasks" | "decisions" | "threads",
          ...(q[2] ? { kind: q[2] } : {}),
          ...(q[3] ? { actor: q[3] } : {}),
        },
      };
    }
    const actions: DiscussAction[] = [];
    for (const m of input.message.matchAll(/close task (\d+): ([^\n]+)/g)) {
      actions.push({ action: "close_task", task_id: Number(m[1]), reason: m[2] });
    }
    for (const m of input.message.matchAll(/set task (\d+) to P([0-3])/g)) {
      actions.push({ action: "set_priority", task_id: Number(m[1]), priority: Number(m[2]) as 0 | 1 | 2 | 3, reason: "member request" });
    }
    for (const m of input.message.matchAll(/hold task (\d+): ([^\n]+)/g)) {
      actions.push({ action: "hold", task_id: Number(m[1]), reason: m[2] });
    }
    for (const m of input.message.matchAll(/reopen task (\d+): ([^\n]+)/g)) {
      actions.push({ action: "reopen", task_id: Number(m[1]), reason: m[2] });
    }
    for (const m of input.message.matchAll(/rescind memory (\S+): ([^\n]+)/g)) {
      actions.push({ action: "rescind_memory", path: m[1], reason: m[2] });
    }
    if (actions.length === 0) return { reply: "noted", actions: [], rationale: "no directives in the message" };
    return { reply: `done: ${actions.length} action(s)`, actions, rationale: "parsed member directives" };
  }

  async enhance(_ctx: MediatorContext, input: EnhanceInput): Promise<EnhanceResult> {
    // Deterministic warming-period arbitration (#62). Markers on the
    // contribution stand in for the mediator's judgment:
    //   SCOPECREEP…  → refuse with a stated reason
    //   CLARIFY: q   → ask the clarifying question q
    //   anything else → merge into a tighter canonical body
    if (/^SCOPECREEP\b/.test(input.contribution)) {
      return { action: "refuse", rationale: `out of scope for task ${input.taskId}: ${input.contribution}` };
    }
    const clarify = /^CLARIFY:\s*(.*)$/.exec(input.contribution);
    if (clarify) {
      return { action: "clarify", question: clarify[1], rationale: "contribution leaves an ambiguity" };
    }
    const body = `${input.body}\n\nContribution from ${input.from}: ${input.contribution}`;
    return { action: "merge", body, rationale: `merged ${input.from}'s contribution into the canonical spec` };
  }

  async eligibility(input: { submission: string; brief: string }): Promise<{ serves_request: boolean; reason: string }> {
    // Deterministic stand-in for goal-drift: require shared subject tokens
    // between submission and brief (no planted cheat markers).
    const stop = new Set([
      "with", "from", "that", "this", "when", "into", "than", "then", "them", "they",
      "have", "been", "were", "will", "your", "their", "about", "after", "before",
      "should", "would", "could", "must", "does", "make", "made", "using", "used",
      "path", "test", "tests", "only", "full", "real", "live", "user", "work",
      "task", "plan", "add", "fix", "ship", "new", "the", "and", "for", "are",
    ]);
    const tokens = (text: string) =>
      new Set(
        text
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, " ")
          .split(/\s+/)
          .filter((w) => w.length >= 4 && !stop.has(w)),
      );
    const sub = tokens(input.submission);
    const brief = tokens(input.brief);
    if (sub.size === 0) {
      return { serves_request: true, reason: "empty submission subject; cannot judge drift" };
    }
    let shared = 0;
    for (const t of sub) {
      if (brief.has(t)) shared += 1;
    }
    // Need at least one shared subject token; inventing an adjacent product fails.
    if (shared === 0) {
      return {
        serves_request: false,
        reason: "brief shares no subject tokens with the submission (goal drift)",
      };
    }
    return { serves_request: true, reason: "brief shares subject tokens with the submission" };
  }

  async conciliate(ctx: MediatorContext, input: ConciliateInput): Promise<ConciliateResult> {
    const result = await this.conciliateImpl(ctx, input);
    return { ...result, reasoning: `conciliating conversation ${input.conversationId} → ${result.settled ? "settled" : "open"}` };
  }

  private async conciliateImpl(_ctx: MediatorContext, input: ConciliateInput): Promise<ConciliateResult> {
    const transcript = input.messages.map((m) => m.content).join("\n");
    // RESOLVE: merge into N — keep task N, close every other conflicting task.
    const merge = /RESOLVE:\s*merge into (\d+)/i.exec(transcript);
    if (merge) {
      const keep = Number(merge[1]);
      const actions: DiscussAction[] = input.tasks
        .filter((t) => t.id !== keep)
        .map((t) => ({ action: "close_task", task_id: t.id, reason: `merged into task ${keep}` }));
      return { settled: true, summary: `merged conflicting tasks into #${keep}`, actions, rationale: "participants agreed to consolidate" };
    }
    // RESOLVE: split — keep both, annotate each surviving task's scope.
    if (/RESOLVE:\s*split/i.test(transcript)) {
      const actions: DiscussAction[] = input.tasks.map((t) => ({
        action: "update_task",
        task_id: t.id,
        body: `${t.body}\n\nScope narrowed by conversation ${input.conversationId}.`,
        reason: "participants agreed to keep both, narrowed scope",
      }));
      return { settled: true, summary: "kept both tasks with narrowed scope", actions, rationale: "participants diverged on scope, split" };
    }
    // Explicit hold, or an expired conversation with no consensus → hold all.
    if (/RESOLVE:\s*hold/i.test(transcript) || input.expired) {
      const actions: DiscussAction[] = input.tasks.map((t) => ({
        action: "hold",
        task_id: t.id,
        reason: input.expired ? "conversation expired without consensus" : "held pending a human decision",
      }));
      return {
        settled: true,
        summary: input.expired ? "expired without consensus; conflicting tasks held" : "held pending decision",
        actions,
        rationale: input.expired ? "deadline reached with partial input" : "participants deferred",
      };
    }
    // No resolution signal yet and not expired — keep the conversation open.
    return { settled: false, summary: "no consensus yet", actions: [], rationale: "awaiting a resolution from the participants" };
  }

}
