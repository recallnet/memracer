# Dashboard: observability and project administration

Web view over the same database: live queue, mediator session transcripts, and narrow team/project administration.

# Surface

Read-only web app over the same database, updated via SSE (periodic keepalive
comments to survive proxies). The home is operator-first: **Needs you** and
**Project health** answer the two immediate questions, then **Activity** and
**Active agents** show live work. **Recent transitions** and **Queue** follow.
Each panel has one plain title.

The visual hierarchy is an operations instrument.
`src/dashboard/public/styles.css` and `src/dashboard/web/styles/theme.css`
carry the same ordered foundation token map. The unqualified light ground ramp
is `#f7f9fb` / `#ffffff` / `#f0f3f6` / `#e7ebef`. An unstamped root follows a
dark OS preference through a scoped
media query; explicit `data-theme="light"` or `data-theme="dark"` stamps win
over that preference. The existing dark ramp remains `#07080b` / `#0e1117` /
`#141922` / `#1b212c`. Both palettes retain enhanced status contrast plus AA muted and timestamp
text. `#0064c7` remains the light palette's interaction signal. Vite bundles
Space Grotesk at 400/500/600/700 and JetBrains Mono at 400/500/700 through
Fontsource, with no remote font request. Space Grotesk carries language,
including labels, navigation, actor
names, task titles, status pills, tables, timeline prose, and Knowledge
Markdown. JetBrains Mono is limited to identifiers, numeric readings, times,
paths, refs, hashes, and code. Status tokens own enhanced-contrast foreground
and ground pairs for incubating, queued/held, claimed/planned, executing,
blocked, parked, done, review/verify, and merged/accepted. Actor colors appear
only as thin identity borders. Compact controls keep stable
dimensions, roster rows reserve at most 128 pixels for actor identity and
clamp the task title to two lines, and the same restrained spacing grid holds
at desktop and 375-pixel mobile widths.

The application shell uses a persistent desktop sidebar and a 375-pixel drawer
over the same grouped Work and Project navigation. The active view remains URL
state; desktop collapse persists locally. Project switching, connection state,
the command palette, the visual key, and the signed-in account menu stay in the
shell. The account footer exposes settings, project switching, and sign-out.
Theme is a browser-local account preference exposed as a System / Light / Dark
radio group in that menu. `memracer.react.theme` stores the selection. Light
and Dark stamp the matching `data-theme` on the root; System removes the stamp
so the existing media query follows live OS changes. A synchronous script in
`src/dashboard/web/index.html` applies valid explicit values before the Vite
module and CSS load. The React shell and assistant transcript share that root
contract through `src/dashboard/public/styles.css`. The fixed PWA manifest and
browser-chrome `theme-color` remain outside the content-theme contract.

**Desktop notifications (Web Push).** Humans opt in from the account menu.
Enable never runs on bare page load: the control requests Notification
permission only after an explicit click, registers `/dashboard/sw.js`, and
POSTs the PushSubscription to `/api/push/subscribe` under the Better Auth
session. Server env: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, optional
`VAPID_SUBJECT` (mailto). The public key is exposed on `/api/config` and
`/api/push/status`. Delivery is best-effort via `web-push`; callers
`await scheduleProjectAttentionPush` (or `flushProjectAttentionPushes` after
an outer commit when the schedule was nested). Mid-transaction schedules defer
the push SQL off the ambient connection, so a failed best-effort
statement cannot abort the caller's Postgres transaction. 404/410 revokes the
subscription. Dedup is durable on `(endpoint, episode_id)` in
`push_delivery_log`. One canonical attention builder (`src/human-attention.ts`)
feeds `human_status.attention_alerts`, `GET /api/p/:project/attention`
(Needs you), and push fan-out (`src/push-dispatch.ts`). Attention sort ranks
kind severity first (`blocked` < `question` < `conversation` < `queue_alert` <
`lease`), then task id.

**Org-scoped navigation.** Memberships already carry `orgId` / `orgName`. The
shell groups Projects by Org. Users with more than one Org see an Organization
Select above Project; single-Org users see the Org as static context. The
Project selector lists only Projects in the active Org. Org is derived from the
selected Project so deep links `?project=` remain authoritative and set both
contexts. Last Project per Org is remembered in
`memracer.react.last-project-by-org` as a switcher hint only. The command
palette labels Projects as `Org · Project` and selecting one switches both.
Legacy memberships without an Org sit under **No organization**.

Operations, Knowledge, and Team each start with one compact page heading and
one view-specific primary action. The Recall brand moment is limited to the
small blue notch in the memracer wordmark.

Dashboard controls share nine primitives under
`src/dashboard/web/components/ui/`: Button, Badge/StatusBadge, query State,
Select, Table, Card/SidebarSection, Tooltip, counted Tabs, and
Avatar/IdentityChip. Queue, project, task-session, invite-role, API-key type,
and setup-client selectors all use the same combobox/listbox contract; no
dashboard JSX renders a native `select` or a `title` tooltip. Query-state
resolution is error first, then loading, empty, and ready, so a failed empty
queue cannot render both error and empty states. StatusBadge covers every task
lifecycle state. The four component dependencies remain pinned, while the
shipped wrappers stay local and narrow because the general-purpose Select
runtime alone exceeds the complete 15 KB gzip budget. Against the Phase 1
baseline, `app.js` plus `dashboard.css` adds 12,431 gzip bytes.

**Project health** is a compact four-reading rail benchmarked against GitHub
Pulse and repository Insights: open work, live coder leases, queued work ready
to claim, and work completed in the persisted activity window. Space Grotesk
carries the semantic labels and JetBrains Mono carries values and signed net
changes. Each label has a keyboard-focusable Tooltip explanation; the rail has
no selector, task identity mark, raw payload, or transport copy. The shared
Card shell keeps loading, empty, and error geometry stable and retains stale
last-good readings during a failed refresh. On mobile the rail is a two-by-two
grid at the top of **You**, before its attention and active-agent surfaces.

1. **Thread view**: the selected session as one chronological agentic-loop
   transcript. Human, mediator, and coder turns retain both actor and author in a
   visible header. Reasoning is a first-class part under a **Thinking**
   disclosure: open while running, collapsed after completion. Decisions are
   timestamp-interleaved callout rows. A task/thread fork is
   a cross-thread marker immediately before the affected turn; the marker says
   what arrived and how the downstream decision or action changed. Stable ids,
   not display timestamps, key every row. New SSE frames append without
   rebuilding the timeline. The viewport follows only when the reader is
   already at the bottom; reading above the bottom survives an append without
   a scroll jump. A **pin-to-live** toggle (default on) hops the selection to
   whichever thread most recently received a message; a manual click on any
   thread unpins and holds it.
2. **Live queue**: a compact operational list benchmarked against GitHub's
   pull-request list hierarchy. Every desktop row leads with the lifecycle
   `StatusBadge`, then a task title with id, created age, and evidence count;
   avatar/name ownership, `P0`-`P3` priority, and live lease or update timing
   occupy stable trailing columns. Owner roles are available through the
   shared Tooltip and consume no row width. Mobile renders the same
   fields as fixed, divider-separated rows. Task
   identity marks are excluded from both projections. State and agent filters
   remain URL query parameters for deep links, but are not duplicated as Queue
   chrome. Sort and direction controls live in the Queue heading, and sorting
   retains the existing URL values. Each desktop row and mobile projection has
   a visible **Open** control; the row itself is not an invisible click target.
   Completed tasks never enter this live projection, including through stale
   client data or a `state=DONE` URL. A **Completed** control opens a separate,
   lazy-loaded archive dialog. Its server query is project- and `DONE`-scoped,
   searches title, task id, and submitter with escaped literal matching, and
   pages by completion update time plus task id without loading the archive in
   memory. Selecting an archive row closes the archive and opens the existing
   task drill-in; closing the drill-in restores focus to the persistent archive
   trigger. The Project health completed reading remains independent of both
   queue projections.
3. **Task drill-in**: the queue's **Open** control opens the full brief (lease/agent
   info, evidence, attempts, questions, decisions) as an overlay over the
   thread view; Esc or "back" returns. The desktop drill-in follows the public
   GitHub pull-request structure: a compact title and outcome header, a wide
   record pane, and a persistent narrow metadata rail. Counted tabs expose
   Conversation, Specification, Evidence, Attempts, Questions, and Decisions;
   the groomed body, rationale, and approved plan remain directly selectable
   with no disclosure to open. Status, priority, submitter, lease
   actor, base SHA, relative lease expiry, and record-count jumps live in the
   metadata rail. On narrow screens the complete rail becomes a full-width
   two-column grid above the horizontally scrollable tab strip. Shared
   primitives own its actors, statuses, controls, cards, tabs, and error-first
   query states; task identity marks, native selectors, and raw preformatted
   dumps are not part of the surface. The title is clamped to two lines in the
   header, with the complete title available through the shared Tooltip.

   Lease recovery remains observable without a new dashboard projection. Once
   recovery grace ends and a claim sweep wins, the Attempts tab shows the
   `lease_expired` outcome and requeue note; browser coverage opens that tab
   and verifies the record.

The drill-in's image gallery is an independent, read-only projection. It gets
metadata only from `GET /api/p/:project/tasks/:task/images` and lazy-loads
bytes from the authenticated `GET /p/:project/images/:id` route. Image rows do
not enter the task-detail, queue, or status JSON. Captions supply alt text when
present; raster content is contained without horizontal overflow. Gallery
loading, empty, and unavailable-object states remain local to that section.
Uploads remain MCP-only. See [task image attachments](image-attachments.md).

Grooming rationales and decision rows render their persisted citations as
chips. Evidence chips scroll to and briefly mark the stable evidence row;
decision chips open the owning task and mark its decision row; task chips open
that task in the same overlay; PR chips open the recorded GitHub URL in a new
tab. Reduced-motion readers get an immediate mark without smooth scrolling or
animation. The task, decision feed, per-task timeline, and session stream all
return parsed citations, while the timeline also returns the task's ordered
evidence rows as typed events at task creation time. Conflict-conversation
decisions and warming timeline decisions show the same rationale and citation
chips as the task drill-in.

The desktop and mobile **ACTIVE** counters are buttons into the same live-lease
roster. A row exists only when a task is `CLAIMED`, `PLANNED`, or `EXECUTING`
and still names a lease agent with an unexpired lease. The compact roster is
benchmarked against GitHub's active-check and reviewer sidebars: Avatar and
visible actor name lead each row, the actor role is available through Tooltip,
StatusBadge carries lifecycle state, and a fixed-width monospace countdown
keeps the lease rail stable. A visible task button opens the drill-in and
restores focus by stable task id. The roster excludes task IdentityMark glyphs,
native selectors, raw data dumps, and transport copy. A failed refresh retains
last-good rows with a reconnect notice; first-load loading, error, and empty
states use the shared error-first query resolver. Mobile renders the same
roster only on **You**, after Project health and Needs you, while Feed excludes
it. Desktop and mobile clocks subscribe at one-second cadence only while their
respective roster is visible.

Incremental rendering is the contract: an SSE `changed` never rebuilds a pane
wholesale. Every render is a keyed diff-and-patch, so drill-in selection,
scroll positions, and expanded state survive updates (the "it resets and pulls
me out" root cause). The former standalone agents and decisions panes are gone
from the home; agent/lease info lives in the drill-in, and decisions read
inline in the thread view. The one-second lease clock is owned only by panels that
display time-sensitive values; `App` does not subscribe to it, so a clock tick
does not commit the timeline or the rest of the dashboard tree.

Transient transport and render failures stay local. Queue, active-agent,
thread, and question queries keep TanStack Query's last-good rows visible,
mark only their owning panel unavailable, and expose an in-place retry; a
first-load failure gets the same panel-local state and leaves the
operational body in place. Render boundaries are separate: Activity, task detail,
Knowledge, and Team expose a stable error digest and recover only when their
project/session/thread/task/concept reset key changes. The root boundary tells
the reader to reload. A render fault never presents a Retry button that would
re-render the same failing input.

Unhandled HTTP failures end at the Express terminal handler. Before response
headers it returns only `{error:"internal server error"}`; after an SSE stream
has started it closes the stream; no Express stack body reaches the client.

Both browser SSE paths reconnect without a reload. The Project `changed`
bridge and the selected session stream use cancellable exponential backoff from
one to 30 seconds with jitter, reset after an open, and discard timers from an
old Project or session. Reconnecting session streams retain rendered frames and
show an Activity status. A missing or unauthorized Project remains terminal;
`finish` or `[DONE]` remains terminal for a recorded session. The PWA manifest
is non-critical and is not part of application startup.

Session stream frames carry deterministic SSE ids. The server honors
`Last-Event-ID`, and the island sends the same checkpoint as a query parameter
when its explicit backoff creates a new `EventSource`; reconnects therefore
append only frames after the last delivered id. Session streams also emit the
configured proxy keepalive comment and clear that timer on close or finish.

Auth: the dashboard uses Better Auth browser sessions. Sign-in is an email-only
magic-link request at `/signin`; links are delivered by Resend, expire after
15 minutes, and are single-use. `/join` accepts an invitation only after the
magic link establishes a session for the exact invited email, then consumes the
invitation token once. GitHub OAuth remains available as a separate sign-in
provider; project membership still scopes visibility.

Better Auth `user`, `member`, and `apikey` timestamps are ISO-8601 text, unlike
the integer-millisecond operational tables. `src/dashboard.ts` converts those
values once at the API boundary with `toEpochMs`; Team roster `joinedAt` and MCP
seat `createdAt`/`lastUsedAt` therefore reach the browser as epoch milliseconds.
The Team and Settings projections format that shared numeric contract instead
of parsing database values in React.

The Knowledge view presents arbitrary concept-directory depth as an accessible
expandable tree. Concept bodies keep their source formatting, but canonical
markdown concept references become inline navigation only when the API's OKF
resolver includes that path in `links`. The resolver normalizes same-directory,
parent-relative, and bundle-root `/…` markdown hrefs against the source concept
before matching a stored path; an href that escapes the bundle or has no target
remains unresolved. The same normalized edges drive **Links to**, **Cited by**,
and general reciprocal-gap validation. Those existing-bundle consumers retain
compatibility for legacy bundle-root-relative links. Consolidation candidate
validation explicitly disables that compatibility mode: every generated
relationship must resolve under strict path semantics before apply. Broken
links remain plain text; the browser does not maintain a second resolution
algorithm.

Knowledge bodies and timeline verdict bodies render Markdown through
`react-markdown` with `remark-gfm`. The renderer builds React elements and does
not enable raw HTML. The Knowledge API pairs each rendered Markdown href with
the canonical concept path selected by the server resolver. The browser turns
only those exact pairs into concept buttons; it does not repeat relative-path
normalization. Unresolved `.md` links remain inert text, and external links open
in a new tab with `noopener noreferrer`. The dashboard client contains no
`dangerouslySetInnerHTML` Markdown path.

`KnowledgeBody` applies the server's pure `normalizeMemoryBody` helper before
Markdown rendering as a read-side fallback. A demonstrably double-encoded
legacy row or one leading YAML frontmatter block therefore renders its semantic
body (no leaked metadata, no run-on blob), while literal escape examples remain
unchanged. The write gate and startup repair remain authoritative; dashboard
normalization does not mutate stored data.

Malformed or non-array `memory_docs.tags` values read as `[]`. A document read
fetches that document directly, loads only path/title/body for link resolution,
and computes provenance against that one path and title without rebuilding
the project-wide Knowledge activity projection.

The command palette takes initial focus synchronously when its dialog commits.
Its trap includes the close control, search field, and result buttons; a fast
keyboard move cannot be overwritten by a deferred initial-focus callback.
Escape restores focus to the connected control that opened the palette.

The session stream is the timeline source. Every content frame carries event
id, sequence, parent, thread, task, actor, author, start/end time, and status.
The route interleaves `decision_log` entries and synthesizes cross-thread data
frames from parent edges before sending the normal incremental SSE vocabulary.
The React island keeps assistant-ui's ExternalStore runtime, but uses the
headless message primitives: kind dispatch precedes actor dispatch, data parts
render the non-bubble event rows, and grouped parts render reasoning. The
assistant-ui role remains `user`, `assistant`, or `system`; multi-actor identity
lives in custom metadata. Reasoning and tool parts use assistant-ui's required
`assistant` role even when their recorded actor is a coder. Ordinary coder and
human text remains `user`, and only an assistant-compatible final message can
carry `status: running`.

The Team view is a full-width access ledger benchmarked against GitHub's
organization and repository access management. Project members lead with the
shared Avatar, name and email; keyboard-focusable role badges explain Human,
Coder, and Admin authority. Role badges keep a fixed trailing inset on narrow
screens. The **Organization directory** remains collapsed until needed.
Invitation, API-key seat, Project/Org creation, and destructive controls occupy
separate action bands, with no nested cards. Copy actions report completion,
one-time secrets remain explicit, and revoke/delete paths require confirmation
while preserving keyboard focus. Team, Org roster, invitation, key, and setup
queries resolve error before loading, empty, and ready; failed refreshes retain
last-good rows and mark only their owning section unavailable. Mobile stacks
the same ledger and labels every API-key table value without horizontal
overflow.

The Team view also manages the signed-in member's Project-scoped MCP seats.
Its ledger combines OAuth and static methods, labels the method, and supports
rename and revoke for either. Interactive OAuth seat creation happens on the
compact consent page, where the signed-in user selects one Project, human or
coder role, and a bounded display name without pasting a key. Human
tokens are created with text clarification delivery; the dashboard has no
clarification-mode checkbox or per-key mode selector. The legacy server toggle
remains available until its separate protocol retirement. Token ownership and
project metadata are checked on every update; plaintext secrets remain
creation-only. A create request without a useful name receives a distinct,
human-readable seat name. The list returns that name, type, creation time,
display-safe key prefix, and a nullable last-used time. Successful Better Auth
API-key verification updates `apikey.lastRequest`; the list exposes that value
as `lastUsedAt`, while a key with no successful request renders **Never**. The
create panel explains the human and coder roles and holds the plaintext secret
only in a dismissible, one-time reveal. Pending setup-config and invite-list
queries have local loading and error states with explicit Retry controls; a
failed setup-config query never renders or copies a fabricated snippet.
Loading and empty API-key states sit outside the seats table. A populated table
owns explicit row groups, and every row owns only cells; the revoke confirmation
is a sibling alert dialog, kept outside the ARIA table.

The same view names its scopes explicitly: **Org** contains **Projects**, and
each selected Project has a **Team**. The selected Project roster is the
primary people surface; the deduplicated Org directory is a collapsed
disclosure inside it. People rows list humans only; coder seats are
excluded. The Org roster deduplicates the API's flat Project memberships
by user and does not display per-Project role suffixes. The selected Team omits
the ordinary human suffix and shows only a small admin marker where Project
deletion rights matter. Its invite role selector uses the literal `human`, `coder`, and
`admin` values and defaults to `human`. Invite controls, project creation, and
the danger zone render only for the Project creator or an explicitly promoted
admin. Server routes enforce the same boundary; hiding a control is never the
authorization check. Coder seats remain in the token panel. `GET /api/orgs/:org/roster`
returns the Org identity and flat membership rows only after `isOrgMember`
authorization. A roster error has its own retry state and does not remove the
selected Team's invite or token controls. Project switches clear both roster
data and its pending state before fetching the next Org.

Team and project creation accepts duplicate display names. The API returns an
exact-name `duplicateName` flag and a plain warning after the new row has been
atomically assigned its own suffixed id. Onboarding carries an organization
warning into its project step; after project creation the switcher announces
the warning in an accessible live status without undoing or blocking the
create. Editing, beginning another create, backing out, or cancelling clears
the notice.

Project creation has two adjacent paths. The existing name plus optional
free-text repository form is unchanged. The GitHub path first links the signed-
in Better Auth identity, installs the configured GitHub App for all repositories
or only selected repositories, then offers only repositories returned for that
verified installation. It appears in first-Project onboarding and the admin
Projects and Orgs section. Onboarding keeps the newly created Org in session
storage across GitHub redirects and clears it after Project creation or backing
out. Loading, unavailable, unlinked, installed-with-no-repositories, and API
error states stay local to the GitHub section. The connected state names
whether all or selected access is active. The chosen repository still creates
the ordinary Project and creator admin membership.

The Team view exposes GitHub connection state before the creation controls.
Every Project member can see whether deployment configuration, account linking,
or App installation is missing, and each incomplete state names its next action.
Missing deployment configuration names the three required
`MEMRACER_GITHUB_*` variables and the GitHub App guide; query failures keep a
local Retry control. A connected installation names the GitHub account and its
all/selected access scope; selected installations also show the repository
count. The selected Project's valid `owner/repo` value is
an external `github.com` link; missing or malformed free-text metadata remains
plain status text and never becomes an href. The band uses the shared Badge,
Button, query-state, spacing, and theme contracts at desktop and mobile widths.

Project creators and explicit admins also see a distinct danger zone. Deletion
opens an accessible modal, requires typing the exact project name, and remains disabled until it
matches. Escape closes the modal and restores trigger focus; the layout becomes
a bottom sheet on narrow screens. After deletion the dashboard refreshes the
identity's memberships and selects a surviving sibling, or returns a user with
no projects to onboarding. The same recovery runs when another admin deletes
the active project: the final SSE `changed` refetch receives a scoped 404,
refreshes memberships, and leaves the stale stream. It paints no
generic load error and does not retry forever. A project id that was never one of the
identity's memberships is different: its scoped 404 remains a terminal error
surface, the live indicator says unavailable, and EventSource does not
reconnect or fall through to a remembered tenant.

# Activity transcript

The React feed and task sheet mount `TimelineIsland` with a controlled
selection. The selection keeps the visible `threadId` separate from the stream
`sessionId`: child threads use `root_id ?? id` for the session stream while the
URL retains the selected child thread. Feed clicks, `?thread=`, and `?task=`
therefore drive the same component and full root recording without a
window-event bridge race. Task-detail thread rows include `root_id` for this
normalization.

Fork context comes from one membership-scoped
`GET /api/p/:project/sessions/:session/siblings?thread=:thread` request. The
server compares each candidate thread's own first event parent; it does not
infer siblings from the shared session's first event.

The Activity navigator is a bounded projection; the session recording remains
the source. It
groups recorded cycles into one row per task or taskless root session, chooses
the newest cycle as the representative, sorts by last activity, and displays
at most 24 recent groups. Taskless groups with no human-originated message are
internal mediator churn and stay out of the navigator. Each grouped row shows
its session count. The complete thread collection remains available to URL
selection, command navigation, and `TimelineIsland`, so an older deep link
still opens its full root recording even when that cycle is not a visible row.
Task identity is inferred from every member of a group. Task-backed rows and headings therefore use `#id — title` even
when the latest cycle has no direct task id. Unattributed rows say **Project
activity**; raw thread ids are not display copy.

`GET /api/p/:project/threads` includes the task's current lifecycle state and
the newest message's actor and role. Activity uses those facts directly:
task-backed navigator rows and the selected-thread heading carry
`StatusBadge`, while `ActorLabel` renders an Avatar plus the recorded name and
keeps the role in a Tooltip. The desktop surface follows the GitHub pull-request
conversation pattern with a continuous event rail, quiet bordered message
cards, and compact actor/time headers. Mobile keeps the navigator as a short
horizontal strip above the same timeline. It preserves room below the
scrolling transcript for the sticky view navigation and does not create page
horizontal overflow. Tool fallbacks use labelled, wrapping code fields; raw `pre` dumps are
gone. Cross-thread impact text renders as GFM with no visible Markdown
punctuation.

The session island renders one chronological transcript. Recorded stream frames
still carry stable ids and parent metadata for server-side projections and
telemetry tests, while the client preserves the assistant-ui ExternalStore, role
mapping, Thinking, decision and fork disclosures, bottom pin, reconnect
behavior, and incremental frame append semantics. Repeated delta chunks with
one stream id accumulate while an identical reconnect replay replaces its
prior frame; frame-specific message ids remain unique. The removed causal graph
does not add a second client projection, scrubber, legend, SVG surface, or
Visx dependency to Activity or task Conversation.

`src/dashboard/replay-crossings.ts` reverse-scans each thread/task scope to
index the next mediator and verdict, then groups crossings by affected event.
The stream emitter performs no per-event `find` or `filter` scan. It flushes
headers after ownership validation and before loading or projecting a
recording.

# OpenTelemetry GenAI alignment

`projectGenAiLifecycles` is a mapping boundary. It creates no
SDK objects and exports nothing. The projection follows the
[OpenTelemetry GenAI semantic conventions source](https://github.com/open-telemetry/semantic-conventions-genai)
on its `main` branch:

| Recorded field | OTel projection |
|---|---|
| session id | `gen_ai.conversation.id` |
| mediator/coder execution lifecycle | `gen_ai.operation.name=invoke_agent`; `gen_ai.agent.name` only when the executor is known |
| folded `tool_call` + `tool_result` lifecycle | `gen_ai.operation.name=execute_tool` |
| parsed `tool`, then fallback `action` | `gen_ai.tool.name`; span name `execute_tool {gen_ai.tool.name}` |
| tool-call event id / result parent | shared `gen_ai.tool.call.id` |
| `parent_id` | projected parent event id |
| event phase, thread, task, actor, type | content-free lifecycle events and `memracer.*` extension attributes |

Rows are phases/events inside conceptual lifecycles, never one span per row.
Human/system/request rows attach as inputs to the next known agent invocation;
if no executor has appeared yet they remain honest unassigned inputs. A tool
call and its child result fold into one lifecycle keyed by
`correlationKey=tool:<call-id>` and `gen_ai.tool.call.id`. The mapper emits no
`gen_ai.agent.id`, provider, or model because the recording does not hold a
stable agent identity or provider/model facts. It also omits message content
and deprecated prompt/completion attributes.

# URL state

Primary selections use one canonical query schema:
`?project=<id>&view=<dashboard|team|knowledge|settings>&task=<id>&thread=<id>&concept=<path>&state=<task-state>&agent=<lease-agent>`.
`src/dashboard/web/lib/url-state.ts` is the sole parser, serializer, and
History API writer. Focused unit tests freeze normalization, parameter order,
encoding, and push/replace/no-op behavior. Real selections call `pushState`; initial
canonicalization calls `replaceState`; one `popstate` handler restores without
a reload.

Restore order is project first, then project-scoped task, manual thread, or
knowledge concept. A URL project overrides `localStorage`, which remains only
the fallback when the URL omits project. This prevents a shared task id from
being fetched through the recipient's remembered tenant. Unknown or unowned
project ids stay in scope and hit the existing membership-protected endpoints;
they never fall through to another project.

The dashboard filter rail exposes Project, task state, and lease agent. State
and agent share one predicate across the queue table, mobile queue cards,
warming cards, and task-backed thread rows. The command palette reads the
already-loaded views, Projects, tasks, and threads; it issues no write request.
Desktop view targets are Operations, Team analytics, Knowledge, and Settings;
mobile targets are Feed, Queue, You, Knowledge, Team analytics, and Settings
through the existing tab path. Team analytics and Settings are separate
project-scoped surfaces so read-only contribution telemetry never shares a
mutation form with access administration.
Its canonical task collection deduplicates the queue and warming projections.
Arrow keys move focus across queue and thread targets. Space opens a transient,
URL-neutral task peek from queue targets and task-backed threads; pointer and
Enter retain normal navigation, and taskless threads never fabricate a task
request. Peek close restores its stable keyed target and exact surface scroll
position. One shared intent generation prevents slower task or warming
responses from replacing a newer overlay, palette, or Project selection.
ACTIVE, task, warming, and palette overlays are singletons. Cmd/Ctrl-K does not
intercept editable fields or the assistant transcript, and mobile thread
targets move to Feed before selection.

Shareable state otherwise stops at primary navigation. DONE-band folding,
knowledge folder expansion, feed/queue/you mobile tab position, and transient
knowledge search remain session/local preferences and do not enter the URL.
On a mobile viewport, a saved Knowledge or Team tab replaces a stale
`view=dashboard` route with that canonical top-level view; saved You, Feed, and
Queue tabs stay on the dashboard route.

Queue ordering adds `sort=<priority|updated|created|title|state>` and
`direction=<asc|desc>` after the original parameters. Omitting both preserves
the pre-sorting parser, serializer, href, and history bytes. Desktop table rows and
mobile cards consume the same TanStack row model, so one URL predicate and sort
order controls both layouts.

# React dashboard

The canonical source is the Vite 8/React application under
`src/dashboard/web`. The build emits deterministic `app.js` and
`dashboard.css` under gitignored `src/dashboard/web-dist`, then serves that
bundle at `/dashboard/`.
`/dashboard/next` returns 404 even if an old staging directory is present.
Builds copy `web-dist` and the retained support files in `public` into
`dist/dashboard`. Those support files are sign-in, invite-join, shared styles,
manifest, icons, the MCP setup module, and role contracts. The pre-React
homepage, controller, URL module, and standalone island output are deleted.

Focused contracts freeze the existing behavior: the typed URL module is
tested directly; typed DTOs and query keys wrap
the existing GET routes; the project SSE bridge keeps the 300 ms `changed`
debounce, version reload, stale-project cleanup, and 1-to-30-second reconnect
backoff even when its project probe fails. Selecting another Project resets
that backoff to one second; the old Project's delay does not carry over. A theme adapter maps
shadcn semantics onto the shared terminal tokens. Pure `taskIdentity` and
`agentIdentity` projections give every known identity a stable key and
geometry across queue, raceway, roster, and timeline surfaces. Human is a
circle, mediator a hexagon, coder a chevron, task a diamond, and unknown a
square. All identity marks use one desaturated token, separate from the saturated
blue, green, amber, and red task-state palette. A global visual key decodes
every shape and state group. Feed, queue, active-roster, task-detail, and timeline
rows pair the mark with a visible actor role and readable name. The feed list
uses a role-level projection from thread kind because its DTO has no author;
recorded timeline rows retain their persisted actor and author.

Verified API-key ids remain the lease authority in queue storage. One batched
projection maps matching lease owners, active-roster agents, attempt agents,
and question askers to `{user}-{token}` for dashboard, MCP brief, and
`human_status` responses. It requires the key's canonical metadata to match
the actor's Project. Mediator, human, legacy, malformed, unmatched, and
cross-Project identifiers pass through unchanged; the browser receives neither
key inventory nor matching logic. MCP task-brief responses use the same
projection.

Needs you treats questions as pending, unavailable, or ready. Only a successful
empty questions response can render the crafted zero-attention message;
loading and error states keep known task attention visible without claiming a
numeric total for unknown questions. The panel is one ranked record list:
blocked tasks first, task questions, project questions, then leases expiring
within five minutes. `HELD` is a deliberate park and requests no human
action, so it contributes no row, chip, or item count. A task appearing in more than one condition keeps
its highest-ranked row, with an owning question retained as that row's primary
copy. Task rows open the existing detail sheet and use its stable focus-return
contract. Project questions do not invent a task destination.

The list renders five records by default and caps its internal scroll region at
the smaller of 40vh or six 64-pixel rows. An `N more` sixth control expands the
remaining ranked records inside the same bound. StatusBadge distinguishes each
condition; Avatar/IdentityChip provides a visible actor name and Tooltip role.
Each task context begins with the task id and kind, and every reason uses the
same two-line clamp. Keyboard focus or pointer hover exposes the complete reason through the
shared Tooltip without changing the row's task-detail destination.
As defense in depth, only open, question-shaped rows enter the projection even
though the API retains answered rows for other consumers. Answered rows and
resolution statements stay in task/session history and out of the attention inbox.

The staged work built the operational home and lifecycle signal raceway, then
moved task detail, transcript, Knowledge, Team, onboarding, administration,
command, and mobile parity. Matched authenticated visual acceptance preceded
the atomic static-entry switch. Sign-in and invite-join remain static.

The React home reads queue and live-roster snapshots through project-rooted
TanStack Query keys. A project SSE `changed` invalidates that one root through
the PR 1 bridge. Counts are current snapshot values. SQLite and Postgres
triggers append every real state change to `task_transitions`; the queue read
returns the latest ten transitions and net open, active-state, ready, and done
movement over the last seven days. Trends use plain signed meaning: `N more`,
`N fewer`, or `no change`. Needs you projects individual open questions, blocked
tasks, and short leases in ranked user-facing rows. The browser clock removes
rows from the active count and roster when `lease_expires_at <= now` without
waiting for SSE. The Queue defaults to the explicit actionable set `QUEUED`,
`CLAIMED`, `PLANNED`, `EXECUTING`, and `BLOCKED`. Its heading reports that
actionable count. A local **View all N** control reveals every state and changes
the heading to `N shown`; **Show actionable** restores the default without
changing the deep-link filters.
Priority ascending is the default order. The lease-agent selector appears only
when `/agents` reports more than one distinct live agent, while an existing
agent URL predicate remains effective even when that control is hidden. Queue
agent options union every queue `lease_agent`, the `/agents` projection, and
the current URL value, so expired owners and absent deep links remain
selectable when the control is available. Filters belong to Queue and do not
appear on Activity. The retired verification state and GitHub-degraded flag do
not appear in dashboard DTOs, filters, labels, or status banners. `/agents`
remains the source for active agent rows, current lease count, and countdown
deadlines.

Activity and command search never render a serialized thread message. The
thread-list route returns the task title, persisted summary, and first
human-authored message with its bounded first/last previews. The client maps a
mediator `action` or `verdict` to a plain verb plus task id and short title.
Unknown or malformed payloads fall back to first human text from the thread or
its root, then a plain persisted summary, then a neutral activity label.
Fallbacks that look like JSON are discarded.

PR 3 moved the remaining interactive paths into React before the canonical
entry switched. Every desktop Queue row and mobile Queue card opens task detail
with a pointer, Enter, or Space; the activation pushes `task` URL state so
browser Back closes the detail. A Radix dialog sheet owns that state and
restores focus to a stable `data-task-trigger` after Escape. Native table-row
and article semantics remain intact. Each row or card contains exactly one
native button stretched across its full visual target, while task identity
inside it is presentational. TanStack rows use the task id as their stable key. After an SSE reorder, close validates that its saved
trigger is still connected, visible, and belongs to the closing task; otherwise
it resolves the visible trigger with that exact task id. The sheet leads
with title, one-line Outcome or Goal, current state, and owner. The groomed
body, rationale, approved plan, and evidence live under a native
**Implementation detail** disclosure that is closed by default. Attempts,
questions, decisions, and session context remain visible. Evidence citations
open the disclosure before scrolling and marking their target. Missing task
ids stay in the requested Project and render a scoped not-found state. Reduced
motion removes smooth scrolling. The sheet mounts the existing
`TimelineIsland` implementation from `src/dashboard/island/index.tsx`, so the
assistant-ui ExternalStore identity, frame update keys, finish semantics, and
bottom pinning remain one implementation.

The Knowledge left pane derives an expandable folder tree from concept paths.
Pinned Headless Tree primitives own `tree`/`treeitem` semantics, focus,
selection, arrows, Home/End, and letter-key search. Top-level folders start
expanded; nested folders retain explicit expansion state. A deep concept from
the `concept` URL expands every ancestor, and project-memory refreshes reconcile
the current expansion set in place. The visible search input
uses the same search feature and filters to matching concepts plus their folder
ancestry. A concept primary action updates the existing URL state and reader
query; the phone Back control clears that state and restores focus to the same
tree row. Following a document link outside the current tree search clears the
incompatible search first, so that row is mounted for focus restoration. No
backend projection changes for the tree.

Knowledge, Team analytics, Settings, Org roster, invitations, API-key seats,
Project and Org creation, exact-name deletion, onboarding, command search, and
mobile navigation now run at `/dashboard/`. Project and Org creation is
admin-gated and lives in the Project switcher popover; Settings intentionally
contains no creation forms. Mutations use the existing routes
and payloads; the operational home remains GET-only. A final scoped 404 for a
Project previously present in the identity's memberships refreshes the list
and selects a surviving sibling. An unknown deep-linked Project remains a
terminal unavailable surface.

The shared `public/mcp-snippet.js` remains the only MCP setup builder. A React
one-time key reveal selects every supported client and exposes both the complete
configuration and role-specific agent instructions. Human keys use text
clarification delivery without exposing the server's legacy mode toggle.
Project navigation unmounts each project scope so key and invite reveals cannot
cross Projects, and revocation requires a second explicit confirmation. People
invites offer member or admin; coders are provisioned as API-key seats. Command search
covers loaded views, Projects, tasks, and threads with arrow-key movement and
focus restoration. Mobile preserves six local tabs: You, Activity, Queue,
Knowledge, Team analytics, and Settings. A fresh mobile session opens You; a
saved valid tab still wins on return.

Operations has one visually hidden h1; its visible panel headings remain h2,
and Visual Key groups are h3. Interactive rows retain names from their visible
content, with an untitled fallback for empty server text. The custom command
palette traps Tab across its close button, search field, and results, then
restores its trigger on Escape.

The shared muted and destructive color tokens meet AA contrast on secondary
panels, selected Activity rows, uppercase micro-labels, and danger controls.
The authenticated Chromium suite runs axe across Operations, task detail,
Knowledge, command search, Team analytics, and Settings. It rejects serious or critical violations
plus missing h1, heading-order, naming, and ARIA-state failures; it also checks
visible focus, Headless Tree arrow navigation, and dialog focus return.

## Team analytics and Settings

`GET /api/p/:project/analytics?period=24h|7d|30d|all` is the read-only,
membership-scoped analytics contract; the Team view defaults to `7d`. The
server computes five headline tiles (contributions, tasks shipped, active
people, Frigg jobs, and Frigg spend), a fixed-order steer/create/complete/answer
contribution leaderboard with one shared proportional scale, and Frigg
routing/scorecard panels from `tasks`, `attempts`, `member`/`user`, seats,
`job_policy_log`, and `mediator_usage`. Synthetic actors are excluded. For
bounded periods the headline includes signed deltas against the equivalent
previous window; `all` has no prior-window delta. A
duplicate member display name is retained as an explicit collision marker;
historical revoked or unresolved coder ids stay visible with safe former-agent
labels; no secret is exposed and the page does not fail.

Contributor attribution resolves the stable `user.id` in `tasks.submitted_by`
before falling back to a unique case- and whitespace-normalized display name.
Ambiguous names are never guessed. A completed task credits the latest
completed attempt's project seat owner when that owner is a current member, then
falls back to the resolved submitter; unresolved historical actors remain in
the safe coder-seat projection and stay counted in totals.

Human thread messages count as steer contributions and answered questions count
as answer contributions. Each member can expand a row to see the same stacked
breakdown by coder seat. Routing bars show provider share and average latency in
seconds, while scorecard bars share one completion scale and reserve a red
segment for failed jobs; these are read-only projections over existing rows and
do not add an analytics write path.

The Team analytics view has no write controls. Settings owns Access,
Integrations, Seats, and the admin-only Danger zone; project creation remains
in the switcher and is admin-gated. The existing GitHub link/install,
invitation, seat, deletion, and membership authorization boundaries are
unchanged.

Question answers now persist the human attribution in `questions.answered_by`
and project questions, task briefs, the question API, and task timelines retain
that field. The value is a trimmed answerer label with an `unknown human`
fallback, while `submitted_by` remains the original task submitter contract.

# Active knowledge

Knowledge opens on an activity workspace.
`GET /api/p/:project/knowledge/activity` returns up to eight recent OKF writes,
all current `Convention` concepts with their latest `hold` or `revise`
enforcement, and up to eight decisions linked to affected concepts. Each row
uses concept and task titles; raw log payloads and database labels stay hidden.
Concept controls update the existing `concept` URL state; task controls open
the existing detail sheet. The concept document route returns matching
decision and task provenance under **Related work**, completing the reverse
path.
The browser presents this projection as a compact repository explorer and
Markdown reader: one searchable file rail, a persistent path breadcrumb,
document type and update metadata, and locally scrolling code and tables.
List, activity, and document queries resolve error before loading, empty, and
ready states.

The projection reads only the requested Project. Modern write/update entries
carry an exact concept path and task id. Historical `curated@<decision>` rows
resolve through that explicit decision and a referenced concept; other task
correlation is accepted only within a 30-minute decision window. Desktop keeps
the concept index and activity side by side. Mobile stacks the index and
activity, then hides the index only while reading a selected concept. The
reader contains no raw record dump or server implementation labels; it retains
semantic Markdown, inert unresolved concept links, and hardened external links.

# Implementation status

`src/dashboard.ts` serves the generated React entry at `/dashboard` and keeps
the existing scoped APIs, auth pages, SSE ordering, and membership boundaries.
The normal build runs the dashboard typecheck and deterministic Vite build,
smokes the canonical static mount and 404 staging path, then copies the React
bundle and retained support assets into `dist/dashboard`. The static smoke
fully consumes every fetched body before closing its temporary server. This is
part of the build contract: leaving a large asset unread can backpressure the
server response and make `server.close()` wait indefinitely.

Authenticated Chromium acceptance covers desktop and mobile operations, task
detail and transcript-only Conversation, Knowledge, Team administration, API-key reveal and
revoke, invites, SSE queue refresh without navigation, exact-name deletion and
surviving-Project recovery, keyboard focus, and automated WCAG auditing.
Matched candidate screenshots are captured at 1440×1000 and 390×844. The
unreachable pre-React homepage/controller assets and their separate build were
removed without changing the retained auth, PWA, MCP setup, role-contract, or
integrated timeline paths.

# Related

- [Architecture](architecture.md)
- [Task image attachments](image-attachments.md)
- [Mediator sessions](mediator-sessions.md)
