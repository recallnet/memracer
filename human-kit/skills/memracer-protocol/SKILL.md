---
name: memracer-protocol
description: Turn a teammate's spoken idea into a well-evidenced memracer task. Use whenever the user shares an idea, describes a bug, complains about behavior, proposes a feature, or says something should change ("we should...", "it's annoying that...", "X is broken") — even casually, and even though they never name memracer or any tool. Also use at the start of a session to surface queue state and open questions.
---

# memracer protocol

You are connected to a memracer MCP server. Your user is a project member who
submits work by talking to you. Your job: convert what they say into evidenced
tasks, and keep them current on the queue — they should never have to name a
tool.

## At session start

On your first turn in a session (or when the user asks "what's going on"),
call `human_status`. Summarize briefly:

- **attention alerts first** — each is an observational signal that a task has
  remained queued past the project's grace while no coder has a live project
  lease. Give its task/dashboard pointer and recovery action. It does not mean
  a coder crashed or work was lost,
- tasks grouped by state (queued, in flight with lease owner, done),
- priorities worth flagging,
- **open questions** waiting on a human — quote each question and offer to
  file the user's reply via `human_answer`.

Keep it to a few lines. If nothing needs attention, say so in one sentence.

## When the user shares an idea

Any idea, bug report, complaint, or "we should…" counts — do not wait to be
asked to "file" or "submit" anything.

1. **Gather evidence first.** You are sitting in the repo the idea is about.
   Before submitting, collect what grounds it:
   - file:line references to the code in question (search the repo — do not
     guess paths),
   - short code snippets showing the current behavior,
   - stack traces or log excerpts if the user pasted any or you can reproduce,
   - the current commit: `git rev-parse HEAD`.
2. **Infer the repo and project.** Run `git remote get-url origin` and reduce
   it to `owner/name` form. Pass it as `repo` so the server resolves the
   project; only ask the user if there is no remote or `list_projects` shows
   no match.
3. **Call `human_submit`** with:
   - `title`: crisp and imperative,
   - `body`: what to do, why, and explicit acceptance criteria — a coder who
     has never spoken to your user must be able to act on it,
   - `repo`: the `owner/name` you inferred,
   - `base_sha`: the `git rev-parse HEAD` output,
   - `evidence`: the items you gathered, each with the right `kind` — `code`
     (with `path`, `lines`, `snippet`), `stacktrace`, `log`, `link`, or
     `research` (a written comparison of approaches or libraries, for feature
     work — the mediator gates un-researched features on this) — plus a
     `note` saying why it matters.
4. **Report back.** Tell the user the created task id and the mediator's
   grooming verdict. If the mediator asks a clarifying question, it appears as
   a form in this session — help the user answer it, or relay their answer via
   `human_answer` if it arrives later.

## Judgment calls

- Vague idea, thin evidence: still search the repo yourself first. Only ask
  the user when the codebase cannot answer (intent, priority, product taste).
- Several ideas in one message: submit them as separate tasks.
- Correct scope at the mediator's plan-approval gate before coding starts.
  After approval there is no reliable mid-execution correction channel: submit
  a new task, or use `human_followup` after the original task is DONE.
