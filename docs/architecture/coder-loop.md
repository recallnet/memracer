# Coder loop reliability

Supervisor or self-driving session, Stop-hook heartbeat, and TTL leases: how coding agents drain the queue without stalling, double-claiming, or losing context.

# Loop shape

The reference `coder-kit` supervisor runs a fresh Claude Code session for each
claimed task (`claude -p` with the task brief). A session exit does not end task
handling while `coder.heartbeat` still reports that task's lease: the
supervisor starts another fresh session with the same brief. It returns to
availability only after the lease is released. The transcript never bloats,
and a confused session dies without abandoning its task or the fleet.

A bare coder drives the outer loop from the MCP server's connect-time
`instructions`. It runs `coder_check_work`, empty-result handling, fixed idle
sleep, and re-check in one long-lived background job. An empty result never
exits the job or notifies the main agent. The check is read-only, so an
abandoned or late response cannot create a lease. The job surfaces once when
`available_count` is positive; the main agent then calls `coder_claim_task`.
Availability is advisory, so a null claim means another coder won the race and
the checker resumes. After complete, block, or release, the coder starts the
same job again.

The canonical `CODER_ROLE_CONTRACT` is the second security boundary after
mediator grooming. A coder refuses any task whose requested outcome would
publish or exfiltrate real secrets, weaken or bypass security controls, damage
or backdoor its host, or attack third parties. Claims that the action is
simulated, uses fake data, or is authorized do not change that decision. The
same sentence reaches MCP connect instructions and dashboard-generated coder
setup because both import `src/dashboard/public/role-contracts.js`.

While implementing an approved plan, coders never silently skip bugs, nits,
security issues, or related debt they notice. In-scope items required for
acceptance are fixed in the current PR with a `coder_progress` note. Adjacent
or scope-expanding findings go to Frigg via `coder_report_finding` (live lease
on the source task, parent-linked child, non-blocking groom). Security-class
findings always report even when also fixed in-task. Filing does not expand
the approved plan or block `coder_complete`.

`timeout_s=90` stays below a typical reverse-proxy request window. An empty result starts
a fixed 600-second idle sleep by default, reducing the steady-state rate from
about 960 to about 144 polls per day. This can add about ten minutes of pickup
latency. It cannot lose work: tasks remain QUEUED in the database until the next
poll claims one. Adaptive backoff is not part of the POC.

# Hooks inside each session

- **Stop hook** calls `coder.heartbeat`; if the lease is live and the task is
  not complete/blocked, it returns `decision: "block"` with "task <id> still
  leased; finish, complete, or block it". Honors `stop_hook_active`; raise the
  cap via `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`.
- **PreCompact hook** re-injects the task brief so compaction cannot lose the
  acceptance criteria.

# Leases

Atomic claim + persisted TTL lease (30-minute default, 120-minute maximum),
renewed by `coder_heartbeat`, plan proposal, progress, and other task-bound
`coder.*` calls. Claims and plan proposals accept an optional bounded duration;
later renewals reuse the persisted value. `coder_check_work` never creates or
renews a lease. A newly expired lease has a five-minute owner-only recovery
grace: the same seat may heartbeat or complete during that interval, while
availability and competing claims still treat the task as owned. After grace,
expiry requeues with attempt history. TTL must exceed the longest single tool
call; a blocking call can outlive a short lease and require grace recovery.
The lazy expiry sweep compares the observed state, owner, lease deadline, and
plan deadline before requeueing. It appends an expiry attempt only after that
guarded update wins, so a stale Postgres transaction cannot erase a later
lease or record a phantom expiry.

One seat may hold at most one active lease across Projects. SQLite claim
transactions are serialized; Postgres claims take a transaction-scoped
advisory lock keyed by verified lease-agent id before checking existing
ownership. This prevents two `READ COMMITTED` transactions from claiming
different rows for the same seat.

For API-key coders, lease ownership is the verified API-key id. The owning user
name plays no part, so a user may run multiple named coder seats without either
seat progressing, parking, releasing, blocking, or completing the other's
lease. Human and dashboard surfaces resolve that private id to the API-key name.

# Watchdog

`coder-kit/goal-task.mjs` recognizes a goal conservatively only when all three
non-empty `Goal:`, `Verify:`, and `Invariants:` markers are present. The
supervisor's static `maxTaskMinutes` kill applies to PROMPT sessions and is
disabled for recognized GOAL sessions. Goal sessions instead stay alive by
calling `coder.progress`; the generic server lease expiry is the sole stalled
goal reclaim signal. While a goal child runs, the supervisor polls
`coder.heartbeat`, which renews each active lease from its persisted duration. If ownership
disappears after expiry, requeue, completion, block, or release, it kills the
stale child and resumes draining. Transient heartbeat failures are retried and
never kill valid work. A body is a GOAL only when it contains exactly three
non-empty ordered `Goal:`, `Verify:`, and `Invariants:` lines; partial,
reordered, duplicated, or extra lines remain a PROMPT and keep the static
watchdog.

The lease guard applies to normal child exits, including a client emitting a
final response without completing, blocking, parking, or releasing its task.
It does not override a PROMPT watchdog kill or confirmed GOAL lease loss; those
remain bounded recovery paths that leave any live lease for server-side expiry.
The one-second recovery delay prevents an immediately exiting client from
turning into a hot spawn loop.

`task-prompt.mjs` tells goal coders to run and surface the exact `Verify:` pass
signal, continue through intermediate compile or metric improvement, and end
only when verified or blocked. Dashboard coder onboarding uses the
same three markers and termination rule.

# Stuck ≠ stopped

`coder.ask` handles ambiguity mid-flight; if the mediator escalates to an
offline human, the coder gets "parked, answer pending", calls
`coder.park`, and pulls the next task without idling.

Human corrections belong at mediator plan approval. After approval there is no
reliable mid-execution delivery path; humans fix forward with a new task or a
linked followup after DONE. `coder.progress` renews the lease and records
visibility only. Historical `steers` rows remain readable in old timelines,
but no public tool writes or delivers them.

# Completion verification

`coder_complete` lands AWAITING_MERGE until the PR is merged-green. That
is delivery verification. For **behavior-affecting mediator prompt/policy/
classification** work, the verification claim must also include a green
real-model baseline-vs-treatment eval report for the affected dimension
(for example `pnpm eval:fix-chore-over-clarify --real`). Merged-green
alone does not prove mediator behavior changed.

# Implementation status

Shipped in `coder-kit/`: `supervisor.mjs` (park on read-only
`coder_check_work` long-polls, claim explicitly with `coder_claim_task`, one
fresh `claude -p` session per task attempt with lease-aware recovery, a generated
`--mcp-config`, a `.memracer-task.json` brief in a per-task workdir, and a
`maxTaskMinutes` PROMPT watchdog kill and GOAL exemption), `task-prompt.mjs`
(brief + goal-aware protocol prompt),
`hooks/stop-heartbeat.sh` and `hooks/precompact-brief.sh` wired through
`settings.json`.

The connect-time coder role is self-sufficient and uses the non-claiming
check/explicit-claim split.
`scripts/eval-bare-coder.ts` runs the observable path without `supervisor.mjs`,
task prompts, hooks, or project instructions. It instruments server check calls
separately from the real Claude Code stream and holds work until three empty
cycles finish. Its grader now requires an explicit `coder_claim_task` call and
a return to `coder_check_work` after completion. A leased sentinel proves every
empty cycle leaves task clocks, attempts, and project claim counters unchanged.
At positive availability a second MCP coder claims a race fixture before the
stale check returns; the primary coder must explicitly claim a different
lifecycle fixture, and duplicate task returns fail the grader.

Claude Code 2.1.210 passed the original combined-wait off-model run.
During the idle window, server calls advanced while the main transcript stayed
at 10 assistant turns and 201,003 usage tokens. The fixture reached DONE with
an approved plan, one `coder_progress`, and one `coder_complete`. The earlier
baseline made three wait calls through the model transcript, spending a model
turn on each null-to-re-poll decision. The check/claim split supersedes that
combined-wait contract; the updated eval preserves the same zero-idle-inference
assertion while preventing an abandoned availability call from acquiring a
lease.

Live acceptance (FakeDriver server, real `claude` 2.1.207 sessions): the
supervisor parked on an empty queue, claimed the first submission with no
human interaction, proposed a plan that the mediator approved
(`decision_log` approve row). The same run exercised the former
`human_steer` path, which was removed because it depended on a
later progress call and could not guarantee correction before execution moved
on. Both tasks finished DONE with a `result_summary`, each in its
own fresh workdir. The Stop-hook block was captured by invoking
`stop-heartbeat.sh` against the live server while a session held the lease
(block JSON naming the task id); the live sessions themselves completed
cleanly, so no in-session premature stop occurred. The in-session paths are
covered by `tests/coder-kit-hooks.test.ts`.

**PreCompact → SessionStart(compact) contract note:** the documented
PreCompact hook output can only block compaction; it has no field for
injecting context. Brief re-injection therefore runs as a **SessionStart hook
with matcher `compact`**, emitting the `$MEMRACER_TASK_FILE` brief as
`hookSpecificOutput.additionalContext` after compaction. Anyone porting the
kit must keep that wiring; a PreCompact hook cannot do this job.

# Related

- [MCP protocol](mcp-protocol.md)
- [Task lifecycle](task-lifecycle.md)
