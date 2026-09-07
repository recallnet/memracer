# Mediator session model

Short-lived scoped Pi sessions with injected context packs, a structured decision log, serialized writes, and a watchdogged job queue. The mediator knows the whole project, responds to every caller, and never hangs.

# The trap this avoids

One giant long-lived mediator transcript bloats, compacts lossily, and hangs.
The mediator must know the whole project, answer every human and coder
concurrently, and never wedge.

# Design

- **The orchestrator is Frigg.** The shared `SYSTEM` prompt introduces Frigg
  as the orchestrator (mediator) for the project. The name is presentation and
  agent identity only: driver interfaces, job kinds, database roles, event
  roles, and tool names continue to use `mediator`.

- **Human writes return before model work by default.** Human-facing groom and
  review paths enqueue durable jobs and return task/job acknowledgements.
  `human_submit(wait=true)` may call `waitForJob` for at most the configured
  90-second cap; a timeout returns the same `GROOMING` acknowledgement and does
  not cancel the job. `human_task_status` and `human_job_status` remain the
  project-authorized recovery reads.
- **Clarifications ride the next human response.** Every successful `human_*`
  result carries a five-row page of the caller's open mediator clarifications,
  scoped by task submitter and Project membership. The total and continuation
  cursor remain truthful under a large backlog. Live elicitation stays an
  optional fast path; the piggyback is the capability-independent floor.

- **Grooming self-serves facts and escalates decisions.** `buildGroomPrompt`
  directs every mediator driver to resolve factual gaps from evidence, the
  queue, project memory/OKF, repo code when available, and authoritative
  documentation. A missing pointer, implementation detail, or library choice
  is recorded as a grounded assumption. Intake homework is not returned to the human.
  The agentic default explicitly outranks the grilling posture: library and
  icon selection, size caps, UI placement, eval structure, and other
  reversible implementation gaps become stated assumptions and queue with
  zero clarification rounds. Clarification is reserved for product intent,
  consequential risk, held scope, or another high-leverage choice only a
  human owns. Each round asks
  exactly one question and ends with `Recommended: <answer> — <reason>`.
  `groomClarificationQuestionSchema` enforces that shape while OpenRouter and
  Pi parse model output, causing their existing corrective retry on malformed
  questions. The groom pipeline validates the same schema again before any
  custom driver can persist a question, decision, or transcript event.
  The deterministic `FakeDriver` accepts concrete features without the former
  research/library gate, and pipeline-generated research-only, held-scope,
  invisible-slice, and doc-only holds use the same one-question form.
  `pnpm eval --groom-posture` scores the shared prompt itself and drives a
  prompt-sensitive driver through the real worker, groom pipeline, Queue, and
  question ledger. Its fixtures cover a genuine decision, clear work, and the
  repository's actual `zod` dependency read from `package.json` and supplied
  through stored evidence. The policy driver parses that evidence and ignores
  the fixture label. Mutation controls remove or corrupt the contextual
  evidence, remove self-service, remove fast acceptance, restore an ambiguity
  census, permit bundled questions, remove the recommendation, and restore the
  obsolete gate.
  The default `pnpm eval` also runs a zero-tolerance over-clarification gate:
  each clarification across six defaultable categories adds one penalty and
  fails the command, while a genuine human-owned decision must still clarify.
  The sixth fixture supplies a persisted dependency-order decision and fails
  if grooming asks for that ordering again.
- **Questions are unresolved decisions.**
  QuestionLedger.add accepts only question-shaped text, compares conservative
  normalized subject tokens within the same project and task scope, reuses an
  existing open row for a paraphrase, and refuses subjects already answered or
  represented by a persisted decision. Resolution stays on
  Queue.answerQuestion, which answers the original row and refreshes the
  open-only OKF projection; it never creates a second row to announce the
  answer. The shared grooming prompt forbids repeated settled asks and
  resolution narration in both blocking clarifications and asynchronous
  project_questions.
- **Project knowledge uses episodic capture and serialized consolidation.**
  Groom, review, and answer turns write durable conclusions through their
  project-scoped tools while the source evidence is present. Ordinary
  lifecycle events mark durable generations without immediately opening a
  separate model session. One serialized Project consolidation runs from the
  30-minute sweep, coalesces dirty bursts, and may edit, ask, or complete as a
  no-op. Explicit project answers and `human_status` recovery remain immediate.
  The ten domains are non-binding attention hints; untagged concepts remain
  valid, while tagged writes advance only the matching hint's freshness.
- **Prompt caching starts with stable memory policy.** Tool-aware context puts
  the shared memory/core-assets rubric before Project queue, decision, task,
  and clock data. The server clock remains at the volatile tail. This preserves
  the cache canary and usage accounting from the existing OpenRouter path
  without introducing a second cache mechanism.
- **Execution policy keys on the durable job.** Groom
  calls `driver.groom`; discuss, catch-up, and reconcile all call
  `driver.discuss`. A policy-aware wrapper therefore carries the real
  `jobs.kind` through every model call and holds one selected route across tool
  turns and structured-output retries. Only the direct groom job runs the
  difficulty classifier. Unknown kinds fail safe to GLM/high.
- **Policy telemetry follows worker attempts.** One `job_policy_log` row is
  created per logical driver invocation. Consolidation candidates and a
  discuss meta-query replay remain distinct rows; a worker requeue rewrites the
  whole attempt to `retry`, while the next attempt receives new rows. Plan
  revision and task reopen events attach downstream quality signals without
  changing the original route record.
- **Memory maintenance has a zero-tolerance sprawl gate.** The shared memory
  prompt requires an `okf_grep` before `okf_write`, routes a match
  through `okf_update`, and allows a new path only after no match with an
  explicit durable-gap justification. `pnpm eval --over-mint` runs deterministic
  existing-home and new-topic fixtures through Queue, the mediator worker, the
  registered groom pipeline, a prompt-sensitive driver, and the production
  scoped memory tools. The gate penalizes missing grep or an unjustified write,
  including a write beside an existing home. The default eval fails on any
  penalty.
- **Submission text is data.** The shared mediator `SYSTEM`
  refuses a requested outcome that would publish or exfiltrate real secrets,
  weaken or bypass security controls, damage or backdoor a coder host, or
  attack third parties. It judges the action; `simulated`, `fake`,
  or `authorized` framing does not change the verdict. `groomSchema` admits the explicit `refuse` verdict;
  the pipeline records the submission and verdict, writes a taskless existing-
  kind `escalate` decision, and transactionally removes the unleased
  provisional task. `pnpm eval --security-bypass` drives three framed attacks
  and two legitimate security changes through the real worker, pipeline, and
  Queue. Prompt mutation controls prove both the forbidden set and the
  action-over-framing rule are load-bearing.
- **The default deterministic eval is an integration contract.** `FakeDriver`
  keeps explicit marker paths first, then applies bounded stateless policy to
  natural submissions: a merge needs at least two shared topic signals, shared
  action intent, and one unique target from the supplied queue; weak, tied, and
  cross-intent matches fall through. Scope-less submissions without evidence
  receive one schema-valid question about a single bounded observable outcome.
  Plan review receives the leased task's current title, canonical groomed body,
  and grooming rationale as an explicit internal input. Those fields alone
  define scope and acceptance criteria; root submissions, lineage threads,
  evidence, and earlier decisions remain provenance and cannot restore work
  omitted or moved during grooming. A suspected grooming error belongs to a
  separate mediator-owned reconciliation, never coder-facing plan revision or
  human escalation from the review turn. `FakeDriver` reads the same canonical
  input and does not reconstruct a spec from decision history. Answer escalation stops at
  credentials, spend or purchase approval, contracts, customer communication,
  and other human-owned choices. `tests/eval-run.test.ts` runs
  the unmodified 55-case golden suite through `runEval(new FakeDriver())` and
  asserts every CLI threshold. This gate closes a latent harness mismatch: the
  natural-language fixtures and marker-only default driver had evolved
  separately; it was not evidence of a production-model regression.
- **Grooming quality changes have a measured gate.** The default `pnpm eval`
  runs `src/eval/groom-quality.ts` over 100 labeled redacted cases: 60 happy
  paths, 20 edge cases, 10 clarification/refusal cases, and 10 historical
  failure cases. It reports scope correctness, over- and under-clarification,
  decision consistency, JSON validity, tool-loop success, and grounded
  rationale. Deterministic checks run first, a classifier runs second, and a
  different frontier model judges only disagreement. The judge declares a
  per-call cost ceiling that is reserved before invocation; the whole run is
  capped at $0.20. `scripts/export-groom-quality.ts` verifies supplied labels
  against real groom threads before exporting the redacted corpus. Promotion
  requires at least 100 samples, p < 0.05, and the configured effect-size
  threshold; rollout helpers support shadow mode, a 1-5 percent canary, and
  rollback at more than 2.5 percentage points of quality drift.
- **Goal-shaped grooming is structural.** `buildGroomPrompt` emits a GOAL only
  when the submission supplies a measurable boolean end state, an exact
  runnable command with an explicit pass signal, and named invariants. Its
  body is exactly `Goal:`, `Verify:`, and `Invariants:`. Anything missing one
  ingredient remains the existing seven-section PROMPT brief.
  `buildEnhancePrompt` preserves that structure during incubation. Goals carry
  no run, turn, or token cap; they end when verified or blocked.
  `pnpm eval --goal-structure` sends five labeled candidates through a
  deterministic `MediatorDriver`, the registered groom and enhancement
  pipelines, and Queue persistence, then scores the stored bodies. It checks
  exact commands, pass signals, invariants, prompt section order, enhancement
  rules, and forbidden cap language. Mutation controls prove malformed shape,
  lost commands, and cap text fail the scorer.
- **The worker repairs cleared dependency holds.** The existing one-second
  lifecycle recovery sweep calls `Queue.recoverDependencyHolds` after blocked
  recovery. It requeues only condition-backed `HELD` rows whose predecessors
  are all `DONE`, with no open mediator task question and no linked `OPEN`
  conflict conversation. A durable `hold_cause` marks explicit mediator
  deferrals so the sweep never releases them, even if they retain completed
  dependency metadata; legacy null-cause rows need a dependency edge to remain
  recoverable. `Queue.complete` runs the same reconciliation scoped to direct
  dependents for low latency; the sweep is the restart, concurrent completion,
  and cross-mechanism backstop.
- **Queue consolidation is deterministic, merge-only, and change-gated.** Groom completion
  does not enqueue consolidation work. At most once per project per hour, the
  periodic scheduler compares the current `(task id, queue generation)`
  fingerprint with the last completed sweep result and enqueues one project
  sweep only when a new or requeued fingerprint entry appears. The durable
  job result makes the cadence and change gate survive worker restarts. A
  sweep snapshots only already-groomed, unleased `QUEUED` rows and their
  evidence paths. It orders possible survivors by lower queue priority first
  (`P3` before `P0`) and then oldest id, and compares later rows through
  `classifyTaskMerge`; an allowed pair goes directly to
  `applyQueuedGroomMerge`, which reloads and reserves both rows before the same
  classifier runs again inside the transaction. Consolidation never constructs
  mediator context, invokes a driver, or exposes tools. It writes the standard
  per-job `mediator_usage` rollup with zero completions, tokens, and cost so
  operators can distinguish a successful zero-inference cycle from missing
  telemetry. The atomic classifier requires
  minimally canonicalized exact title/body strings and bilateral scope coverage
  before deletion. Only Unicode presentation, CRLF, exactly one terminal
  full stop per line, and positive `Outcome:`/`Goal:` prefixes normalize. Every
  other character and all whitespace remain exact; restrictive labels
  such as `Constraints:` and `Out-of-scope:` never disappear. Lexemes serve only
  the generic/empty refusal, never destructive equality.
  Scope identity is the full case-sensitive repository path; an explicitly
  named directory is compatible with descendants, but sibling files are not.
  Its structured result and `[queue-dedup-sweep]` log retain the established
  fields for calls, merges, prompt/completion tokens, and USD cost; every model
  field is zero by construction. A null
  `grooming_rationale` still marks an ordinary groom in flight; claimed,
  executing, held, incubating, blocked, parked, and done tasks remain outside
  this path. Weak identity, different scopes, or a missing, leased, non-queued,
  terminal, or cross-Project row refuses mutation. Ordinary grooming uses one
  Queue transaction to keep only a still-unleased `QUEUED` source as accepted
  new work and insert its cited fallback decision; a source claimed or completed
  while the model ran is left untouched. A later winning merge retargets that
  decision with the source history. Consolidation emits a bounded
  `[queue-dedup-skip]` record and continues.
  Each accepted merge writes one destination-owned decision containing the
  source id, original title, and original body before it retargets durable
  decisions, threads, events, questions, notes, attempts, and other task-owned
  records and deletes the source in the same transaction. Idempotency and
  mediator-memory writers reserve the same live source row before publishing
  their non-foreign-key task id, so they either precede the retarget or reject
  a source that the merge already deleted. Startup repair deletes committed
  null, missing-task, and cross-Project idempotency rows and clears invalid
  memory source ids, preventing legacy metadata from permanently poisoning
  retries or taskless memory updates.
  OpenRouter completion operations, including their hedge, transient retries,
  and backoff, abort after 180 seconds by default;
  `OPENROUTER_REQUEST_TIMEOUT_MS` overrides that hard logical-request deadline
  independently of the worker job watchdog. Structured
  completions start with a 32,768-token budget and retry a provider-declared or
  structurally detected truncation once at up to 65,536 tokens without
  re-embedding the cut output. A second cut is a typed truncation failure;
  complete malformed output stays on the ordinary schema-repair path. Both
  paths are `OpenRouterMalformedOutput` failures handled by one bounded Effect
  Schedule inside a single shared-runtime execution.
- **Short-lived scoped sessions, injected context.** Each inbound event
  (`human.submit`, `coder.propose_plan`, `coder.ask`, …) runs as a job that
  spins up or resumes a *thread-scoped* Pi session. "Knows all" comes from a
  `before_agent_start` **context pack**: live queue snapshot, priority ladder,
  and the **decision log**: every approve/merge/re-priority written as a
  structured DB record. Memory lives in the store, outside the context window.
- **History is pulled; durable decisions are filtered before injection.** The
  context pack carries root, own-task, ancestor, and sibling thread ids and
  compact task summaries. Frigg calls `thread_read` only when that history is
  relevant; no turn receives transcript bytes by default. Decision
  injection retains task and lineage matches, text-relevant records, and the
  two newest project-wide records, capped at eight. Its model-authored summary
  is compacted by selection only; the stored rationale remains verbatim.
- **Prompt-cache affinity is per job, never per project.** Pinned GLM jobs use
  `memracer:<project>:<job>` as the OpenRouter session id so retries and tool
  turns share routing without coupling concurrent jobs. Cache rollout is a
  1% deterministic canary by default and has config-only `on` and `off`
  controls; Auto Router is excluded because its resolved model is not stable.
  The server clock is the final context line so the tool definitions, rubric,
  context, and reasoning-first JSON order remain byte-stable ahead of it.
- **One Effect runtime owns mediator concurrency.** `main.ts` builds one
  DB-backed `ManagedRuntime` from overridable database, config, clock, and
  logging Layers, then passes that exact instance through `createApp` and
  `MediatorWorker` and binds each `OpenRouterDriver` to its service-free
  runner. One scoped worker root supervises periodic work, scheduling fibers,
  and a separate executing-only `FiberSet`; public in-flight status reads only
  the latter, never blocked or null claim attempts. An Effect Queue carries
  coalesced wakeups and a Semaphore keeps the default handler cap at three.
  Independently constructed workers create and dispose their own DB-backed
  runtime; an injected runtime remains owned by its caller. The typed Promise
  bridge unwraps `Effect.either`, so tagged failures reach the existing
  Promise-facing driver and handler contracts unchanged. The convention in
  `docs/effect-boundaries.md` keeps database transactions, Queue domain
  operations, Express, MCP, and the `MediatorDriver` interface Promise-based.
- **Claims retain their proof.** Groom output cites compact `EVID-<id>`,
  `DEC-<id>`, `#<task>`, and `PR #<number>` tokens. `mintReferences` validates
  those tokens against the context pack and submission evidence, resolves
  internal dashboard targets or the recorded external PR URL, and persists the
  resulting `Reference[]` on `decision_log.citations`. A merge resolves evidence
  links to the surviving task; an invalid merge fallback atomically keeps them
  on the original task with its `create` decision, which a later merge retargets.
  Internal URLs include the project id so a shared link restores the right
  tenant. Unsupported typed tokens are blanked before task, decision,
  transcript, or session persistence. Bare `#<number>` never consumes a
  `PR #<number>` token, and taskless decisions are not citable because they
  have no honest in-overlay destination.
- **Reads parallel, writes serialized.** Answering a coder question and
  grooming a submission run concurrently; anything that mutates the queue
  funnels through a per-project single-writer transaction, so two sessions
  cannot issue conflicting priority calls. Refresh jobs add a DB-visible
  same-Project running guard: distinct answer/generation payloads stay FIFO,
  while other Projects continue in parallel.
- **Never hangs.** Every mediator invocation is a queued job with a hard
  timeout and retry. The worker acquires a concurrency permit before its
  serialized atomic claim, then wraps that exact claim in
  `Effect.acquireRelease`. Completion and retry writes compare job id,
  `RUNNING` status, attempt, and start time; interruption or an unexpected
  throw can safely return only the claim still owned by that fiber. Handler
  Promises run behind an Effect timeout, so even a Promise that ignores
  cancellation releases its worker slot. Human writes return durable job ids
  before this work starts; coder plan and question tools retain bounded reads
  of the same jobs. `stop()` wakes sleeping periodic work and no handler begins
  after it: a claim that completes across the stop boundary is rechecked and
  returned by its exact guarded finalizer. `stopAndWait` first permits graceful
  completion, then interrupts the root scope before the absolute deadline so a
  bounded cleanup tail remains. A scheduling parent explicitly interrupts and
  awaits its executing child before the finalizer requeues. Shutdown-path
  requeue persistence is best-effort only until that deadline. Every release
  observes a dormant one-shot deadline signal, including one already blocked
  after `stop()` but before `stopAndWait()` arms it. If its DB Promise remains
  unresolved, Effect stops awaiting it and the next worker's lazy watchdog
  recovers the still-running row. Active HTTP responses share the
  deadline: idle connections close immediately and remaining responses are
  force-closed before runtime and DB cleanup begins. The outer shutdown reserves
  up to 250 ms after the HTTP/worker drain, then bounds runtime-disposal and
  DB-close waits to the same absolute deadline while still invoking runtime
  before DB. The signal path logs a bounded failure and hard
  exits 1, or hard exits 0 after success, so an underlying driver Promise that
  ignores cancellation cannot pin the process. Dual signals share one handling
  guard, synchronous stop errors remain on the one idempotent shutdown promise,
  and cleanup still proceeds. Sweep and slot wakeups coalesce
  without an idle hot loop. The durable decision log means a retried session
  loses nothing.
- **Terminal failures are inspectable.** A handler failure that exhausts its
  job retry writes one `[mediator-job-failure]` JSON entry to stderr with job
  id, kind, attempts, model, and error. OpenRouter output failures also carry
  the final raw completion, truncated to 2,048 UTF-8 bytes at the log boundary.
  The prefix and `kind` field make failure rates countable with ordinary log
  tools. OpenRouter 429 and 529 responses use their own three-attempt
  exponential budget; once spent, the worker does not repeat that budget.
- **OpenRouter final output is schema-bound.** Every mediator operation passes
  its existing Zod result schema into request construction. Final no-tool
  turns use strict structured output, while tool turns require tool-capable
  providers and disable parallel calls. Inceptron is denied by default after a
  measured live routing regression; reasoning is off by default. Environment
  policy can replace the provider deny-list, enable or bound reasoning, change
  the twelve-round tool budget, and change the 180-second request deadline.
  After any successful tool dispatch, the one structured retry retains that
  transcript but disables tools, so it cannot replay successful writes.
  Assistant reasoning metadata survives tool continuations. Request-only
  context compaction retains small results and the newest result exactly and
  replaces older large results with deterministic semantic excerpts, hashes,
  and byte lengths in at most 512 bytes without changing the dispatch
  transcript.

  Runtime Zod validation and the one corrective retry remain authoritative,
  including for constraints that JSON Schema cannot represent. Before
  validation, the read boundary unwraps a complete XML tool-call envelope,
  stable-dedupes `checked_domains`, and truncates only groom
  `knowledge_events[].reason` strings beyond the schema's 300-character limit.
  No other fields are coerced. The default eval includes a deterministic
  60-job output-reliability soak with fifteen cases each for XML, truncation,
  duplicate-set, and over-length-reason recovery. It fails on any bad result,
  request-budget mismatch, or metering mismatch.
- **Transcript mirror.** `session.subscribe` events stream to
  `mediator_events` for [dashboard](dashboard.md) replay.

# Related

- [Mediator private memory](mediator-memory.md): the curated OKF bundle
  whose digest joins the context pack.
- [Task lifecycle](task-lifecycle.md)
