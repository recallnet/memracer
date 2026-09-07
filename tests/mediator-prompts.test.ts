import { describe, expect, it, vi, afterEach } from "vitest";
import {
  SYSTEM,
  buildAnswerPrompt,
  buildConciliatePrompt,
  buildDiscussPrompt,
  buildEnhancePrompt,
  buildGroomPrompt,
  buildProjectKnowledgePrompt,
  buildRetryPrompt,
  buildReviewPrompt,
  buildTruncatedRetryPrompt,
  contextBlock,
} from "../src/mediator/prompts.js";
import { OpenRouterDriver } from "../src/mediator/openrouter.js";
import type {
  AnswerInput,
  ConciliateInput,
  DiscussInput,
  MediatorContext,
  ReviewInput,
  Submission,
} from "../src/mediator/driver.js";
import { PROJECT_KNOWLEDGE_DOMAINS } from "../src/mediator/project-knowledge.js";

const ctx: MediatorContext = {
  projectId: "p1",
  projectName: "Project One",
  queue: [{ id: 7, title: "existing task", state: "QUEUED", priority: 1 }],
  decisions: [{ kind: "groom", summary: "s", rationale: "r" }],
  memory: "",
};

const submission: Submission = {
  taskId: 9,
  title: "new task",
  body: "do the thing",
  priority: 2,
  submittedBy: "dana",
  evidence: [{ kind: "log", content: "boom" }],
};

const review: ReviewInput = {
  taskId: 7,
  task: { title: "groomed task", body: "ship piece a", groomingRationale: "split piece b into another task" },
  plan: "the plan",
  filesTouched: ["a.ts"],
  risk: "low",
};
const answer: AnswerInput = { taskId: 7, question: "which db?" };
const discuss: DiscussInput = { message: "close task 7, it shipped already", from: "dana" };
const conciliate: ConciliateInput = {
  conversationId: 3,
  topic: "overlapping queue work",
  tasks: [
    { id: 7, title: "existing task", body: "first scope", submittedBy: "dana" },
    { id: 8, title: "overlap", body: "second scope", submittedBy: "lee" },
  ],
  messages: [],
  expired: false,
};

/** Capture the exact system + user prompt OpenRouterDriver sends over the wire. */
async function capturedOpenRouterPrompt(
  invoke: (d: OpenRouterDriver) => Promise<unknown>,
  validPayload: unknown,
): Promise<{ system: string; user: string }> {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(validPayload) } }] }),
    text: async () => "",
  }));
  vi.stubGlobal("fetch", fetchMock);
  const d = new OpenRouterDriver("k", "m");
  await invoke(d);
  const body = JSON.parse((fetchMock.mock.calls[0] as unknown[])[1]!.body as string) as {
    messages: { role: string; content: string }[];
  };
  return { system: body.messages[0].content, user: body.messages[1].content };
}

afterEach(() => vi.unstubAllGlobals());

describe("shared mediator prompts", () => {
  it("identifies the shared mediator persona as Frigg", () => {
    expect(SYSTEM).toContain("Frigg, the orchestrator (mediator) for this project");
    expect(SYSTEM.startsWith("You are Frigg, the orchestrator (mediator) for this project.")).toBe(true);
    expect(SYSTEM).not.toMatch(/\bthe (?:mediator|mcp)\b/i);
  });

  it("OpenRouterDriver groom uses exactly the shared SYSTEM and groom prompt", async () => {
    const { system, user } = await capturedOpenRouterPrompt(
      (d) => d.groom(ctx, submission),
      { action: "accept", title: "t", body: "b", priority: 1, rationale: "r" },
    );
    expect(system).toBe(SYSTEM);
    expect(user).toBe(buildGroomPrompt(ctx, submission));
  });

  it("groom prompt defines done as observable/usable value and bounces invisible-slice features (#72)", () => {
    const p = buildGroomPrompt(ctx, submission);
    // definition of done: features carry a demonstrated-working acceptance clause
    expect(p).toContain("demonstrated working");
    expect(p).toContain("delivered-and-usable");
    // the invisible-slice bounce and the milestone-not-feature framing
    expect(p).toContain("invisible-slice");
    expect(p).toMatch(/working vertical/i);
    expect(p).toMatch(/milestone, not a (shippable feature|DONE feature)/i);
  });

  it("classifies corrective/hardening work as fix/chore, never invisible-slice FEATURE", () => {
    const p = buildGroomPrompt(ctx, submission);
    expect(p).toMatch(/Corrective or hardening work on an existing surface is ALWAYS fix\/chore/i);
    expect(p).toMatch(/Never reclassify a fix\/chore as an invisible-slice FEATURE/i);
    expect(p).toMatch(/invisible-slice FEATURE \(net-new FEATURE only/i);
    expect(p).toMatch(/gap fix|make[\s\S]*required|sanitization/i);
  });

  it("advertises bounded knowledge events on every groom verdict schema", () => {
    const prompt = buildGroomPrompt(ctx, submission);
    for (const action of ["accept", "merge", "clarify", "refuse"]) {
      const line = prompt.split("\n").find((candidate) => candidate.includes(`\"action\":\"${action}\"`));
      expect(line).toContain("knowledge_events");
      expect(line).toContain("domain");
      expect(line).toContain("reason");
    }
    for (const domain of PROJECT_KNOWLEDGE_DOMAINS) expect(prompt).toContain(domain.id);
  });

  it("clarify schema and instructions surface person_owned for production drivers", () => {
    const prompt = buildGroomPrompt(ctx, submission);
    const clarifyLine = prompt.split("\n").find((line) => line.includes('"action":"clarify"'));
    expect(clarifyLine).toContain("person_owned");
    expect(prompt).toMatch(/person_owned\s*:\s*true/i);
    expect(prompt).toMatch(/genuine human-owned decision/i);
  });

  it("enumerates every valid domain tag in the shared memory-tool contract", () => {
    const prompt = contextBlock({ ...ctx, tools: { toolDefinitions: () => [], dispatch: async () => ({}) } });
    for (const domain of PROJECT_KNOWLEDGE_DOMAINS) expect(prompt).toContain(`domain:${domain.id}`);
    expect(prompt).toMatch(/domain tags are optional metadata/i);
  });

  it("places the stable memory rubric before volatile project context", () => {
    const block = contextBlock({
      ...ctx,
      tools: { toolDefinitions: () => [], dispatch: async () => ({}) },
      now: { now_iso: "2026-07-18T13:00:00.000Z", timezone: "UTC" },
    });
    expect(block.indexOf("You have a private project memory"))
      .toBeLessThan(block.indexOf('Project: p1 ("Project One")'));
    expect(block.indexOf("core-assets.md")).toBeLessThan(block.indexOf("Open tasks:"));
    expect(block.indexOf("Server clock:")).toBeGreaterThan(block.indexOf("Open tasks:"));
  });

  it("grooms goals only with all three ingredients and preserves the prompt brief contract", () => {
    const p = buildGroomPrompt(ctx, submission);
    expect(p).toContain("if and only if");
    expect(p).toContain("measurable boolean end state");
    expect(p).toContain("exact runnable verification command");
    expect(p).toContain("If even one ingredient is absent");
    expect(p).toContain("Goal: <one measurable end-state sentence>");
    expect(p).toContain("Verify: <exact command and the explicit pass signal");
    expect(p).toContain("Invariants: <what must not regress and files that must not change>");
    expect(p).toContain("exactly these sections, in this order");
    for (const section of ["Outcome:", "Evidence:", "Pointers:", "Acceptance criteria:", "Verification:", "Out-of-scope:", "Constraints:"]) {
      expect(p).toContain(section);
    }
    expect(p).toContain("coder_progress");
    expect(p).toMatch(/only when the goal is verified or genuinely blocked/i);
  });

  it("enhancement preserves goal and prompt structures without introducing run caps", () => {
    const goalBody = "Goal: auth passes.\nVerify: pnpm test:auth; PASS means exit 0.\nInvariants: preserve API; do not change migrations.";
    const goalPrompt = buildEnhancePrompt(ctx, { taskId: 9, title: "auth", body: goalBody, contribution: "add coverage", from: "dana" });
    expect(goalPrompt).toContain("exactly three non-empty lines in this order");
    expect(goalPrompt).toContain("no extra or duplicate markers");
    expect(goalPrompt).toContain("exactly those three lines");
    expect(goalPrompt).toContain("preserve its exact runnable command");
    expect(goalPrompt).toContain("continuous iteration/progress");

    const promptBody = "Outcome: rename it\nEvidence: request\nPointers: src/x.ts\nAcceptance criteria: renamed\nVerification: pnpm test\nOut-of-scope: behavior\nConstraints: preserve API";
    const prompt = buildEnhancePrompt(ctx, { taskId: 10, title: "rename", body: promptBody, contribution: "include references", from: "dana" });
    expect(prompt).toContain("seven sections in their existing order");
    for (const section of ["Outcome", "Evidence", "Pointers", "Acceptance criteria", "Verification", "Out-of-scope", "Constraints"]) expect(prompt).toContain(section);
  });

  it("OpenRouterDriver review uses exactly the shared review prompt", async () => {
    const { user } = await capturedOpenRouterPrompt(
      (d) => d.review(ctx, review),
      { verdict: "approved", feedback: "", rationale: "r" },
    );
    expect(user).toBe(buildReviewPrompt(ctx, review));
  });

  it("review treats the groomed leased task as authoritative over broader lineage", () => {
    const prompt = buildReviewPrompt({
      ...ctx,
      lineage: {
        rootThreadId: 11,
        ancestors: [{ id: 3, title: "original bundle", summary: "also ship piece b", state: "DONE", thread_ids: [10] }],
        ownThreadIds: [],
        siblings: [{ id: 8, title: "piece b", summary: "moved-out work", state: "QUEUED", thread_ids: [12] }],
      },
    }, review);

    expect(prompt).toContain('"body":"ship piece a"');
    expect(prompt).toContain('"groomingRationale":"split piece b into another task"');
    expect(prompt).toContain("sole authority for scope and acceptance criteria");
    expect(prompt).toContain("never to restore requirements that grooming omitted or moved to another task");
    expect(prompt).toContain("not coder-facing revision and not a reason to escalate to a human");
  });

  it("OpenRouterDriver answer uses exactly the shared answer prompt", async () => {
    const { user } = await capturedOpenRouterPrompt(
      (d) => d.answer(ctx, answer),
      { escalate: true, rationale: "r" },
    );
    expect(user).toBe(buildAnswerPrompt(ctx, answer));
  });

  it("OpenRouterDriver retry prompt matches the shared corrective builder", async () => {
    const invalid = JSON.stringify({ nonsense: true });
    let call = 0;
    const payloads = [
      { nonsense: true },
      { escalate: true, rationale: "r" },
    ];
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(payloads[call++]) } }] }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);
    const d = new OpenRouterDriver("k", "m");
    await d.answer(ctx, answer);
    const secondBody = JSON.parse((fetchMock.mock.calls[1] as unknown[])[1]!.body as string) as {
      messages: { role: string; content: string }[];
    };
    expect(secondBody.messages[1].content).toBe(buildRetryPrompt(buildAnswerPrompt(ctx, answer), invalid));
  });

  it("truncation retry preserves the original prompt without echoing cut output", () => {
    const original = buildReviewPrompt(ctx, review);
    const retry = buildTruncatedRetryPrompt(original);
    expect(retry).toContain(original);
    expect(retry).toContain("truncated before the JSON object finished");
    expect(retry).not.toContain("previous output was invalid");
  });

  it("OpenRouterDriver discuss uses exactly the shared discuss prompt", async () => {
    const { system, user } = await capturedOpenRouterPrompt(
      (d) => d.discuss(ctx, discuss),
      { reply: "closed it", actions: [{ action: "close_task", task_id: 7, reason: "shipped" }], rationale: "r" },
    );
    expect(system).toBe(SYSTEM);
    expect(user).toBe(buildDiscussPrompt(ctx, discuss));
  });

  it("answer prompt embeds the steward-hands contract for invalid tasks", () => {
    const p = buildAnswerPrompt(ctx, answer);
    expect(p).toContain("close_task");
    expect(p).toContain("update_task");
    expect(p).toContain("set_priority");
    expect(p).toContain("at most 3");
    expect(p).toContain("state what you did");
  });

  it("discuss prompt embeds the steward contract", () => {
    const p = buildDiscussPrompt(ctx, discuss);
    expect(p).toContain('"dana"');
    expect(p).toContain(JSON.stringify(discuss.message));
    expect(p).toContain("close_task");
    expect(p).toContain("set_priority");
    expect(p).toContain("update_task");
    expect(p).toContain("CLAIMED, EXECUTING, or PLANNED");
    expect(p).toContain("no re-groom");
    expect(p).toContain("empty actions array");
  });

  it("tool-aware context carries the standing OKF discipline (#88)", () => {
    const toolCtx = { ...ctx, tools: {} as unknown as MediatorContext["tools"] };
    const block = contextBlock(toolCtx);
    // CONSUME + MAINTAIN habits, free-form types, domain folders, reciprocal links, no-slop.
    expect(block).toMatch(/CONSUME/);
    expect(block).toMatch(/MAINTAIN/);
    expect(block).toMatch(/free-form descriptive type/i);
    expect(block).toMatch(/domain folder/i);
    expect(block).toMatch(/Folder names are independent of type/i);
    expect(block).toContain("never use architecture/ as a catch-all");
    expect(block).not.toMatch(/Controlled type|off-vocab/i);
    expect(block).toMatch(/before EVERY okf_write[\s\S]*okf_grep/);
    expect(block).toMatch(/If grep finds a relevant home[\s\S]*okf_update/);
    expect(block).toMatch(/structural, no-slop bodies/i);
    expect(block).toMatch(/reciprocal/i);
    expect(block).toMatch(/latest-input-wins/i);
    expect(block).toMatch(/source_task and as_of are server-owned/i);
    expect(block).toMatch(/compare-and-swap/i);
    expect(block).toMatch(/NO SLOP/);
    expect(block).toContain("plan_grep(query) / plan_read(taskId)");
    expect(block).toContain("PLAN-<taskId>");
    expect(block).toMatch(/pull-based evidence/i);
    expect(block).toMatch(/MAY curate a durable plan-derived learning/);
    expect(block).toMatch(/do not curate every plan/i);
    // No tool context → no discipline block leaks.
    expect(contextBlock(ctx)).not.toMatch(/MAINTAIN/);
  });

  it("context block includes memory under a heading only when non-empty", () => {
    expect(contextBlock(ctx)).not.toContain("Your project memory:");
    const withMemory = { ...ctx, memory: "MEMORY-DIGEST" };
    const block = contextBlock(withMemory);
    expect(block).toContain("Your project memory:\nMEMORY-DIGEST");
    expect(buildGroomPrompt(withMemory, submission)).toContain("MEMORY-DIGEST");
    expect(buildReviewPrompt(withMemory, review)).toContain("MEMORY-DIGEST");
    expect(buildAnswerPrompt(withMemory, answer)).toContain("MEMORY-DIGEST");
  });

  it("context block renders lineage sections in provenance order, only when present", () => {
    expect(contextBlock(ctx)).not.toContain("Root submission");
    const withLineage: MediatorContext = {
      ...ctx,
      lineage: {
        rootThreadId: 11,
        ancestors: [{ id: 3, title: "parent task", summary: "groom → accept: fine", state: "DONE", thread_ids: [10] }],
        ownThreadIds: [12, 13],
        siblings: [{ id: 8, title: "sibling task", summary: "QUEUED", state: "QUEUED", thread_ids: [18] }],
      },
    };
    const block = contextBlock(withLineage);
    expect(block).toContain("Root submission thread: 11");
    expect(block).toContain("thread_read relevant ids: [12,13]");
    expect(block).not.toContain("SHARED-INTENT");
    expect(block).not.toContain("OWN-HISTORY");
    expect(block).toContain("sibling task");
    expect(block.indexOf("Root submission thread")).toBeLessThan(block.indexOf("parent task"));
    expect(block.indexOf("parent task")).toBeLessThan(block.indexOf("thread_read relevant ids"));
    expect(block.indexOf("thread_read relevant ids")).toBeLessThan(block.indexOf("sibling task"));
    expect(buildReviewPrompt(withLineage, review)).toContain("Root submission thread: 11");
  });

  it("groom prompt requires the ordered agent-ready brief fields on accept", () => {
    const p = buildGroomPrompt(ctx, submission);
    const fields = ["Outcome", "Evidence", "Pointers", "Acceptance criteria", "Verification", "Out-of-scope", "Constraints"];
    const positions = fields.map((f) => p.indexOf(f));
    for (const [i, pos] of positions.entries()) {
      expect(pos, `groom prompt must name field "${fields[i]}"`).toBeGreaterThan(-1);
    }
    // The brief fields appear in the prescribed order.
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(p).toContain("40 lines");
    expect(p).toMatch(/one logical change/i);
    expect(p).toMatch(/never exact code/i);
    // Pointers must be real, not invented.
    expect(p).toMatch(/real|verified/i);
  });

  it("groom prompt sizes tasks to agent-scale logical working groups", () => {
    const p = buildGroomPrompt(ctx, submission);
    // "one logical change" is redefined as capability/vertical-slice scale.
    expect(p).toMatch(/one logical change/i);
    expect(p).toMatch(/largest coherent|capability|vertical slice/i);
    expect(p).toMatch(/working group/i);
    // The whole coherent chunk one agent completes AND verifies in one reviewable PR.
    expect(p).toMatch(/verif/i);
    expect(p).toMatch(/single (reviewable )?PR|one (reviewable )?PR/i);
    // Splitting requires a stated concrete reason recorded in the rationale.
    expect(p).toMatch(/file-level clash|blast.?radius/i);
    expect(p).toMatch(/stated|concrete reason/i);
    expect(p).toMatch(/rationale/i);
    // Agent-aware sizing: worktree isolation + dependency-aware claiming ⇒ no pre-atomizing for file-clash fear.
    expect(p).toMatch(/worktree isolation/i);
    expect(p).toMatch(/dependency-aware claiming/i);
    expect(p).toMatch(/pre-atomize/i);
    // Genuinely unrelated bundles are still bounced — one coherent goal per task remains.
    expect(p).toMatch(/unrelated bundle/i);
    expect(p).toMatch(/one coherent goal/i);
    // Task sizing is broader than deduplication, while merge remains a strict
    // same-deliverable duplicate operation.
    expect(p).toMatch(/shaping.*splitting.*more than.*duplicat/i);
    expect(p).toMatch(/merge.*limited.*high-confidence duplicate.*same deliverable/i);
    // Consolidation across priority tiers downgrades to the lower tier.
    expect(p).toMatch(/priority tier/i);
    expect(p).toMatch(/lower/i);
  });

  it("groom prompt requires expected-vs-actual plus repro for bugs, else clarify", () => {
    const p = buildGroomPrompt(ctx, submission);
    expect(p).toMatch(/expected/i);
    expect(p).toMatch(/actual/i);
    expect(p).toMatch(/repro/i);
  });

  it("groom prompt embeds the clarification contract", () => {
    const p = buildGroomPrompt(ctx, submission);
    expect(p).toMatch(/exactly ONE question per round/);
    expect(p).toContain("Recommended: <answer>");
    expect(p).toMatch(/multiple-choice/i);
    expect(p).toMatch(/change(?:s)? the resulting diff/i);
    expect(p).toMatch(/grep/i);
    expect(p).toMatch(/never clarify a chore|skip.*chore/i);
    expect(p).toMatch(/Never bundle questions/i);
  });

  it("groom prompt separates durable project unknowns from blocking clarification", () => {
    const p = buildGroomPrompt(ctx, submission);
    expect(p).toContain("project_questions");
    expect(p).toMatch(/at most 3/i);
    expect(p).toMatch(/do NOT block this task/i);
    expect(p).toMatch(/answered asynchronously/i);
    expect(p).toMatch(/Never duplicate the clarify question/i);
  });

  it("groom prompt carries the AGENTIC-DEFAULT stance (infer-and-proceed)", () => {
    const p = buildGroomPrompt(ctx, submission);
    expect(p).toMatch(/AGENTIC-DEFAULT/);
    // Prefer accepting with stated assumptions over asking.
    expect(p).toMatch(/accept-with-stated-assumptions/i);
    // Infer the gaps a groomer can fill (pointers, verification, priority, scope) silently.
    expect(p).toMatch(/infer[^.]*pointers/i);
    expect(p).toMatch(/silently/i);
    // The clarify bar: only when it changes the outcome AND cannot be inferred.
    expect(p).toMatch(/materially change the resulting diff/i);
    expect(p).toMatch(/must not be discoverable/i);
    // A concrete target or evidence means an actionable core -> accept.
    expect(p).toMatch(/actionable core/i);
    expect(p).toMatch(/rule outranks the grilling posture/i);
    expect(p).toMatch(/Library choice, icon set, size cap, UI placement, eval structure/i);
    expect(p).toMatch(/accept immediately with zero clarifications/i);
    expect(p).not.toMatch(/settle every ambiguity up front/i);
  });

  it("groom prompt makes the mediator self-serve factual design diligence", () => {
    const p = buildGroomPrompt(ctx, submission);
    expect(p).toMatch(/SELF-SERVE FACTS/);
    expect(p).toMatch(/project memory\/OKF/);
    expect(p).toMatch(/relevant repo code/);
    expect(p).toMatch(/authoritative documentation/);
    expect(p).toMatch(/library choice is your work/i);
    expect(p).toMatch(/Never ask the human to research/i);
    expect(p).not.toMatch(/Did you research current best approaches\?/);
    expect(p).not.toMatch(/Which off-the-shelf library should we use/);
  });

  it("makes agentic curation route durable inputs to every affected core asset", () => {
    const p = contextBlock({ ...ctx, tools: { dispatch: async () => ({}), toolDefinitions: () => [] } });
    expect(p).toMatch(/every affected standing asset/i);
    expect(p).toContain("core-assets.md");
    expect(p).toContain("okf_validate");
    expect(p).toMatch(/answered question/i);
    expect(p).toMatch(/reconcile stale open questions/i);
    expect(p).toMatch(/before EVERY okf_write, call okf_grep/);
    expect(p).toMatch(/If grep finds a relevant home[\s\S]*use okf_update/);
    expect(p).toMatch(/NEW-CONCEPT EXCEPTION:[\s\S]*no matching home/);
    expect(p).toMatch(/explicitly justify why no existing concept can own it/);
  });

  it("injects the no-sprawl memory policy through every shared prompt path", () => {
    const toolCtx = { ...ctx, tools: { dispatch: async () => ({}), toolDefinitions: () => [] } };
    const prompts = [
      buildGroomPrompt(toolCtx, submission),
      buildReviewPrompt(toolCtx, review),
      buildAnswerPrompt(toolCtx, answer),
      buildDiscussPrompt(toolCtx, discuss),
      buildEnhancePrompt(toolCtx, { taskId: 9, title: "auth", body: "body", contribution: "update", from: "dana" }),
      buildConciliatePrompt(toolCtx, conciliate),
    ];
    for (const prompt of prompts) {
      expect(prompt).toMatch(/before EVERY okf_write, call okf_grep/);
      expect(prompt).toMatch(/NEW-CONCEPT EXCEPTION/);
    }
  });

  it("groom prompt bounces research-only and held-scope, exempts fixes/chores", () => {
    const p = buildGroomPrompt(ctx, submission);
    expect(p).toMatch(/research-only/i);
    expect(p).toMatch(/precondition the human/i);
    expect(p).toMatch(/investigate then fix/i);
    expect(p).toMatch(/held.scope/i);
    expect(p).toMatch(/held scope.*note.*memory|note in your project memory/i);
    expect(p).toMatch(/fixes and chores are exempt/i);
  });

  it("context block renders decision provenance, server clock, completed + activity", () => {
    const historian: MediatorContext = {
      ...ctx,
      now: { now_iso: "2026-07-14T00:00:00.000Z", timezone: "UTC" },
      decisions: [{ id: 42, task_id: 7, created_at: Date.parse("2026-07-13T00:00:00.000Z"), kind: "close", summary: "closed dup", rationale: "obsolete" }],
      completed: [
        { id: 9, title: "fix login", result_summary: "shipped", result_pr_url: "https://x/pull/12", result_pr_number: 12, updated_at: Date.parse("2026-07-12T00:00:00.000Z") },
      ],
      activity: [
        { agent: "cc-1", task_id: 5, title: "migrate", outcome: "blocked", notes: "needs creds", created_at: Date.now() },
      ],
    };
    const block = contextBlock(historian);
    expect(block).toContain("Server clock: 2026-07-14T00:00:00.000Z (UTC)");
    expect(block).toContain("[DEC-42 @ 2026-07-13T00:00:00.000Z task:7]");
    expect(block).toContain("Completed tasks");
    expect(block).toContain("pull/12");
    expect(block).toContain("Agent activity");
    expect(block).toContain("needs creds");
    expect(block.indexOf("Open tasks:")).toBeLessThan(block.indexOf("Server clock:"));
    expect(block.indexOf("Agent activity")).toBeLessThan(block.indexOf("Server clock:"));
    // Bare fixtures without ids keep the old JSON form.
    expect(contextBlock(ctx)).toContain(`Recent relevant decisions: ${JSON.stringify(ctx.decisions)}`);
    // Clock/completed/activity render only when present.
    expect(contextBlock(ctx)).not.toContain("Server clock:");
    expect(contextBlock(ctx)).not.toContain("Completed tasks");
  });

  it("filters decision context by task and terms without rewriting rationale", () => {
    const exactRationale = "Keep this exact rationale, including punctuation: alpha/beta.";
    const focused: MediatorContext = {
      ...ctx,
      decisions: [
        { id: 3, task_id: 9, kind: "scope", summary: "cache rollout", rationale: exactRationale },
        { id: 2, task_id: 88, kind: "scope", summary: "unrelated mobile polish", rationale: "other" },
        { id: 1, task_id: null, kind: "policy", summary: "project-wide safety", rationale: "always relevant" },
      ],
    };
    const prompt = buildGroomPrompt(focused, { ...submission, title: "cache rollout" });
    expect(prompt).toContain("[DEC-3");
    expect(prompt).toContain(exactRationale);
    expect(prompt).toContain("[DEC-1");
    expect(prompt).not.toContain("unrelated mobile polish");
  });

  it("discuss prompt reframes the mediator as historian with grounded, refuse-outside-window citing", () => {
    const p = buildDiscussPrompt(ctx, discuss);
    expect(p).toMatch(/historian/i);
    expect(p).toMatch(/who's working on what/i);
    expect(p).toMatch(/DEC-/);
    expect(p).toMatch(/no record/i);
    expect(p).toMatch(/never invent/i);
    // Existing steward capability survives.
    expect(p).toMatch(/close_task/);
    expect(p).toMatch(/CRITICAL/);
  });

  it("prompt builders are pure — same input, same output", () => {
    expect(buildGroomPrompt(ctx, submission)).toBe(buildGroomPrompt(ctx, submission));
    expect(buildReviewPrompt(ctx, review)).toBe(buildReviewPrompt(ctx, review));
    expect(buildAnswerPrompt(ctx, answer)).toBe(buildAnswerPrompt(ctx, answer));
    expect(buildDiscussPrompt(ctx, discuss)).toBe(buildDiscussPrompt(ctx, discuss));
  });

  it("project-knowledge prompt carries the complete agentic routing and safety contract", () => {
    const candidates = PROJECT_KNOWLEDGE_DOMAINS.map((domain) => ({
      domain: domain.id,
      label: domain.label,
      description: domain.description,
      last_refreshed_at: null,
      last_checked_at: null,
      triggers: ["STALENESS" as const],
      reasons: ["never refreshed"],
      concepts: [],
      open_question: null,
      event_generation: 0,
    }));
    const p = buildProjectKnowledgePrompt(ctx, {
      candidates,
      repo: "recallnet/memracer",
      answer: {
        question_id: 7,
        question: "Is the product boundary still accurate?",
        answer: "Yes, with one new non-goal.",
        domain: "product-bounds",
      },
    });
    for (const domain of PROJECT_KNOWLEDGE_DOMAINS) expect(p).toContain(domain.id);
    expect(p).toMatch(/attention and routing taxonomy, not fixed OKF folders/i);
    expect(p).toMatch(/AGENTIC-DEFAULT outranks taxonomy completeness/i);
    expect(p).toMatch(/not a scripted interview or a ten-step checklist/i);
    expect(p).toMatch(/check at least one and at most 3 domains/i);
    expect(p).toMatch(/Oldest knowledge wins/i);
    expect(p).toMatch(/equally old domains[\s\S]*current evidence's relevance and leverage/i);
    expect(p).toMatch(/slug is only an association, not readable source code/i);
    expect(p).toMatch(/latest-input-wins evidence/i);
    expect(p).toContain("MUST include product-bounds in checked_domains");
    expect(p).toContain("domain:<id>");
    for (const excluded of [
      "individual coder style", "exact dependency versions", "CI/deploy details",
      "unused external APIs", "personal scheduling", "debugging play-by-play",
      "competitor matrices", "social dynamics", "budgets", "social/engagement tracking",
    ]) expect(p).toContain(excluded);
  });
});
