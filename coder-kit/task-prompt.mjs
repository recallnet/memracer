// coder-kit/task-prompt.mjs — builds the prompt for one fresh coder session
// from a memracer task brief (the JSON returned by coder_claim_task).
import { isGoalTask } from "./goal-task.mjs";

function renderEvidence(evidence) {
  const lines = ["## Evidence"];
  for (const ev of evidence) {
    const loc = ev.path ? `${ev.path}${ev.lines ? `:${ev.lines}` : ""}` : null;
    lines.push(`- [${ev.kind}]${loc ? ` ${loc}` : ""}${ev.note ? ` — ${ev.note}` : ""}`);
    if (ev.snippet) lines.push("", "  ```", ...ev.snippet.split("\n").map((l) => `  ${l}`), "  ```", "");
  }
  return lines.join("\n");
}

function renderAttempts(attempts) {
  return [
    "## Prior attempts",
    ...attempts.map((a) => `- ${a.agent}: ${a.outcome}${a.notes ? ` — ${a.notes}` : ""}`),
  ].join("\n");
}

function renderQuestions(questions) {
  return [
    "## Questions",
    ...questions.map(
      (q) => `- (${q.status}) ${q.asked_by} asked: ${q.question}${q.answer ? `\n  Answer: ${q.answer}` : ""}`,
    ),
  ].join("\n");
}

/** @param {object} brief - full task brief JSON from coder_claim_task */
export function buildTaskPrompt(brief) {
  const goalTask = isGoalTask(brief);
  const meta = [`Priority: ${brief.priority}`];
  if (brief.repo) meta.push(`Repo: ${brief.repo}`);
  if (brief.base_sha) meta.push(`Base SHA: ${brief.base_sha}`);
  if (brief.grooming_rationale) meta.push(`Grooming rationale: ${brief.grooming_rationale}`);

  const sections = [
    `You are a coder agent working memracer task ${brief.id} in project ${brief.project_id}. The memracer MCP server tools (coder_*) are your only channel to the team — use them exactly as the protocol below says.`,
    `# Task ${brief.id}: ${brief.title}`,
    brief.body,
    meta.join("\n"),
  ];
  if (brief.evidence?.length) sections.push(renderEvidence(brief.evidence));
  if (brief.attempts?.length) sections.push(renderAttempts(brief.attempts));
  if (brief.questions?.length) sections.push(renderQuestions(brief.questions));

  sections.push(
    [
      "## Protocol (mandatory)",
      `All calls below use task_id ${brief.id}.`,
      "",
      `1. Before writing any code, call coder_propose_plan with your plan (and files_touched / risk). Default wait is short (~15s). If status is "pending", re-call with the SAME args after ~2s (optional wait_s≤90), or poll off-model; follow the response instruction/next fields. Only verdict "approved" lets you start; on "revise", address feedback and re-propose; on "clarify", coder_answer then continue. Do not implement while pending/revise/clarify. You have 60 minutes from claim to get a plan approved or the task returns to the queue.`,
      "2. While working, call coder_progress with a short note at least every few minutes. It renews your lease. After plan approval there is no reliable channel for mid-execution corrections, so complete the approved plan unless you need coder_ask, coder_block, or coder_release.",
      "3. If you are stuck or the task is ambiguous, call coder_ask. If the reply says escalated: true, call coder_park and stop — the task requeues when a human answers.",
      "4. Finish with coder_complete when the acceptance criteria are met. Completion requires pr_url (the merged/open PR's URL) and pr_description (the PR's description, verbatim) — open the PR first, then complete. If the task cannot proceed, call coder_block (reason); if you cannot make progress on it at all, call coder_release (reason) to give it back.",
      "5. Default to stacked PRs: make one small logical change per PR and build the next on top without waiting. Each coder_complete call carries one PR URL; deliver a multi-PR stack as sequential completions and finish the task after its final/top PR.",
      "",
      "The full task brief is also on disk at the path in $MEMRACER_TASK_FILE (.memracer-task.json).",
    ].join("\n"),
  );

  if (goalTask) {
    sections.push(
      [
        "## Goal execution",
        "This is a goal task, identified by its Goal / Verify / Invariants markers.",
        "Keep iterating until the exact Verify command produces its stated pass signal, and surface that result in coder_progress.",
        "Do not stop after an intermediate attempt merely compiles or improves the metric. Finish only when verified; if continued progress is genuinely impossible, use the protocol's blocked path.",
      ].join("\n"),
    );
  }

  return sections.join("\n\n");
}
