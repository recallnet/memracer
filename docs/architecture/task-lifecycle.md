# Task lifecycle state machine

Warming, claim, execution, completion, and side-state transitions for a task.

# States

```
INCUBATING ⇄ QUEUED → CLAIMED → PLANNED → EXECUTING → AWAITING_MERGE → DONE
                          │         │          │              │
                          └────── BLOCKED / PARKED(question pending)
any non-terminal state ───────────→ HELD ──(reopen)──→ QUEUED
```

- `INCUBATING`: warming off the coder queue while humans shape the canonical
  spec. A task enters here at submission with `warm_for`, or afterward through
  the submitter/admin-only `human_warm_task`. That later transition is one
  guarded `QUEUED` → `INCUBATING` update, so it loses safely if a coder claims
  first. It clears a retained approved plan because warming may revise the
  canonical spec, while preserving prior attempts. The clock-driven seal groom
  or `human_seal_incubation` returns it to `QUEUED`;
  `human_extend_incubation` moves the deadline later.
- `QUEUED`: groomed, prioritized, unclaimed. A just-submitted task may remain
  here while its groom is still running; `human_submit` returns immediately
  and `human_task_status` projects `GROOMING` while the durable job is pending
  or running. `GROOMING` is a wire projection; the DB stores no such lifecycle state.
  `human_status` later exposes the resulting groomed state. It is the only existing state
  eligible to enter warming and the only state a coder may claim.
  A merge-only consolidation pass re-examines already-groomed, unleased queued
  tasks after an admission burst and at a bounded periodic cadence. A null
  `grooming_rationale` marks a pending ordinary groom and excludes that row.
  Consolidation makes no model call. It snapshots the eligible rows and their
  evidence paths, orders survivors by lower queue priority and then oldest id,
  sends only classifier-approved pairs to the existing atomic merge transaction,
  and never rewrites, splits, clarifies, or reprioritizes. Both rows must still be
  same-Project, unleased `QUEUED` work when the transaction reserves them. A
  deterministic classifier then requires minimally canonicalized exact
  title/body strings and bilateral coverage of full, case-sensitive evidence/text
  paths. Only Unicode presentation, CRLF, exactly one terminal full stop per
  line, and positive `Outcome:`/`Goal:` prefixes normalize. Every other character
  and all whitespace remain exact; lexemes serve only the generic/empty
  refusal. Explicit directories may cover descendants, but sibling files do not.
  Weak, elaborated, reordered, or different-scope pairs survive. A successful merge writes destination-owned
  source id/title/body provenance, retargets durable task-owned history, clears
  dependency edges
  touching the source, and deletes the source in one transaction. Task-owned
  metadata writers reserve that same live source row, preventing a concurrent
  non-foreign-key write from republishing its deleted id. A stale or refused
  pair emits `[queue-dedup-skip]` and the sweep continues. Direct-groom fallback
  updates only a still-unleased `QUEUED` source and inserts its cited `create`
  decision in one Queue transaction. A concurrent claim or terminal transition
  wins unchanged; a later merge retargets the fallback audit with the source.
- `CLAIMED`: atomic claim + lease; brief delivered. The claim also opens a
  **60-minute plan window** (`plan_deadline`): no approved plan by then and
  the task requeues with attempt outcome `plan_window_expired`, even while
  the lease stays live. Heartbeating never substitutes for planning.
- `PLANNED`: the mediator approved the plan (the mediator is the sole approver).
  Approval stores the plan text on the task and clears the plan window; from
  here the normal 30-minute lease renewal governs. A re-claimed task
  re-delivers the stored plan in its brief.
- `EXECUTING`: coder working; there is no human steering tool.
  `coder_heartbeat` renews the persisted lease duration without creating
  progress notes, while `coder.progress` renews it and records a visibility
  milestone. Human corrections after plan approval fix forward through a new
  task or a linked `human.followup` after this task reaches DONE.
  Goal-shaped tasks do not get a distinct state or server-side exemption:
  repeated progress renews the same lease and keeps the task unclaimable;
  silence past TTL requeues it through the same lease-expiry path as any task.
- `AWAITING_MERGE`: `coder.complete` accepted an open (or closed-unmerged)
  PR. The lease is released so the coder can pull other work; the task is not
  claimable and does not satisfy dependents. Open-PR check status is stored on
  `pr_verification` for dashboard visibility. Primary settle path: signed
  GitHub App webhooks (`pull_request` closed, `check_suite`/`check_run`
  completed) re-check the PR and promote to `DONE` only when
  `pr_verification=merged-green`. A five-minute poller is the backstop for
  missed deliveries (If-None-Match). Closed-unmerged stays here.
  When `check_suite.completed` reports a failure-class conclusion
  (`failure` / `timed_out` / `cancelled` / `action_required`) and the PR is
  still open with failing checks, the server files one system-submitted
  CI-fix child task (`parent_id` set, body marker `[ci-fix:pr-N]`, priority
  1, born `QUEUED`, no mediator groom). The poller applies the same rule on
  `checks-failing` as a backstop. Idempotent while a non-DONE CI-fix child
  exists; never files for merged PRs; never gates `coder.complete` or DONE
  promotion. The retired name `PENDING_VERIFICATION` is never reused.
- `DONE`: PR is merged on GitHub. Branch protection / merge queue already
  enforced required checks for the merge, so the server treats
  `merged === true` as merged-green without re-scoring optional check noise.
  Immediate path: coder calls `coder.complete` after merge. Delayed path:
  webhook (or poller backstop) promotes from `AWAITING_MERGE`. Either path
  enqueues a `reconcile` job so the mediator prunes now-redundant queue
  entries. Completion is fail-closed without a GitHub token
  (`MEMRACER_GITHUB_TOKEN` or host `gh auth token`): the lease stays with the
  coder and the task is not marked done. Hallucinated PR URLs are refused the
  same way. Legacy `PENDING_VERIFICATION` rows still migrate to `DONE` at
  startup for databases that never finished the earlier retirement.
  `human.followup` creates linked child tasks; AWAITING_MERGE is not DONE.
- `BLOCKED`: every row has an exit trigger. `coder.block(reason)` defaults to
  a human block with an answerable question; explicit `human` and `dependency`
  kinds use that same path. `infra_failure` carries `block_requeue_at` instead
  and returns to `QUEUED` through the worker sweep when its retry clock elapses,
  without creating a human question. The sweep also repairs a legacy or
  malformed blocked row that has neither an open task question nor a retry
  clock. Automatic recovery is recorded as a system `released` attempt. A groom
  clarification also moves its provisional QUEUED task here atomically with
  the mediator question, so a coder cannot claim an underspecified task.
  Accepted live elicitation and `human_answer` both answer the durable row,
  requeue the task once, and enqueue re-grooming.
- `PARKED`: awaiting an escalated answer; coder freed to pull other work.
- `HELD`: reversible defer or conflict-conversation hold. Holding a
  non-terminal task releases its lease and keeps it off coder surfaces;
  `human_discuss` can ask the mediator to reopen it to `QUEUED`, and conflict
  conciliation uses the same return path. It must reopen before
  `human_warm_task` can move it into `INCUBATING`. A dependency-backed legacy
  hold also returns automatically once every predecessor is `DONE`, provided
  the task has no open mediator question and belongs to no `OPEN` conflict
  conversation. Completion checks only its direct dependents; the worker's
  periodic recovery pass repairs simultaneous or out-of-band condition
  changes. Recovery repeats every guard in the state-changing update, clears
  stale hold/lease/plan/block metadata, advances queue generation, and records
  a system `released` attempt. The nullable `hold_cause` distinguishes
  `conflict`, `question`, and `dependency` conditions from an `explicit`
  mediator defer. Explicit holds never auto-release, even when they retain
  completed dependency metadata. Legacy null-cause rows require at least one
  dependency edge and remain eligible so pre-migration stranded work can
  recover. This recovery rule does not gate ordinary `QUEUED` claims:
  dependencies remain advisory serve-order metadata.
- `coder.release(reason)`: give-back from a live lease straight to `QUEUED`
  (attempt outcome `released`); the reason travels to the next claimer.
- Lease expiry from any active state (CLAIMED, PLANNED, EXECUTING) starts a
  five-minute recovery grace. The owning seat may renew or complete during
  grace; other seats cannot see or claim the task. Expiry after grace returns
  it to `QUEUED` with attempt history attached. The 60-minute pre-approval plan
  deadline remains hard and has no grace.

Attaching an image does not move task state, rewrite its body, or change queue
ordering. The task's Project-scoped image evidence row becomes authoritative
only after its object upload succeeds. Claim remains the only state transition in
the coder delivery path: blob reads and MCP image/fallback blocks happen after
the atomic claim, so storage failure cannot give another coder the same task.

`coder_check_work` does not perform a state transition. Its read-only
availability query treats a lease expired beyond recovery grace or an expired
pre-approval plan window as
logically available, but the row and attempt history remain unchanged until
`coder_claim_task` runs the existing lazy expiry sweep and atomic claim.
That sweep requeues only when the row still matches the expired state, owner,
and deadline it observed. Attempt history is inserted only after the guarded
requeue wins; a later lease is left intact.

The reference supervisor also treats the lease as the task-handling boundary.
If a worker process exits normally while its `CLAIMED`, `PLANNED`, or
`EXECUTING` lease remains live, the supervisor starts a recovery worker for the
same task and does not return to `coder_check_work`. Completion, block, park,
or release clears the lease and lets the supervisor resume availability.
PROMPT watchdog termination and confirmed GOAL lease loss keep their separate
expiry-based recovery behavior.

# Task record

`id, project, title, acceptance, category, priority, state, evidence[],
base_sha, parent, attempts[{agent, outcome, notes}], grooming_rationale,
lease{agent, ttl_ms, expires_at}, block_kind, block_requeue_at, hold_cause, rev`

Ordinary `evidence[]` contains text provenance only. `kind='image'` rows store
`blob_ref`, `mime_type`, and optional `caption` in the DB and are read through
the separate [image attachment](image-attachments.md) paths.

# Related

- [MCP protocol](mcp-protocol.md)
- [Task image attachments](image-attachments.md)
- [Coder loop](coder-loop.md)
- [Mediator sessions](mediator-sessions.md)
