import { describe, expect, it } from "vitest";
import type { QueueTaskDto, TaskTransitionDto, ThreadDto } from "../src/dashboard/web/data/dto.js";
import { activityThreadGroups, attentionItems, displayTaskState, formatCountdown, hasMultipleActiveAgents, holdCauseLabel, homeSnapshot, latestTaskTransitions, liveAgentRows, onHoldRows, parseResultSummary, prPresentation, queueAgentOptions, queueRows, taskOutcome, threadSummary, trendPresentation } from "../src/dashboard/web/lib/home-model.js";

function task(id: number, state: QueueTaskDto["state"], overrides: Partial<QueueTaskDto> = {}): QueueTaskDto {
  return {
    id, state, title: `Task ${id}`, body: "", priority: id, base_sha: null, repo: null,
    submitted_by: "human", lease_agent: null, lease_expires_at: null, result_summary: null,
    result_pr_url: null, result_pr_number: null, pr_verification: null, grooming_rationale: null, parent_id: null,
    incubate_until: null, hold_cause: null, created_at: id * 10, updated_at: id * 100, evidence_count: 0,
    latest_attempt_note: null, ...overrides,
  };
}

function thread(id: number, overrides: Partial<ThreadDto> = {}): ThreadDto {
  return {
    id, kind: "review", task_id: 12, root_id: null, created_at: id, task_title: "Retire legacy toggle",
    task_state: "QUEUED", summary: null, first_message: null, last_message: null, first_human_message: null,
    last_author: "steward", last_role: "mediator", last_activity: id,
    ...overrides,
  };
}

describe("operational home model", () => {
  it("keeps current counts separate from factual attention predicates", () => {
    const now = 1_000_000;
    const rows = [
      task(1, "EXECUTING", { lease_agent: "ada", lease_expires_at: now + 299_000 }),
      task(2, "EXECUTING", { lease_agent: "grace", lease_expires_at: now + 300_000 }),
      task(8, "EXECUTING", { lease_agent: "lin", lease_expires_at: now + 299_999 }),
      task(7, "EXECUTING"),
      task(3, "QUEUED"), task(4, "BLOCKED"), task(5, "HELD"), task(6, "DONE"),
    ];
    expect(homeSnapshot(rows, now)).toMatchObject({ total: 8, open: 7, active: 3, ready: 1, done: 1, blocked: 1, held: 1, incubating: 0, on_hold: 1 });
    expect(homeSnapshot(rows, now).leaseUnderFiveMinutes.map((row) => row.id)).toEqual([1, 8]);
  });

  it("omits zero attention predicates and uses human-readable labels", () => {
    const snapshot = homeSnapshot([task(1, "BLOCKED"), task(2, "QUEUED"), task(3, "HELD")], 100);
    expect(attentionItems(snapshot)).toEqual([{ label: "stuck", count: 1, tone: "red" }]);
    expect(snapshot.held).toBe(1);
    expect(snapshot.on_hold).toBe(1);
  });

  it("lists HELD and INCUBATING rows for the On hold panel", () => {
    const rows = [
      task(10, "QUEUED"),
      task(11, "HELD", { hold_cause: "explicit", priority: 2, title: "Held legal" }),
      task(12, "INCUBATING", { incubate_until: 500, priority: 1, title: "Warm soon" }),
      task(13, "INCUBATING", { incubate_until: 100, priority: 3, title: "Warm first" }),
      task(14, "HELD", { hold_cause: "conflict", priority: 0, title: "Conflict hold" }),
      task(15, "BLOCKED"),
    ];
    expect(onHoldRows(rows).map((row) => row.id)).toEqual([13, 12, 14, 11]);
    expect(holdCauseLabel("explicit")).toBe("Held by operator");
    expect(holdCauseLabel("conflict")).toBe("Held for conflict");
    expect(holdCauseLabel(null)).toBe("On hold");
    expect(homeSnapshot(rows, 0).on_hold).toBe(4);
    expect(homeSnapshot(rows, 0).incubating).toBe(2);
  });

  it("describes positive, negative, and zero trends without bare deltas", () => {
    expect(trendPresentation(2)).toEqual({ text: "2 more", direction: "up" });
    expect(trendPresentation(-3)).toEqual({ text: "3 fewer", direction: "down" });
    expect(trendPresentation(0)).toEqual({ text: "no change", direction: "steady" });
  });

  it("keeps only the newest transition for each task without reordering tasks", () => {
    const transitions = [
      { id: 9, task_id: 3 },
      { id: 8, task_id: 3 },
      { id: 7, task_id: 1 },
      { id: 6, task_id: 2 },
      { id: 5, task_id: 1 },
    ].map(({ id, task_id }) => ({
      id,
      task_id,
      title: `Task ${task_id}`,
      from_state: "QUEUED",
      to_state: "EXECUTING",
      changed_at: id,
    } satisfies TaskTransitionDto));

    expect(latestTaskTransitions(transitions)).toEqual([
      transitions[0],
      transitions[2],
      transitions[3],
    ]);
  });

  it("uses one deterministic filter and sort projection", () => {
    const rows = [
      task(1, "QUEUED", { title: "Zulu", lease_agent: "ada", priority: 2 }),
      task(2, "QUEUED", { title: "Alpha", lease_agent: "ada", priority: 1 }),
      task(3, "DONE", { lease_agent: "ada", priority: 0 }),
      task(4, "HELD", { priority: 0 }),
      task(5, "INCUBATING", { priority: 0 }),
      task(6, "PARKED", { priority: 0 }),
      task(7, "BLOCKED", { priority: 1 }),
    ];
    expect(queueRows(rows, { state: "QUEUED", agent: "ada", sort: "title", direction: "asc" }).map((row) => row.id)).toEqual([2, 1]);
    expect(queueRows(rows, { state: null, agent: null, sort: "priority", direction: "asc" }).map((row) => row.id)).toEqual([2, 7, 1]);
    expect(queueRows(rows, { state: null, agent: null, sort: "priority", direction: "asc", includeHidden: true }).map((row) => row.id)).toEqual([4, 5, 6, 2, 7, 1]);
    expect(queueRows(rows, { state: "DONE", agent: null, sort: "priority", direction: "asc" })).toEqual([]);
    expect(queueRows(rows, { state: "HELD", agent: null, sort: "priority", direction: "asc" }).map((row) => row.id)).toEqual([4]);
  });

  it("formats expired and active lease countdowns without negative claims", () => {
    expect(formatCountdown(160_001, 100_000)).toBe("01:01");
    expect(formatCountdown(90_000, 100_000)).toBe("00:00");
  });

  it("expires live roster rows at the exact deadline", () => {
    const rows = [{ agent: "ada", task_id: 1, title: "One", state: "EXECUTING" as const, lease_expires_at: 500 }];
    expect(liveAgentRows(rows, 499)).toHaveLength(1);
    expect(liveAgentRows(rows, 500)).toEqual([]);
  });

  it("builds agent filters from queue history and retains absent deep links", () => {
    const tasks = [task(1, "BLOCKED", { lease_agent: "expired-agent" })];
    const agents = [{ agent: "live-agent", task_id: 2, title: "Two", state: "CLAIMED" as const, lease_expires_at: 999 }];
    expect(queueAgentOptions(tasks, agents, "deep-link-agent")).toEqual(["deep-link-agent", "expired-agent", "live-agent"]);
    expect(hasMultipleActiveAgents(agents)).toBe(false);
    expect(hasMultipleActiveAgents([...agents, { ...agents[0], task_id: 3 }])).toBe(false);
    expect(hasMultipleActiveAgents([...agents, { ...agents[0], agent: "second-agent", task_id: 3 }])).toBe(true);
  });

  it("uses the legacy verifying label without changing persisted state", () => {
    expect(displayTaskState("EXECUTING")).toBe("EXECUTING");
  });

  it("keeps AWAITING_MERGE tasks in the default queue with PR chip fields", () => {
    const awaiting = task(42, "AWAITING_MERGE", {
      title: "Ship root-thread fix",
      priority: 2,
      result_pr_url: "https://github.com/recallnet/memracer/pull/337",
      result_pr_number: 337,
      pr_verification: "open",
    });
    const queued = task(7, "QUEUED", { priority: 1 });
    // Default view (no showAll / includeHidden): open-PR tasks must stay visible.
    const defaultRows = queueRows([awaiting, queued], {
      state: null,
      agent: null,
      sort: "state",
      direction: "asc",
    });
    expect(defaultRows.map((row) => row.id)).toEqual([42, 7]);
    const row = defaultRows[0];
    expect(row).toMatchObject({
      state: "AWAITING_MERGE",
      result_pr_url: "https://github.com/recallnet/memracer/pull/337",
      result_pr_number: 337,
      pr_verification: "open",
    });
    // TaskPrStatus is driven by these fields (app.tsx queue summary + table).
    expect(prPresentation(row.pr_verification)).toEqual({
      merge: "Open",
      ci: "Green",
      mergeTone: "live",
      ciTone: "success",
    });
    expect(displayTaskState("AWAITING_MERGE")).toBe("Awaiting merge");
  });

  it("projects mediator actions and every fallback as human-readable thread summaries", () => {
    const root = thread(1, { kind: "submission", task_id: null, first_human_message: "Please retire the old mode" });
    const approved = thread(2, { root_id: 1, last_message: JSON.stringify({ verdict: "approved", rationale: "sound" }) });
    const clarify = thread(3, { root_id: 1, last_message: JSON.stringify({ action: "clarify", question: "Which region owns the rollout?" }) });
    const malformed = thread(4, { root_id: 1, last_message: "{not valid JSON", summary: "review → {still raw}" });
    const rows = [approved, clarify, malformed, root];
    expect(threadSummary(approved, rows)).toBe("Approved · #12 · Retire legacy toggle");
    expect(threadSummary(clarify, rows)).toBe("Clarification requested · #12 · Which region owns the rollout?");
    expect(threadSummary(malformed, rows)).toBe("Please retire the old mode");
    expect(threadSummary(thread(5, { task_id: null, task_title: null, kind: "discuss", last_message: "[]" }), [])).toBe("discuss activity");
  });

  it("collapses activity by task or root session and removes mediator-only churn", () => {
    const root = thread(1, { kind: "submission", task_id: null, first_human_message: "Build it", last_activity: 1 });
    const groom = thread(2, { kind: "groom", task_id: 41, root_id: 1, last_activity: 2 });
    const review = thread(3, { task_id: 41, root_id: 1, last_activity: 4 });
    const discuss = thread(4, { kind: "discuss", task_id: null, first_human_message: "What changed?", last_activity: 3 });
    const churn = thread(5, { kind: "groom", task_id: null, first_human_message: null, last_activity: 5 });
    expect(activityThreadGroups([root, groom, review, discuss, churn])).toEqual([
      { thread: review, threadIds: [3, 2, 1], taskId: 41, taskTitle: "Retire legacy toggle" },
      { thread: discuss, threadIds: [4], taskId: null, taskTitle: null },
    ]);
  });

  it("retains inferred task identity when a taskless root is the newest activity", () => {
    const root = thread(1, { kind: "submission", task_id: null, task_title: null, first_human_message: "Build it", last_activity: 3 });
    const groom = thread(2, { kind: "groom", task_id: 41, task_title: "Bound the queue", root_id: 1, last_activity: 2 });
    expect(activityThreadGroups([root, groom])).toEqual([
      { thread: root, threadIds: [1, 2], taskId: 41, taskTitle: "Bound the queue" },
    ]);
  });

  it("sorts by recent activity and enforces the visible-group cap", () => {
    const rows = Array.from({ length: 30 }, (_, index) => thread(index + 1, { task_id: index + 1, last_activity: index + 1 }));
    expect(activityThreadGroups(rows).map((group) => group.thread.id)).toEqual(Array.from({ length: 24 }, (_, index) => 30 - index));
    expect(activityThreadGroups(rows, 2).map((group) => group.thread.id)).toEqual([30, 29]);
  });

  it("extracts a bounded task outcome instead of exposing the full groomed body", () => {
    expect(taskOutcome("Evidence: logs\nOutcome: Restore dispatch for active work.\nAcceptance: all green", "fallback")).toBe("Restore dispatch for active work.");
    expect(taskOutcome("", "No outcome summary was recorded.")).toBe("No outcome summary was recorded.");
  });

  it("splits the coder verification claim out of result_summary", () => {
    expect(parseResultSummary(null)).toEqual({ summary: null, verification: null });
    expect(parseResultSummary("shipped")).toEqual({ summary: "shipped", verification: null });
    expect(parseResultSummary("shipped\n\nverification: pnpm test — all green")).toEqual({
      summary: "shipped",
      verification: "pnpm test — all green",
    });
    expect(parseResultSummary("multi\nline summary\n\nverification: ran vitest\nobserved 12 pass")).toEqual({
      summary: "multi\nline summary",
      verification: "ran vitest\nobserved 12 pass",
    });
    expect(parseResultSummary("verification: bare claim only")).toEqual({
      summary: null,
      verification: "bare claim only",
    });
    // Summary embeds the delimiter; server-appended claim is the last one.
    expect(
      parseResultSummary(
        "noted prior\n\nverification: not the claim\nthen finished\n\nverification: pnpm test — real claim",
      ),
    ).toEqual({
      summary: "noted prior\n\nverification: not the claim\nthen finished",
      verification: "pnpm test — real claim",
    });
  });

  it("maps pr_verification into orthogonal merge and CI labels", () => {
    expect(prPresentation("open")).toMatchObject({ merge: "Open", ci: "Green" });
    expect(prPresentation("checks-pending")).toMatchObject({ merge: "Open", ci: "Pending" });
    expect(prPresentation("checks-failing")).toMatchObject({ merge: "Open", ci: "Failing" });
    expect(prPresentation("merged-green")).toMatchObject({ merge: "Merged", ci: "Green" });
    expect(prPresentation("merged-checks-pending")).toMatchObject({ merge: "Merged", ci: "Pending" });
    expect(prPresentation("merged-checks-failing")).toMatchObject({ merge: "Merged", ci: "Failing" });
    expect(prPresentation("closed-unmerged")).toMatchObject({ merge: "Closed-unmerged", ci: null });
    expect(prPresentation("not-found")).toMatchObject({
      merge: "Gone",
      ci: null,
      mergeTone: "neutral",
      ciTone: "neutral",
    });
    expect(prPresentation(null)).toMatchObject({ merge: null, ci: null });
    expect(prPresentation(undefined)).toMatchObject({ merge: null, ci: null });
    expect(prPresentation("unknown-future")).toMatchObject({ merge: null, ci: null });
  });

});
