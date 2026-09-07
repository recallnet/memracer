# Mediator private memory: a DB-backed OKF bundle

The mediator curates a per-project OKF bundle in the database, records task-attributed writes, and exposes read-only provenance to project members.

# What it is

The mediator keeps a private per-project knowledge bundle in two tables:
`memory_docs` (one row per OKF concept, keyed `(project_id, path)`) and
`memory_log` (append-only trail). `src/mediator/memory.ts` (`MemoryStore`)
is the only writer. Nothing renders these as files on disk; `renderIndexes`
synthesizes the bundle-root index and one virtual `index.md` for every concept
directory, while `renderConcept` composes concept YAML frontmatter from
columns at read time. The root index carries the sole `okf_version` block;
directory indexes have relative subdirectory and concept links with no
frontmatter. `okf_read` accepts either `tech/` or `tech/index.md` for those
virtual files. The model never writes frontmatter, and every `index.md` plus
`log.md` remains a reserved path `upsert` rejects.

# Curation

Tool-enabled groom, review, and answer turns curate directly through the
project-scoped `okf_*` tools. The mediator first reads the generated index and
`core-assets.md`, classifies durable input, lists every affected standing asset,
then updates each asset in the same turn. It preserves latest-input-wins and
the no-sprawl rule. Before each `okf_write`, it must `okf_grep` for the topic
and inspect the matches. A matching standing asset is changed with
`okf_update`. A new concept is exceptional: the grep must find no existing home,
and the mediator must state the durable gap that justifies the new path.

The deterministic `pnpm eval --over-mint` gate exercises both sides of that
contract through the real Queue, mediator worker, groom pipeline, and
project-scoped memory tools. A learning covered by an existing concept must
produce grep then update; a new durable topic may produce grep then write only
with a no-match justification. The gate penalizes a missing pre-write grep or
an unjustified write, including a task page beside an existing home. The
default `pnpm eval` runs this zero-tolerance gate beside the
over-clarification gate.

## Judgment failure modes

The mediator's judgment must avoid three failure modes: over-clarifying by
bouncing ownable technical choices back to a human; over-atomizing by splitting
one coherent goal into per-file shards; and scope drift by steering the groom
toward what is easy to implement and away from what the human meant. Keep one
intent as one task unless goals are independent. When scope appears
to change, surface it as a revision or clarification; do not silently
expand the work.

The runtime routing map covers decisions, conventions, risks, architecture
changes, priority/product changes, dependency or test-command changes,
recurring learnings, and answered questions. An answer updates the
open-question ledger and every affected decision, architecture, convention,
risk, roadmap, or glossary concept in the same pass; there is no separate
curate-on-answer queue.

Each individual upsert enforces the OKF structural boundary: one non-empty,
free-form descriptive type; a kebab-case Markdown path; and reserved protection
for generated `index.md` and `log.md` files. Types do not determine directories.
`normalizeMemoryBody` runs in that same `MemoryStore.upsert` gate. It converts
line separators only when the whole value is demonstrably double-encoded
Markdown, then removes one standard leading YAML frontmatter block. Literal
backslash-newline text in prose, JSON, regexes, and code remains byte-identical;
metadata stays in the row's dedicated columns. Startup runs the same idempotent
normalization across every Project before the worker or HTTP listener starts.
Repair updates only changed body bytes and preserves each row's metadata and
`updated_at` provenance.
The mediator chooses domain folders such as `decisions/`, `tech/`,
`conventions/`, `research/`, and `risks/`; it does not send unmatched concepts
to an `architecture/` catch-all. Grep-first, edit-don't-mint, reciprocal links,
structural bodies, and no-slop writing remain prompt and eval discipline rather
than invented OKF validator rules. After a multi-asset change, `okf_validate`
renders every generated index and concept, reports structural errors, and
returns reciprocal-link gaps. The mediator closes those gaps before returning
unless a real unresolved reason remains.

The write gate lives at the prompt/eval level; there is no runtime policy gate:
`okf_grep` plus a read routes an existing home through `okf_update`, while a
new path requires an explicit durable-gap justification. A runtime refusal
would strand legitimate turns and is not part of the settled design.

Each Project's OKF is a hard security sandbox. Concepts may link within that
Project, but cross-Project references are out of scope and must not become an
implicit sharing channel.

# Sprawl recovery

`pnpm okf:consolidate` repairs a bundle that predates the grep-first discipline.
The command defaults to dry run. It snapshots and round-trip verifies the exact
source rows, checks the expected source watermark,
merges per-task concepts into standing domain assets, rewrites internal links,
closes reciprocal gaps, and validates the complete proposed bundle before one
transaction replaces the rows. Apply mode writes a recovery snapshot first;
reruns are idempotent, and an unexpected live inventory fails closed.

Reviewed production builders use stable assertion prefixes to confirm that a
source still carries each approved contract. The result body comes from the
complete reviewed live sections. The markers only confirm the contract. A later explanatory
suffix therefore survives consolidation without defeating plan generation,
while removing or changing the assertion itself still fails closed.
Status-bearing anchors use stable, status-neutral prefixes. When a reviewed
source still contains an older task state, the result labels that block as a
historical source receipt and states the cutover-time task truth separately;
an obsolete `QUEUED` receipt cannot masquerade as current status.
The system-owned open-question projection remains byte-identical when present.
When every question is answered and `QuestionLedger` has removed the concept,
consolidation keeps it absent and writes no empty ledger.

`contextFor` passes the current task id into the project-scoped memory tools.
After a successful `okf_write` or `okf_update`, the tool appends a readable
`memory_log` entry with the action, concept path, and server-owned task
attribution. Validation failures and missing update targets produce no audit
entry. Project-level turns retain a null task id.

Concept provenance also travels with the concept. Tool writes set optional
`source_task` and `as_of` frontmatter from server-owned context; explicit
`supersedes` and `superseded_by` lists record replacements. `memory_docs`
stores those fields separately and `renderConcept` composes them into YAML.
Old concepts with no provenance and links to missing concepts remain valid.
`okf_write` is create-only, while `okf_update` compares the revision read by
that scoped turn before writing. A competing edit returns a reread-and-reconcile
error, so neither writer is lost silently.

# Recall

`contextFor` in `src/mediator/pipelines.ts` binds `MemoryTools` to exactly one
project. The mediator reads the generated index, greps concepts, and opens the
relevant documents before deciding. Drivers without tool calling retain the
bounded `MemoryStore.digest` fallback: the index plus whole relevant concepts
under a character budget.

Stored coder plans use the same pull model. `plan_grep` searches non-empty
`tasks.plan` values inside the bound project, and `plan_read` opens one plan
only when its task belongs to that project. Plan text is not added to the
context pack or digest. The mediator may turn a durable plan-derived learning
into OKF memory through the existing grep-first curation path, but no plan
creates a mandatory memory write.

Mediator prose cites a retrieved plan as `PLAN-<task id>`. The existing
server-side reference minter validates that the project task has a stored plan,
then emits the existing `task` reference type with an `#plan` deep link and a
plan-specific label. This keeps one citation pipeline and one reference schema;
the dashboard's approved-plan section supplies the stable anchor.

# Project knowledge model and refresh

`src/mediator/project-knowledge.ts` treats ten domains as an attention and
routing taxonomy: product/bounds, priorities/roadmap, team/people,
roles/collaboration, architecture/tech, constraints/invariants,
domain/vocabulary, history/decisions/learnings, operational/external, and
preferences/felt experience. Domains do not prescribe OKF folders or one
question each. Durable concepts may carry exact `domain:<id>` tags when they
help route later attention; successful `MemoryStore.upsert` calls with those
tags are the server-observed freshness signal for the matching hints.

`project_context_domains` stores each domain's last check, last successful
tagged refresh, dirty reason, and requested/applied event generations. The
refresh worker ranks old and dirty domains oldest-first, while the mediator
chooses at most three equally-old domains from current relevance. One
project-wide 24-hour cooldown prevents a blank Project from draining all ten
domains in consecutive status reads. Dirty events bypass that cooldown:
repository association, teammate or role changes, task completion and
reconciliation, and unresolved evidence-grounded contradictions emitted by
grooming remain eligible for the next sweep. Five completed tasks also mark
priorities, architecture, and history for attention. A thirty-minute sweep
catches time decay, old tagged concepts, old open questions, and accumulated
dirty events.

Team and role refreshes receive a server-owned roster containing only the
current Project's member display names and Project roles. The query is scoped
by Project id and excludes email, profile, scheduling, and every other
Project. Join and role events name the changed member; removal captures the
member's name and former role before deleting the row, while the roster
correctly omits them afterward.

Groom, review, and answer turns perform episodic capture while they still own
the evidence and task context. The shared memory rubric requires grep/read and
edit-in-place during that turn. A contradiction the turn cannot resolve marks
the affected attention hint dirty; it does not launch a second context-poor
model call immediately.

Each consolidation turn remains agentic. Application code supplies ranked evidence,
triggers, cooldowns, and hard limits; `buildProjectKnowledgePrompt` decides
whether to curate, ask, or stop. AGENTIC-DEFAULT outranks taxonomy
completeness. Reversible gaps are inferred, questions remain genuine
human-owned decisions, and a batch has at most one question per domain and
three total. Successful domain-tagged `okf_write` or `okf_update` calls advance
write freshness; model output alone cannot. A check with no write is a
successful no-op that advances only check freshness and the cooldown. Checked
domains outside the server-supplied candidates are ignored and reported as a
soft diagnostic; the recurring job does not fail.

The ten domains are non-binding attention hints. Concepts may use any useful
folder and need no domain tag. A recognized `domain:<id>` tag opts a concept
into that hint's write-freshness tracking without acting as a curation gate. Ordinary
repository, team, task, groom, and reconciliation events only advance dirty
generations. The 30-minute sweep coalesces those bursts into one generic job,
and the worker claim boundary serializes consolidation per Project. Explicit
human answers and `human_status` recovery may still enqueue immediately.

Refresh excludes individual coder style, exact dependency versions, CI/deploy
detail, unused external APIs, personal scheduling, debugging narration,
competitor matrices, team social dynamics, budgets, and engagement tracking.

Event generations prevent consolidation from clearing a mutation committed
after its snapshot. A refresh captures the requested generation it observed
and advances only through that generation; a later mutation remains dirty for
the next periodic pass. The periodic scheduler uses one generic coalescing
payload, and the claim boundary permits only one running refresh per Project
across worker instances while other Projects and job kinds retain concurrency.
Explicit answer and recovery jobs retain their event-generation snapshots.
Concurrent event writers lock the domain row before appending, preserving
every reason and generation. A project repo slug is association evidence only: the mediator may
rederive architecture or conventions from code/git only when a future
integration supplies readable source.

OpenRouter exposes the scoped OKF tools required by refresh curation. Pi does
not advertise refresh until its tool execution can avoid hedged duplicate
side effects. Optional/custom drivers without refresh support return an
explicit skipped result without changing clocks, leaving dirty state for a
capable driver.

# Question ledger

`questions` is operational truth. `QuestionLedger` rewrites one concept,
`questions/open-questions.md`, after every shared add or answer. There is no
second editable record. The concept is an open-only projection:
answered rows remain in `questions` as audit history, but they are excluded
from the pinned memory doc. Each rendered line carries the stable question id,
optional task id, asker, explicit `[open]` state, and question. The same path
is upserted while open rows exist, so current DB state wins and the text stays
grep-able. When no open rows remain, `QuestionLedger.sync` removes the concept.
The concept links back to the generated project-memory index.

The fixed six-question seed is retired. `human_status` schedules one
deduplicated adaptive refresh and returns current durable state. Normal
grooming can still append up to three novel non-blocking unknowns. Ordinary
questions never reopen an answered subject. A typed, due domain refresh may
ask a later confirmation, with at most one open question for that domain.

Answering through `human_answer` rewrites open to answered immediately and
enqueues a tool-enabled refresh. The `questions` audit row is authoritative.
A typed answer should check and write its named domain. A groom-authored
Project question may have no domain; the mediator classifies it among forced
candidates and should write at least one checked, domain-tagged concept.

The runtime does not retry a schema-valid answer forever when the model omits
that expected tagged write. It logs and stores a degraded-job diagnostic,
leaves write freshness unchanged, records any legitimate candidate checks,
and marks the durable question audit row curated so the sweep cannot promote
the same answer indefinitely. The deterministic project-knowledge eval still
fails missing answer routing from persisted memory and tool outcomes; soft
completion is queue protection only; it performs no quality pass.

Every refresh first promotes the oldest answered Project question whose
`curated_at` is null, rebuilding Q/A from the audit row and ignoring any
transient payload. Retry exhaustion, restart, or an older generation therefore
cannot lose human input: the sweep or `human_status` enqueues a generic
refresh, which reconstructs the answer pass, and success schedules the next
uncurated answer. A one-time migration marks historical answered Project rows
curated; later boots never repeat that backfill or mask newly failed work.

# Read boundary

Memory remains unavailable over MCP. Authenticated project members can read
concepts and a bounded activity projection through project-scoped dashboard
GET routes. The projection resolves recent writes to concept, task, and nearby
decision records; identifies `Convention` concepts and their `hold` or
`revise` enforcement decisions; and adds the same provenance to each concept
document. Raw `memory_log` entries are not returned. Existing membership 404
semantics remain the tenant boundary.

# Related

- [Mediator session model](mediator-sessions.md)
- [Architecture](architecture.md)
