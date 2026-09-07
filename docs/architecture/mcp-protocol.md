# MCP protocol surface

The human.* and coder.* tool surfaces, spec targeting, and the transport patterns (long-poll, tasks, elicitation) memracer builds on.

# Implementation status

MCP tool names must match `[a-zA-Z0-9_-]`, so the `human.*`/`coder.*`
namespaces below materialize in code as `human_*`/`coder_*`. Stage 1
implemented five tools: `human_submit`, `human_status`, the former combined
wait-and-claim tool, `coder_progress`, and `coder_complete`. Availability and
ownership are now split into `coder_check_work` and `coder_claim_task`.

Stage 2 adds `human_answer`, `human_discuss`, `human_followup`,
`coder_propose_plan`, `coder_ask`, `coder_park`, `coder_block`,
`coder_release`, and `coder_heartbeat`. `coder_report_finding` lets a leased
coder file a mid-task defect/nit/security finding as a parent-linked task for
Frigg groom without expanding the current plan (non-blocking
`{task_id,parent_id,state:"GROOMING",job_id}`; optional idempotency_key).
Human writes never wait for mediator completion. `human_submit` persists the task, enqueues its groom, and returns
`{task_id,state:"GROOMING",job_id}`. `human_discuss`, catch-up, follow-up,
answer re-groom, incubation enhancement, and final conciliation use the same
return-then-apply pattern. `human_job_status(job_id)` returns one durable job;
`human_task_status(task_id)` returns one task plus its latest groom result.
Coder plan review and coder questions retain their synchronous review contract.
`human_submit(wait=true)` is an explicit exception: it waits for the same groom
job for at most the configured 90-second cap, returns a completed verdict inline,
and otherwise falls back to the ordinary `GROOMING` acknowledgement.

Mediator clarification is durable first and live when possible. A clarify
verdict atomically blocks the provisional task and stores its question before
delivery. A connected human/admin session advertising elicitation receives a
form-mode `elicitation/create`; accept answers the same durable question and
enqueues one re-groom. Decline, cancel, timeout, disconnect, or no capability
leaves the question open for `human_answer`. Legacy `clarificationMode`
metadata has no routing authority.

Routing is credential-only: the single endpoint is `/mcp`. A static bearer API
key resolves exactly the membership named by its `metadata.projectId`; there
is no project slug in the URL (see [architecture](architecture.md)). Keys without a
declared project, keys naming a project the owner no longer belongs to, and
unknown future scopes are rejected. Tools may retain an optional `project`
argument, but its enum and every downstream authorization check see only the
key's project. `list_projects`, `human_status`, `coder_check_work`,
`coder_claim_task`, and MCP resources cannot cross
that boundary. Dashboard cookie sessions are
separate identity credentials and continue to resolve all memberships.

Interactive clients use Better Auth's MCP OAuth provider: RFC 7591 DCR, S256
PKCE, authorization code, refresh, consent, RFC 8414 discovery, and RFC 9728
protected-resource metadata. Authorization and token exchange both require
`resource=${MEMRACER_PUBLIC_URL}/mcp`. Consent selects one Project, explicit
human/coder role, and seat name. One opaque seat scope survives refresh and
becomes the same key-bound identity used by leases and `MCP-Session-Id`; two
OAuth sessions for one user cannot use each other's MCP sessions. Static keys
remain the headless path. Both methods can be renamed and revoked in Team.

# Host-agnostic prompts and resources

MCP prompts are host-agnostic workflow recipes. Human and admin seats
receive `submit`, `status`, `answer`, and `review`; coder and admin
seats receive `drain`. `review` reports findings through the human surface and
does not take plan approval away from the mediator. `drain` names the current
read-only check → explicit claim → approved plan → progress → completion loop,
including the 90-second off-model long poll and a return to checking after each
task. It contains no Claude Code hooks, session machinery, or deprecated
combined wait-and-claim call.

Every authenticated role may read the same project-scoped MCP resources:
`project://{id}` for safe project metadata, `queue://{project}` for a compact
bounded queue snapshot, `question://{id}` for one durable open or answered
question, `task://{id}` for a task brief, and `okf://{project}/{+path}` for
generated OKF indexes or rendered concepts. List callbacks are capped and
every list and direct read reuses the API key's already-resolved Project
membership. Foreign and absent records fail the same way. OKF reads come only
from the DB-backed `MemoryStore`; they never fall through to the server
filesystem. Queue snapshots include whole-queue state counts, put non-DONE
work before bounded history, and resolve verified API-key actor ids to their
human-readable Project labels. These are read-only protocol surfaces usable
through any conforming MCP client, including Codex and Cursor.

# Spec targeting

Build on MCP spec **2025-11-25**. memracer deliberately uses the stable
`initialize` handshake, key-bound `MCP-Session-Id`, client-opened GET SSE, and
`Last-Event-ID` replay because live elicitation needs a bidirectional session.
Headerless one-shot POST remains supported for off-model coder check,
heartbeat, and claim loops; those requests build a disposable stateless server.
Session rows and event history are durable in SQLite/Postgres; sequence
allocation is atomic and replay rejects checkpoints from another session.
On a process-local cache miss with an active durable row, the server
rehydrates the Streamable HTTP transport (same session id + event store) and
restores client capabilities so POST tools and GET+`Last-Event-ID` work after
redeploy without re-`initialize`. Closed or foreign-key sessions still 404.
Tasks-extension readiness remains, with **no use of sampling, roots, or
logging**. The later release candidate's stateless direction is not adopted
while this stable capability is required.

Server push is not relied on: Claude Code does not act on unsolicited
notifications while idle. Waking idle coders is a long-poll tool. Human
mediator work uses the existing durable jobs plus explicit status reads;
spec-native MCP Tasks remain deferred.

# Connect-time role contracts

`src/dashboard/public/role-contracts.js` is the single source for the complete
HUMAN and CODER role blocks. Its shared identity sentence introduces Frigg as
the project's orchestrator (mediator) in both roles; operational references
then use Frigg while protocol and authorization terms remain `mediator`.
`src/tools.ts` uses those bytes in MCP
connect-time `instructions`; it adds only the member/project header and, for
humans, the live warming-task block. The dashboard's
`buildAgentInstructions` adds its project/URL introduction and then inlines
the same role block. Coder setup prompts then append the goal-shape
addendum, which tells the agent how to recognize and continuously verify a
`Goal:` / `Verify:` / `Invariants:` task without changing the shared
connect-time contract. The result is a complete standalone prompt with no
pointer back to the server or dashboard. Browser-safe JavaScript keeps the
no-build dashboard path intact, while `role-contracts.d.ts` gives the
TypeScript server a typed import.

The server's connect-time human `instructions` define a human-in-the-loop
collaboration contract. Human agents inspect relevant code, project OKF memory,
and supplied evidence before recommending or submitting. A human agent working
from a long-lived checkout syncs it with remote main before research and
periodically during a long session, so findings and file references track code
merged by coders in separate worktrees. By default, every
response is one short paragraph of at most five short sentences; more detail
requires a user request. Agents absorb reversible low-stakes choices, but at
consequential forks they may not decide, reject, combine, reframe, choose, or
recommend any option before the user answers. They briefly summarize the real
options and key tradeoff, ask which direction the user wants, then stop. Each
update leads with the outcome and states what happened, what it means, and what
comes next; at a consequential fork the outcome is a decision pending the
user's direction.
The normal deliverable is a mediator handoff through `human.*` tools, with the
user kept informed and able to shape the plan before execution. The role block
states that no reliable mid-execution correction channel exists after plan
approval: use a new task, or a linked followup after completion. It also tells the human agent
to expect one-decision-at-a-time grilling: help the mediator self-serve facts,
and escalate only genuine decisions the agent cannot own to the human in the
loop. Because the dashboard and server import the same constant, this guidance
is identical with or without MCP connect-time `instructions`. The same block
retains the plan-not-code boundary, `human_status` → `human_answer` question
path, tool inventory, and active warming-task invitation.

Dashboard attribution follows the same role-aware policy without changing
stored authors. The shared avatar primitives render every `mediator` role as
Frigg, including legacy `mediator` and `steward` author strings; human, coder,
system, tool, database-role, and MCP tool identifiers remain unchanged.

The server's connect-time coder `instructions` carry the outer-loop contract,
independent of `coder-kit`. A single long-lived background job owns the
90-second waits, null results, fixed 600-second sleeps, and re-polls. It does
not exit or notify the main agent on null. The task return is the only handoff;
the server has already claimed the lease by verified API-key id and presents
the API-key name on human-facing surfaces. The tool description repeats this
contract. A sleep-only background job that wakes the model to make the next
call violates it.

Goal-specific continuous verification remains on the canonical task body and
`coder-kit/task-prompt.mjs`, and is introduced to dashboard-provisioned coders
by the setup addendum. It is not part of the general connect-time role block.

# human.* tools

| Tool | Behavior |
|---|---|
| `human.submit(text, evidence[], repo, base_sha, idempotency_key?, wait?, warm_for?)` | Persists and normally returns a `GROOMING` acknowledgement without awaiting the mediator. Optional `warm_for` (`1h`/`1d`/`1w` or ISO-8601) births the task `INCUBATING` off the coder queue (race-free hold). `wait=true` waits up to 90 seconds for that groom job, then returns its result or the same acknowledgement on timeout. Evidence is `{path, lines, snippet, kind: code\|stacktrace\|log\|link, note}`. A project/member-scoped idempotency key maps concurrent or later retries to the same task id. |
| `human_attach_image(task_id, image_base64, mimeType, caption?)` | Accepts one canonical-base64 PNG, JPEG, GIF, or WebP up to 10 MiB decoded. It writes opaque bytes to the object store and an `image` evidence metadata row, then returns metadata only. Human/admin Project membership is required. |
| `human.discuss(thread_id, message)` | Enqueue a grooming/priority conversation and return its background job id immediately. |
| `human.followup(task_id, text, evidence[], warm_for?)` | Legal only after done; creates a linked child task, re-groomed. Optional `warm_for` births the child `INCUBATING` the same way as submit. |
| `human.status(filter?)` | Bounded queue summaries plus questions, conversations, and durable unattended-work `attention_alerts`. Called by a SessionStart hook. |
| `human_task_status(task_id)` | Read one task row plus the latest groom job state/result. While the job is pending or running, the projected task state is `GROOMING`; no DB lifecycle state is added. |
| `human_job_status(job_id)` | Read one project-authorized human mediator job as pending, running, done with parsed result, or failed with error. |
| `human_warm_task(task_id, warm_for)` | Submitter/admin only. Atomically moves an existing `QUEUED` task to `INCUBATING`; a concurrent coder claim wins safely. |
| `human_enhance(task_id, contribution)` | Any project human may contribute research, a scope change, or a cut while the task is `INCUBATING`; the mediator arbitrates it. |
| `human_seal_incubation(task_id)` / `human_extend_incubation(task_id, warm_for)` | Submitter/admin controls that graduate a warming task early or move its clock later. |

Preferred hold path: pass `warm_for` on `human_submit` or `human_followup` so
the task is born `INCUBATING` with no claim race. Do not encode hold status in
titles. `human_warm_task` is the after-submission entry into collaborative
warming for an already-`QUEUED` task; a concurrent coder claim wins safely.
It accepts the same `1h`/`1d`/`1w` and ISO-8601 duration syntax as
`human_submit(warm_for)`. Non-submitters are refused unless their project role
is admin. Calls against `INCUBATING`, active, held, or finished tasks return
the current state and the relevant next tool; a held task points to `human_discuss` to reopen it first. A successful
transition clears any retained approved coder plan so the next claim cannot
replay a plan written against the pre-warming spec.

`human_status` returns all four top-level sections by default:
`attention_alerts`, `projects`, `open_questions`, and `open_conversations`.
Callers may select only the sections they need. Project task lists default to
50 compact operational rows per project and include `task_page` metadata with
the total and next offset. Compact rows retain identity, lifecycle, priority,
submitter, lease, dependency, parent, warming, queue-age, and result-PR fields;
they omit bodies, plans, rationales, and PR descriptions. `task_detail: full`
restores complete task rows for an explicitly bounded page. `queue.status`
remains the internal full-row source and `human_task_status` remains the direct
single-task groom/result read.

`attention_alerts` is the compact complete index of open human-directed work
across the caller's selected Projects. It combines durable unattended-queue
episodes with every `status='open'` task or project question, regardless of
task lease state or attention grace. Each row carries stable episode and
Project routing, nullable `task_id`, bounded one-line `title` and `reason`, a
recovery hint, and `question_id` when `human_answer` applies; it does not embed
task bodies or question records. `attention_limit` defaults to 50 and is capped
at 100. `attention_cursor` continues through the deterministic task/id order,
while `attention_page` reports cursor, limit, returned rows, truthful total,
and `next_cursor`. Answered questions disappear from both the index and the
existing `open_questions` answer-detail section.

Mediator→human task clarifications always retain a client-independent text
path and may also use live elicitation. Every successful `human_*` result
appends up to five open mediator questions for tasks submitted by that member
inside the API key's Project memberships. Each compact row carries
`question_id`, `task_id`, `task_title`, and `question`; page metadata reports a
truthful total and `next_cursor`, which `human_status` accepts as
`pending_clarifications_cursor`. Another member's tasks and Projects outside
the credential's memberships cannot enter the query. Answering through
`human_answer` removes the row from that same response because decoration runs
after the answer commits. Live elicitation remains the faster path for a
capable connected client; both paths converge on the same guarded
answer/re-groom operation. Legacy key metadata does not change routing.

# Bounded read pagination contract

Collection reads use bounded pages, deterministic ordering, and truthful
continuation metadata. The shared design is `LIMIT` plus an opaque cursor for
new read APIs; the existing `human_status` page/offset fields remain a bounded
compatibility projection and must not grow into a second full-payload surface.
Completed-task archives, attention rows, questions, queue lists, and future
read collections must preserve the same bounded-response rule; per-endpoint pagination
semantics are not allowed.

# Project questions

`human_status` seeds six product-context questions when a project has no
tasks, questions, or mediator memory: product, building blocks, priorities,
users, current stage, and a catch-all. They return in `open_questions` with
`task_id: null`; no submitted task or onboarding state machine is required.
Repeated status calls do not duplicate them.

`human_answer(question_id, answer)` handles both scopes. It verifies that the
caller belongs to the question's project. A taskless answer changes only the
question and the mediator's OKF ledger; a task-bound answer retains the
existing unpark/re-groom behavior. Project questions are always the text pull
path (`human_status` then `human_answer`), never `elicitation/create`.

Groom verdicts may carry up to three `project_questions`. These are durable,
non-blocking unknowns noticed during normal grooming. Unlike task clarification,
the current task continues while humans answer asynchronously.

Blocking groom clarifications have a stricter wire contract without changing
their public result shape: `question` contains exactly one question mark and a
`Recommended:` answer. Model drivers retry schema-invalid output, and the
pipeline rejects malformed custom-driver output before it reaches the question
ledger.

Grooming also has a typed security `refuse` verdict. The shared SYSTEM boundary
treats submission content as untrusted data and refuses only four requested
outcomes: real-secret publication/exfiltration, security-control weakening or
bypass, coder-host damage/backdoors, and third-party attacks. Framing the same
action as a simulation, fake-data exercise, or authorized test does not change
the verdict. A successful refusal leaves no task row and writes a taskless
`escalate` decision; no decision kind or schema migration was added.

# Pull-based unattended-work attention

Every `human_status` evaluates only the caller's selected projects. A QUEUED
task becomes eligible when its transition-only `queued_at` is at least the project's
`attention_grace_ms` old (15 minutes by default) and no unexpired
`CLAIMED`/`PLANNED`/`EXECUTING` lease exists anywhere in that project. The DB
transaction creates at most one active episode per task. Repeated pulls return
the same `<task_id>:<episode>` id; they do not insert duplicate rows.

Every transition into QUEUED sets `queued_at` and increments
`queue_generation`; priority, title, body, and grooming edits leave both
unchanged. Every successful claim increments the project's `claim_generation`
and records `last_active_lease_at`. Alert rows snapshot both generations, so a
claim/requeue of the alert task or a claim/release of another project task
resolves the old episode even when the whole lease occurs between status pulls
or inside one millisecond. Legacy QUEUED rows conservatively backfill
`queued_at` from `updated_at`, the newest available lower bound.

An episode resolves when its task leaves QUEUED or any project coder holds a
live lease. The same task can start another episode only after the project's
30-minute default cooldown. Each returned alert names the project, task id and
title, queued age, observational reason, recovery action, `task://` URI, and a
dashboard deep link when `MEMRACER_PUBLIC_URL` is configured. This says only
that claimable work is unattended; it does not infer a crash or data loss.

`human-kit/hooks/sessionstart-status.mjs` is the reference host delivery path.
It calls stateless `human_status`, injects the result as SessionStart context,
and deduplicates episode ids under a local cross-process lock. On macOS a
configured or known absolute `terminal-notifier` path provides the clickable
dashboard notification; `/usr/bin/osascript` is the non-clickable fallback.
Notification children receive no `MEMRACER_*` values. Failed delivery leaves
the episode eligible for retry, and a lock older than 30 seconds is recovered.
This is not server push and does not change the coder long-poll loop.

# coder.* tools

| Tool | Behavior |
|---|---|
| `coder.check_work(timeout_s, peek_limit)` | Read-only long-poll (max 90 s). Returns `available_count` and up to five `{project_id,title,priority}` previews. It includes queued work visible to the caller plus logically expired leases/plan windows, without requeueing or claiming anything. |
| `coder.claim_task(lease_duration_ms?)` | Sole public atomic claim mutation. Returns the full task brief or null when the advisory availability result is stale or another coder won the race. The duration defaults to 30 minutes and is capped at 120 minutes. |
| `coder.propose_plan(task_id, plan, files_touched, risk, lease_duration_ms?)` | Renews the persisted bounded lease while the mediator reviews → `approved \| revise(feedback)`; MCP Task with `input_required` if the mediator must consult a human. |
| `coder.ask(task_id, question)` | Mediator answers from context or escalates; response may be "parked, answer pending". |
| `coder.progress(task_id, note)` | Lease renewal + dashboard visibility. |
| `coder.park(task_id)` / `coder.complete(task_id, pr_url, summary, learnings)` | Terminal/side transitions. |
| `coder.block(task_id, reason, kind?, retry_after_ms?)` | Releases the lease. Human/dependency blocks open a durable question and requeue on answer. `infra_failure` blocks create no human question and auto-requeue after a bounded retry delay (five minutes by default). |
| `coder.heartbeat()` | Off-model keepalive used by supervisors and Stop hooks. Renews every active or grace-recoverable lease owned by the seat from its persisted duration and returns those leases plus queue depth. |

`coder.claim_task` keeps the queue's Postgres compare-and-set guards. An
expiry scan can requeue only the exact state, owner, and deadline it read, and
records attempt history only when that guarded transition succeeds.

Lease duration is stored on the task so heartbeat, plan proposal, and progress
renew consistently across stateless HTTP connections. A five-minute recovery
grace lets only the verified owner renew or complete a newly expired lease;
competing availability and claims wait until grace ends. Completion remains an
explicit reconciliation for an already-open PR and performs no Git-provider
polling or token lookup. Availability checks do not create or renew leases.
The task brief a claim returns is the
complete context: title, acceptance criteria, all human evidence with
file:line snippets, pinned base SHA, parent/related tasks, prior attempt
history with failure notes, and the mediator's grooming rationale.

Image evidence does not expand that JSON brief or any ordinary task/status
projection. After the claim commits, the MCP result appends `ImageContent`
blocks from the object store within a 10 MiB aggregate decoded budget. Attachments outside
the budget or unavailable at read time become authenticated binary-route URLs
in a fallback text block. Read failure never rolls back or masks the successful
claim. The write, metadata, delivery, and route contracts are in
[task image attachments](image-attachments.md).

# Auth

OAuth 2.1 per the spec (PKCE, RFC 9728 resource metadata, RFC 8707 resource
param). Role→tool mapping is server policy on the validated token; scope
step-up uses the 403 `insufficient_scope` challenge.

The deployed headless path uses project-scoped Better Auth API keys. A failed
API-key resolution writes an `[auth-api-key-failure]` JSON line containing the
proxy-reported client address, first forwarded address, or socket fallback plus
only the first four key characters and an ellipsis. The source address is
diagnostic data and never participates in authorization. Browser session
resolution is unchanged, and no log contains the complete API key.

# Conversational queue management

`human_discuss` is the queue-management surface: it enqueues
a `discuss` job and the mediator acts on what the member says. The driver
returns `{reply, actions[<=5], rationale}` where actions are `close_task`
(done-without-work or obsolete; never CLAIMED/EXECUTING/PLANNED),
`set_priority` (P0 to P3), and `update_task` (title/body; final, because the
mediator is the groomer and there is no re-groom). The pipeline validates each action against the
live queue, applies the valid ones (close sets DONE +
`result_summary: "closed by mediator: <reason>"`), refuses the rest with a
stated reason, logs `close`/`priority`/`update` decisions, and records a
`discuss` thread. The tool response returns `{reply, applied, refused}`
verbatim. No `human_close`/`human_reprioritize` CRUD tools exist; the
conversation is the interface. The former optional `task_id` arg is gone:
members name tasks by id in the message.

# Hardened coder protocol

Four defenses against faulty or overconfident coder agents:

- **Plan window.** `coder_claim_task` stamps
  `plan_deadline = now + 60 min`. The lazy sweep in `claimNext` requeues any
  pre-approval CLAIMED/EXECUTING task past that deadline. A live lease does
  not excuse a missing plan, so a confused agent heartbeating forever cannot
  hold an unplanned task (attempt outcome `plan_window_expired`). Approval
  stores the plan text on the task (`plan`, `plan_approved_at`) and clears
  the deadline; a re-claimed task re-delivers the stored plan in its brief.
- **Strict completion.** `coder_complete(task_id, summary, pr_url,
  pr_description)`: `pr_url` must parse as a URL and `pr_description` (min
  20 chars) is the PR's description verbatim; the mediator files both. The
  trailing integer of `pr_url` lands in `tasks.result_pr_number`.
- **Reconcile on completion.** A successful `coder_complete` enqueues a
  `reconcile` job: the mediator's `discuss` brain reviews the open queue
  against the completion message (agent, task, PR URL + description),
  closing now-redundant tasks and editing partially absorbed ones, with the same
  validation/apply path and decision kinds as `human_discuss`, recorded as a
  `discuss` thread on the completed task.
- **Give-back.** `coder_release(task_id, reason)` requeues a leased task
  immediately (attempt outcome `released`); the reason rides the attempt
  history into the next claimer's brief. `coder_block` now also opens a
  question (`blocked: <reason> — what should happen?`) so BLOCKED always
  lands in the needs-you strip with an answerable handle; `human_answer`
  requeues BLOCKED tasks just like PARKED ones.

# Ask-path mediator actions

`coder_ask` answers may act as well as advise. When the coder's question
reveals the task itself is invalid, redundant, or mis-scoped, the mediator's
answer carries up to 3 queue actions (same union as `human_discuss`:
`close_task` / `update_task` / `set_priority`) targeting that task. For
example, a wrong premise closes it with the reason. The pipeline applies them through
the shared discuss validation with one exemption: the asking task, though
CLAIMED/EXECUTING, may be acted on (`allowTaskIds`); closing it also clears
the lease so the coder is free immediately. Actions against *other* active
tasks are still refused. `coder_ask` returns `{escalated, answer, applied,
refused}` and its description tells coders to say so when the premise is
wrong.

# Pending-retry contract

When a mediator job outlives the tool-call wait, the tool returns
`{status: "pending", job_id, note}` where the note instructs the caller to
repeat the *same tool call with the same arguments*. The server makes that
cheap: groom/discuss/review/answer handlers enqueue via
`worker.findOrEnqueue`, which reuses an existing pending/running job with the
same project + kind + payload (JSON-string equality), so no duplicate is
enqueued; the retry resolves to the original job's result. The worker also
runs jobs with bounded concurrency (see
[mediator sessions](mediator-sessions.md)), so slow reconcile/curate jobs no
longer push interactive asks past the wait window.

# Related

- [Architecture](architecture.md)
- [Task image attachments](image-attachments.md)
- [Coder loop](coder-loop.md)
