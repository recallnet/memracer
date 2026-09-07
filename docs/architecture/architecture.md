# System architecture and namespacing

A resumable MCP server with role-gated tool surfaces, a per-project mediator, a database as the sole source of truth, Org to Project to Member namespacing, and org BYOK for customer inference.

# Shape

One dual-mode MCP server (streamable HTTP, OAuth): initialized clients get a
resumable session, while headerless one-shot POST remains stateless. The token's role decides
the tool list served (`tools/list` filtered per auth context). The mediator
runs server-side as per-project Pi sessions;
every grooming and plan-review exchange is persisted for dashboard replay.
Process-local transport handles are disposable: after a restart, a still-valid
durable `MCP-Session-Id` rehydrates a fresh transport+server from the DB
(single-flight) so tool calls and GET SSE survive redeploy without a manual
reconnect.
Customer mediator completions use **org BYOK** (OpenAI-compatible provider +
encrypted provider keys in Org Settings). Default is **fail-closed**: customer
orgs without a usable key get an Org Settings error on MCP tools that can
trigger Frigg. The host `OPENROUTER_API_KEY` is **not** used for customer jobs
except a narrow **allowlist** (`MEMRACER_HOST_FALLBACK_ORGS`) for true
missing-key cases on allowlisted orgs only. It never covers unknown-provider,
base-URL, or corrupt-key errors. Fallback preserves the org's configured
provider and models; only the key material comes from the host. MCP edge
gates (`assertProjectInferenceReadyForMcp`) never use host fallback. Projects
with null `org_id` are a **test-fixture exception** that skip the
MCP gate; customer signup always attaches an org, and
`resolveInferenceForProject` still requires org+key for real completions.

```
humans ──(Claude Code/Desktop, human.* tools)──┐
                                               ├── memracer-server ── DB (source of truth)
coders ──(coder.* tools, long-poll loop)───────┘        │
                                                 memracer-mediator workers (Pi sessions)
                                                        │
                                              dashboard (read-only, SSE)
```

# Namespacing

**Org → Project → Members** with role `human | coder | admin`.

- One MCP endpoint for everyone: `https://<host>/mcp`. The token alone
  resolves the member. Per-project URL paths were rejected because
  human-chosen slugs collide across teams and leak names, and the URL is
  pasted once at `claude mcp add` and never seen again.
- **Project-scoped API keys**: every headless key declares `metadata.projectId`.
  Authentication returns only that matching membership, even when the owner
  belongs to other projects. Missing metadata, unknown scope, or a membership
  removed after minting fails closed. `list_projects`, tools, and task
  resources therefore expose only the key's project. Human browser sessions
  remain identity-scoped and may resolve all memberships for the dashboard
  switcher. A future identity-wide API key requires an explicit new scope and
  resolver branch; multiple memberships are never the default.
- Interactive MCP OAuth grants are also Project-scoped seats. Better Auth owns
  DCR, S256 PKCE, authorization codes, refresh tokens, and consent. The app
  requires the exact canonical `/mcp` resource and adds one opaque
  `oauth_seats` grant carrying user, Project, explicit human/coder role, and
  display name. Its UUID remains stable across refresh and owns leases and MCP
  sessions. Missing, duplicate, revoked, cross-user, or stale-membership seat
  scopes fail closed. Browser cookie resolution remains identity-wide.
- A human may mint multiple project-scoped API-key **seats** for different MCP
  clients. Live clarification routing follows the connected session's
  advertised elicitation capability; API-key metadata plays no part. The retained
  `clarificationMode` field is compatibility-only and has no runtime authority.
- Lease ownership remains the verified API-key id. Presentation boundaries use
  `projectActorLabels` in `src/present-task-brief.ts` to join that key's
  `referenceId` to the owning user and render `{user}-{token}`. The resolver
  requires non-empty user and key names plus canonical metadata for the owning
  Project; missing, malformed, legacy, or cross-Project actors remain opaque.
- Two tool namespaces on the same server: `human.*` and `coder.*`
  ([protocol](mcp-protocol.md)).
- The resolved role also selects the MCP connect-time `instructions`. Human
  seats receive the inspect-first HITL contract: one short paragraph of at
  most five short sentences by default, and no deciding, rejecting, combining,
  reframing, choosing, or recommending at a consequential fork before the user
  answers. The same shared HUMAN block says mediator grooming will grill one
  decision at a time; human agents help it self-serve facts and route only
  decisions they cannot own to the human in the loop. Coder seats retain the
  separate read-only check → explicit claim → plan → complete contract. Admin seats
  receive both blocks. The React dashboard's copy-paste agent prompt and the
  server import both role blocks from
  `src/dashboard/public/role-contracts.js`. Dynamic identity, project, URL,
  and warming-task framing remains outside those shared strings. Dashboard
  coder setup also appends the goal-shape execution guidance; it does not alter
  the shared connect-time contract.
- Browser identity is passwordless. `src/auth/instance.ts` enables Better
  Auth's magic-link plugin with a 900-second lifetime and hashed verification
  storage; `src/email.ts` sends the link through Resend from the configured
  sender address. The transport fails closed when `RESEND_API_KEY` is
  absent and never logs the token. Better Auth atomically consumes a verified
  token, establishes the browser session, and rejects replay. Invitation
  acceptance then requires that session's exact invited email before consuming
  the separate single-use invitation row. GitHub OAuth remains an independent
  social provider.
- The same resolved membership scopes the server's host-agnostic prompt and
  resource surface. Prompt visibility is role-based; read-only `project://`,
  `queue://`, `question://`, `task://`, and `okf://` resources are available
  to every authenticated role but may expose only that API key's Project.
  Queue and list reads are capped, question lookups fail closed, and OKF
  content is rendered from `memory_docs`; the checkout filesystem is not read.

Project OKF is a hard tenant sandbox: concepts may reference other concepts
inside the same Project, but cross-Project references are out of scope. A
future explicit sharing feature would need its own authorization and resource
contract; it must not emerge from a path or link that silently crosses the
Project boundary.

# Persistence and sharing

The database is the only source of truth. MCP session identity, key ownership,
capabilities, expiry, and replayable events live in `mcp_sessions` and
`mcp_events`; active SDK servers and GET stream handles are disposable local
delivery state. A replacement process can authenticate and replay a dropped
stream from a session-owned `Last-Event-ID`. Normal session requests remain
bound to the process holding the active SDK transport, matching the single
`memracer-server` production topology.
It sits behind an async driver seam (`src/db.ts`): better-sqlite3 by
default, Postgres via node-postgres when `DATABASE_URL` is set. Both share the
same schema and queue semantics, and the full test suite runs on both (CI runs
the suite per backend; the Postgres leg rides PGlite through the production
driver). The migration steps are in `../postgres-migration.md`.

SQLite enum-like `CHECK` changes are startup migrations that also apply
to existing databases. `src/db/sqlite.ts` inspects the stored table DDL and rebuilds a stale
table inside one transaction from the shared `*_COLUMNS` definition, copies
all rows, and recreates indexes. The `jobs.kind` guard requires every current
kind, including `consolidate` and `refresh`; a database with a predecessor
constraint is rebuilt once and then becomes a no-op on later starts. Postgres
widens a matching legacy kind constraint idempotently. `decision_log.kind` and
`evidence.kind` have equivalent current guards. `session_events` has retained
its original `type`, `role`, and `status` sets since that additive table was
introduced.

Dashboard read paths use the same indexes in both dialects:
`threads(project_id,id)`, `thread_messages(thread_id,id)`,
`evidence(task_id)`, and `attempts(task_id)`. SQLite table rebuilds recreate
the index owned by the rebuilt table before startup continues. Queue, thread,
decision, warming, and question lists use bounded keyset pages and return an
opaque `next_cursor`; their existing item arrays remain the response contract.
The thread page aggregates message bounds once for the selected rows and joins
those ids back to message content, replacing four correlated scans per
thread.

The MCP `human_status` presentation boundary does not expose every full task
row. It projects compact operational fields, caps each project at 50 tasks by
default, and returns offset/limit/total/next-offset metadata. Callers can
select top-level sections and opt into full rows for a bounded page. The queue
service and DB query remain full fidelity, so scoped task reads and internal
consumers do not inherit this projection.

- Tasks, evidence, decision log, and mediator transcripts (mirrored from
  `session.subscribe` events) all land in the DB.
- `tasks.lease_ttl_ms` persists the bounded renewal duration independently of
  any MCP connection. Lease owner, expiry, and duration therefore survive
  process or connection replacement; five-minute recovery-grace enforcement
  remains a database compare-and-set transition.
- `tasks.block_kind` and `tasks.block_requeue_at` make every `BLOCKED` row's
  exit path durable. Human and dependency blocks are paired transactionally
  with an open task question; infrastructure blocks carry a retry clock. The
  worker sweep requeues expired infrastructure blocks and repairs rows with
  neither trigger.
- Image attachments keep their authoritative existence, Project/task
  association, media type, caption, and opaque object reference in `evidence`.
  Their bytes live only in the object store under a server-generated key. Existing task JSON
  excludes image rows; dedicated authenticated reads join the DB authority to
  the blob store. Missing blob configuration leaves server boot and ordinary
  task work healthy but makes attachment writes unavailable. See
  [task image attachments](image-attachments.md).
- Every `decision_log` row has a `citations` JSON array. Phase 1 fills it for
  grooming decisions; other decision kinds remain backward-compatible at `[]`.
  References are limited to validated task, decision, evidence, and completed
  pull-request records; model-authored URLs never enter the column. Evidence
  row ids are stable provenance keys and survive a submission merge by moving
  to the surviving task.
- The human's Claude session holds zero state. Switch machines or wipe a
  session and `human.status` rehydrates everything.
- Human mediator writes commit before model work. The `jobs` table owns groom,
  discussion, catch-up, enhancement, and conciliation progress; small scoped
  status tools recover eventual results across HTTP connections. The
  `submission_idempotency` table reserves `(project, member, client key)` and
  links it to one task in the same transaction, so retries stay stateless and
  cannot double-file under concurrency.
- Every successful `human_*` response performs one bounded read of open
  mediator questions joined to tasks submitted by the authenticated member.
  The query also requires the resolved human/admin Project membership, returns
  five rows at a time with a truthful continuation cursor, and runs after the
  tool mutation so a completed answer disappears immediately. This is the
  guaranteed clarification channel when no live elicitation stream exists.
- Every completed mediator pipeline writes one `mediator_usage` rollup keyed
  by job. It records Project, job kind, requested and provider-resolved model,
  prompt and completion tokens, cache reads and writes, cache discount, total
  provider cost, completion count, and timestamp. Additive upserts cover every
  driver turn in a tool loop and make job, Project, and day aggregation plain
  SQL without relying on process logs.
- Every policy-routed provider invocation also writes `job_policy_log`, keyed
  by job, worker attempt, and invocation ordinal. It stores the applied model,
  effort, token budget, optional groom difficulty, A/B arm, latency, tokens,
  worker outcome, and optional rejected/steered/reopened signal. This table is
  the evidence source for routing policy; `mediator_usage` remains the compact
  cost rollup. Retry/failure finalization preserves already-recorded
  per-invocation completion latency, and downstream quality annotation is
  best-effort after the semantic mutation so telemetry failure cannot replay
  completed work. `steered` remains a compatibility value without a current
  producer after live human steering was retired.
- `jobs.coalesce_key` is nullable: unconditional enqueue leaves it null, while
  `findOrEnqueue` hashes the exact payload and uses a partial unique index over
  pending/running rows. Concurrent identical calls select one durable winner.
  The claim query serializes refresh work per Project; distinct generation and
  answer payloads remain queued in id order, while other Projects and kinds run
  concurrently.
- Unattended-work attention is server-durable but pull-triggered.
  `projects.attention_grace_ms` (15 minutes by default) and
  `projects.attention_cooldown_ms` (30 minutes) are operational settings.
  `attention_alerts` holds one row per task and increments its episode only
  after resolution plus cooldown. `tasks.queued_at` changes only on entry to
  QUEUED; `tasks.queue_generation` and `projects.claim_generation` expose task
  and project lease episodes that begin and end between pulls, including
  same-millisecond transitions. `human_status` performs the transactional
  eligibility pass. The host hook serializes desktop delivery through a local
  stale-recovering lock and stores seen ids outside the server DB.
- Sharing is project membership: every member's front-end session and the
  dashboard read the same rows.
- The dashboard is one Vite-built React application at `/dashboard`. The
  server exposes only its generated `app.js` and `dashboard.css`, plus retained
  static sign-in, invite-join, PWA, shared-style, icon, MCP-snippet, and role
  contract assets. The pre-React homepage, URL controller, and standalone
  island bundle are absent from source and release artifacts. The activity and
  task views import `TimelineIsland` from `src/dashboard/island/index.tsx` as
  their shared chronological transcript surface; there is no second browser
  entry. Startup logs a critical error before listening when any required
  dashboard artifact is absent or empty.
- Human names are labels and carry no uniqueness constraint. Organization and project
  creation normalizes a bounded slug base and atomically tries that base,
  `base-2`, and later suffixes with `INSERT ... ON CONFLICT DO NOTHING` in the
  caller's transaction. Only a collision on the candidate id or paired
  better-auth slug advances the suffix; foreign-key and other database errors
  escape. A project claim includes its application row, paired better-auth
  organization, and creator admin membership, so any paired collision rolls
  the whole attempt back before retrying. Admin and seed creation use the same
  allocator. Successful responses report whether the exact display name was
  already present; duplicate labels remain visible and no earlier row is
  overwritten.
- Org access is derived and has no separate storage. `src/auth.ts:isOrgMember`
  authorizes the recorded Org creator or any user with a membership in one of
  that Org's Projects. Project creation requires this access: a missing Org is
  a 404 and an existing Org outside the caller's access is a 403. The Org
  roster is the flat set of actual Project membership rows joined to users;
  the creator is not synthesized into an empty Org's roster.
- GitHub-native Project enrollment is additive to manual creation. Better Auth
  owns the GitHub App user token. `src/github-app.ts` signs a 15-minute install
  state bound to the current user and Org, then verifies the returned
  installation through GitHub's user-installations API. Both
  `repository_selection=selected` and `all` are accepted without broadening
  the App's read-only permissions. `github_installations` records one verified
  installation and its access scope per Org; `github_project_repos` still binds
  one visible repository to one Project. Existing SQLite databases widen the
  enum-like CHECK through a guarded parent-table rebuild, while Postgres drops
  and recreates the matching constraint idempotently. Both creation routes call
  the same transaction that writes `projects.repo`, the paired better-auth
  organization, and the creator's admin membership. Original free-text
  repository creation remains unchanged. GitHub App setup is in
  [github-app.md](../github-app.md).
- `projects.created_by` records the creator independently of the mutable
  membership role. Project authorization treats that creator or a member with
  the explicit `admin` role as an admin; ordinary invitations default to
  `human`, and accepted invitations persist their selected `human | coder |
  admin` role. The startup migration repairs only legacy projects whose
  `created_by` is null. It uses the recorded Org creator when that person has a
  Project membership, otherwise the earliest persisted admin membership. It
  backfills the creator, rewrites historical admin invitations to `human`, and
  demotes every other inherited admin membership to `human`. Versioned one-shot
  markers keep later explicit promotions untouched. Historical role changes
  made outside an invitation have no audit record and are deliberately demoted
  once.
- Project creators and explicit admins may permanently delete a project only by
  submitting its exact stored name. One DB transaction severs the task/thread
  cycle and removes the
  project's application rows, private OKF, metadata-scoped API keys,
  invitations, memberships, paired better-auth organization, and project row.
  The owning team, sibling projects, and user identities survive. Postgres
  locks both the admin membership and project row, then defers the circular
  task/thread constraint inside the transaction; SQLite's `BEGIN IMMEDIATE`
  serializes the same authorization, exact-name check, and purge. Incoming
  cross-project FKs are either detached when nullable or removed when their
  required session/thread owner is deleted. API-key cleanup uses the same
  scope decoder as authentication: legacy omitted-scope and double-encoded
  project metadata count as project scope, while explicit global/user scopes
  survive. The final project delete must affect exactly one row. The queue
  publishes its final change only after commit, so observers cannot read a
  half-deleted project or receive false success from a competing delete.

# Data model (v1 tables)

`orgs`, `projects`, `github_installations`, `github_project_repos`, `tasks` (see
[task lifecycle](task-lifecycle.md)), `evidence` (text provenance plus
metadata-only [image attachments](image-attachments.md)), `threads` (mediator
conversations), `decision_log`, `mediator_events` (transcript mirror),
`jobs`, `mediator_usage` (per-job model usage and cost rollups),
`job_policy_log` (per-invocation routing, attempt, and quality telemetry),
`attention_alerts` (pull-created unattended episodes), `questions` (task-bound escalations and taskless project-context
questions), `project_context_domains` (per-domain refresh clocks and event
generations), `memory_docs` / `memory_log` (the mediator's private OKF).

After the database opens, startup normalizes malformed `memory_docs.body`
values across every Project before `createApp` starts the worker or HTTP
listener. This is an application-level, dialect-neutral repair: only changed
body bytes are written, while row metadata and `updated_at` stay intact.

`questions.task_id` is nullable. Optional `domain`, `refresh_trigger`,
`answered_by`, `answered_at`, and `curated_at` fields preserve adaptive project-question
provenance and whether an answered Project Q/A reached successful OKF
curation. A non-null id keeps the existing task
clarification, park, and requeue behavior. A null id is a project question:
it has the same stable question id and open/answered lifecycle but never
changes a task state. `src/mediator/question-ledger.ts` projects both scopes
into the mediator's [private memory](mediator-memory.md).

The dashboard's project analytics read uses the same tenant boundary as every
other project route. Its bounded period query joins task state/activity and
coder attempts to verified member and seat labels, then aggregates persisted
Frigg routing and usage telemetry. The Team view defaults to seven days and
returns additive contribution counts (steer/create/complete/answer), previous-
window deltas, proportional routing bars, and completion-scaled scorecard
rows without adding an endpoint or write path. Contributor attribution prefers
a stable `user.id`, falls back only to a unique normalized display name, and
credits a completed task to its latest completed seat owner when that owner is a
current member; ambiguous or unresolved actors are never guessed. It is
deliberately read-only: the only new write is answer attribution in
`questions.answered_by`; task submission ownership remains `submitted_by`.

`tasks.incubate_until` is set only while a task is `INCUBATING`. A task may be
born there through `human_submit(warm_for)`, or its submitter/project admin may
atomically move it from `QUEUED` through `human_warm_task`. The state-guarded
update cannot reclaim work after a coder has won the `QUEUED` → `CLAIMED`
race. Entering warming clears any approved coder plan retained after a release,
because human curation may change the canonical spec; attempt history remains.
Incubating tasks stay off coder claim surfaces until the clock-driven seal groom
or `human_seal_incubation` graduates them.

# Related

- [MCP protocol](mcp-protocol.md)
- [Mediator sessions](mediator-sessions.md)
