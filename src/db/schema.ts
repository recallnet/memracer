import type { Dialect } from "./driver.js";

// Shared between CREATE IF NOT EXISTS and the SQLite CHECK-widening rebuild —
// one definition, no drift.
export const JOBS_COLUMNS = `
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  kind       TEXT NOT NULL CHECK (kind IN ('groom','review','answer','curate','discuss','reconcile','catchup','seal','enhance','conciliate','consolidate','refresh')),
  payload    TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
  attempts   INTEGER NOT NULL DEFAULT 0,
  result     TEXT,
  error      TEXT,
  started_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  coalesce_key TEXT
`;

// Shared between CREATE IF NOT EXISTS and the SQLite CHECK-widening rebuild —
// one definition, no drift.
export const DECISION_COLUMNS = `
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id    INTEGER REFERENCES tasks(id),
  kind       TEXT NOT NULL CHECK (kind IN ('create','merge','clarify','priority','approve','revise','answer','escalate','close','update','hold','reopen')),
  summary    TEXT NOT NULL,
  rationale  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  citations  TEXT NOT NULL DEFAULT '[]'
`;

// Shared between CREATE IF NOT EXISTS and the SQLite CHECK-widening rebuild —
// one definition, no drift.
export const EVIDENCE_COLUMNS = `
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id   INTEGER NOT NULL REFERENCES tasks(id),
  kind      TEXT NOT NULL CHECK (kind IN ('code','stacktrace','log','link','research','image')),
  path      TEXT,
  lines     TEXT,
  snippet   TEXT,
  note      TEXT,
  blob_ref  TEXT,
  mime_type TEXT,
  caption   TEXT,
  CONSTRAINT evidence_image_metadata_check CHECK (
    (kind = 'image' AND blob_ref IS NOT NULL AND mime_type IS NOT NULL
      AND path IS NULL AND lines IS NULL AND snippet IS NULL AND note IS NULL)
    OR
    (kind <> 'image' AND blob_ref IS NULL AND mime_type IS NULL AND caption IS NULL)
  )
`;

/** The evidence column names, in EVIDENCE_COLUMNS order, for named rebuilds. */
export const EVIDENCE_COLUMN_NAMES = [
  "id", "task_id", "kind", "path", "lines", "snippet", "note", "blob_ref", "mime_type", "caption",
] as const;

// Shared between CREATE IF NOT EXISTS and the SQLite CHECK-widening rebuild —
// one definition, no drift.
export const ATTEMPTS_COLUMNS = `
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES tasks(id),
  agent      TEXT NOT NULL,
  outcome    TEXT NOT NULL CHECK (outcome IN ('lease_expired','completed','blocked','plan_window_expired','released','awaiting_merge')),
  notes      TEXT,
  created_at INTEGER NOT NULL
`;

// Shared between CREATE IF NOT EXISTS and the SQLite CHECK-widening rebuild —
// one definition, no drift. root_id and summary stay LAST so the rebuild's
// INSERT..SELECT * lines up with old tables extended via ensureColumns.
export const THREADS_COLUMNS = `
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  kind       TEXT NOT NULL CHECK (kind IN ('groom','review','answer','discuss','submission')),
  task_id    INTEGER REFERENCES tasks(id),
  created_at INTEGER NOT NULL,
  root_id    INTEGER REFERENCES threads(id),
  summary    TEXT
`;

// Shared between fresh schema creation and the SQLite CHECK-widening rebuild.
// GitHub App installations may be scoped to selected repositories or to every
// repository visible to the installation's account.
export const GITHUB_INSTALLATIONS_COLUMNS = `
  installation_id     TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL UNIQUE REFERENCES orgs(id) ON DELETE CASCADE,
  account_id          TEXT NOT NULL,
  account_login       TEXT NOT NULL,
  connected_by        TEXT NOT NULL,
  repository_selection TEXT NOT NULL CHECK (repository_selection IN ('selected','all')),
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
`;

// Project-scoped questions have no task. Shared between fresh schema creation
// and the SQLite NOT NULL migration rebuild.
export const QUESTIONS_COLUMNS = `
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id    INTEGER REFERENCES tasks(id),
  asked_by   TEXT NOT NULL,
  question   TEXT NOT NULL,
  answer     TEXT,
  answered_by TEXT,
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered')),
  created_at INTEGER NOT NULL,
  domain     TEXT,
  refresh_trigger TEXT,
  answered_at INTEGER,
  curated_at INTEGER
`;

// Durable identity-keyed interrogation (task #420). Survives disconnects; the
// party re-attaches by id. current_prompt is the open question for
// awaiting_identity (the party, or an escalated person).
export const NEGOTIATIONS_COLUMNS = `
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id),
  subject_kind      TEXT NOT NULL CHECK (subject_kind IN ('submission','coder_plan')),
  subject_task_id   INTEGER NOT NULL REFERENCES tasks(id),
  party_identity    TEXT NOT NULL,
  party_role        TEXT NOT NULL CHECK (party_role IN ('human','coder')),
  state             TEXT NOT NULL CHECK (state IN ('open','awaiting_party','awaiting_person','accepted','declined','cancelled')),
  current_prompt    TEXT,
  awaiting_identity TEXT,
  transcript        TEXT NOT NULL DEFAULT '[]',
  -- Durable link to the questions ledger row for this open prompt (#473).
  -- Nullable so pre-link rows keep working; reconnect close prefers this over text match.
  question_id       INTEGER REFERENCES questions(id),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
`;

// One ordered, typed, parent-linked event stream per mediator session
// (Vercel AI-SDK UI Message Stream shape). session_id anchors to the owning
// root submission thread — every job across a submission's lineage appends
// here, so a groom-with-clarification reads back as ONE stream. parent_id is
// a self-reference: a forked child task's first event points at the parent
// task's last event, so branches are reconstructable. seq is a per-session
// monotonic ordinal; start_time/end_time are real, strictly-increasing
// millisecond clocks (the recorder never lets two events share a tick).
// Additive table — new since the split, so CREATE IF NOT EXISTS covers both
// dialects and no CHECK-widening rebuild of the legacy tables is needed.
export const SESSION_EVENTS_COLUMNS = `
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  session_id INTEGER NOT NULL REFERENCES threads(id),
  parent_id  INTEGER REFERENCES session_events(id),
  thread_id  INTEGER REFERENCES threads(id),
  task_id    INTEGER REFERENCES tasks(id),
  seq        INTEGER NOT NULL,
  type       TEXT NOT NULL CHECK (type IN
             ('request','reasoning','tool_call','tool_result','clarification_q','clarification_a','verdict','text')),
  role       TEXT NOT NULL CHECK (role IN ('human','coder','mediator','system')),
  author     TEXT NOT NULL,
  content    TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','error','pending')),
  start_time INTEGER NOT NULL,
  end_time   INTEGER
`;

// Shared between CREATE IF NOT EXISTS and the SQLite state-CHECK-widening
// rebuild (migrateTasksStateCheck) — one definition, no drift. The rebuild
// copies rows by explicit column name (not SELECT *), so column order here is
// free of the append-order constraint that binds the *_COLUMNS tables above;
// this const only has to match the widened CHECK.
export const TASKS_COLUMNS = `
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id       TEXT NOT NULL REFERENCES projects(id),
  title            TEXT NOT NULL,
  body             TEXT NOT NULL,
  priority         INTEGER NOT NULL DEFAULT 2,
  state            TEXT NOT NULL DEFAULT 'QUEUED'
                   CHECK (state IN ('INCUBATING','QUEUED','CLAIMED','PLANNED','EXECUTING','AWAITING_MERGE','DONE','BLOCKED','PARKED','HELD')),
  base_sha         TEXT,
  repo             TEXT,
  submitted_by     TEXT NOT NULL,
  watermark        TEXT,
  lease_agent      TEXT,
  lease_expires_at INTEGER,
  lease_ttl_ms     INTEGER NOT NULL DEFAULT 1800000,
  result_summary   TEXT,
  result_pr_url    TEXT,
  result_pr_number INTEGER,
  result_pr_description TEXT,
  pr_verification  TEXT,
  pr_verification_etag TEXT,
  -- First consecutive merge-probe failure (rate-limit/5xx/network). Null when
  -- healthy. After MERGE_PROBE_TRANSIENT_BUDGET_MS, escalate to Needs-You.
  merge_probe_transient_since INTEGER,
  grooming_rationale TEXT,
  parent_id          INTEGER REFERENCES tasks(id),
  plan             TEXT,
  plan_deadline    INTEGER,
  plan_approved_at INTEGER,
  incubate_until   INTEGER,
  block_kind       TEXT,
  block_requeue_at INTEGER,
  hold_cause       TEXT CHECK (hold_cause IN ('conflict','question','dependency','explicit')),
  queued_at        INTEGER,
  queue_generation INTEGER NOT NULL DEFAULT 0,
  root_thread_id   INTEGER,
  -- CI-fix open-child dedup key (nullable). Partial unique index enforces at
  -- most one non-DONE child per (parent_id, ci_fix_key). Non-CI-fix rows stay NULL.
  ci_fix_key       TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
`;

/** The tasks column names, in TASKS_COLUMNS order — the rebuild's named copy list. */
export const TASKS_COLUMN_NAMES = [
  "id", "project_id", "title", "body", "priority", "state", "base_sha", "repo",
  "submitted_by", "watermark", "lease_agent", "lease_expires_at", "lease_ttl_ms", "result_summary",
  "result_pr_url", "result_pr_number", "result_pr_description", "pr_verification",
  "pr_verification_etag", "merge_probe_transient_since", "grooming_rationale", "parent_id", "plan", "plan_deadline",
  "plan_approved_at", "incubate_until", "block_kind", "block_requeue_at", "hold_cause", "queued_at", "queue_generation", "root_thread_id", "ci_fix_key", "created_at", "updated_at",
] as const;

// Written once in SQLite's dialect; renderSchema() derives the Postgres form.
// tasks.root_thread_id carries no inline REFERENCES: tasks and threads
// reference each other, and Postgres rejects a forward reference at CREATE
// time (SQLite defers FK resolution to write time). The constraint is added
// after both tables exist — see the per-dialect tails below.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS orgs (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  -- The better-auth user who created the team. There is no org-level
  -- membership table, so this is the durable "who owns this team" record;
  -- the creator of each project inside it gets an admin member row (roles
  -- stack: admin implies human wherever roles are read).
  created_by TEXT,
  created_at INTEGER NOT NULL,
  -- Soft-delete archive (null = live). Hard purge after ARCHIVE_RETENTION_MS.
  archived_at INTEGER,
  archived_by TEXT,
  -- BYOK provider + model policy (customer inference never uses host env keys).
  provider_id TEXT NOT NULL DEFAULT 'openrouter',
  custom_base_url TEXT,
  lite_model_mode TEXT NOT NULL DEFAULT 'use_default',
  lite_model TEXT,
  thinking_model_mode TEXT NOT NULL DEFAULT 'use_default',
  thinking_model TEXT,
  allow_project_model_override INTEGER NOT NULL DEFAULT 0,
  project_create_policy TEXT NOT NULL DEFAULT 'any_org_member',
  default_provider_key_id TEXT,
  -- Stripe seat billing (org-level subscription).
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  plan TEXT NOT NULL DEFAULT 'none',
  seat_quantity INTEGER NOT NULL DEFAULT 0,
  billing_status TEXT NOT NULL DEFAULT 'none',
  current_period_end INTEGER,
  billing_email TEXT,
  billing_last_event_created INTEGER
);
CREATE TABLE IF NOT EXISTS stripe_events (
  event_id     TEXT PRIMARY KEY,
  processed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS org_provider_keys (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  ciphertext  TEXT NOT NULL,
  iv          TEXT NOT NULL,
  tag         TEXT NOT NULL,
  last4       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  created_by  TEXT
);
CREATE INDEX IF NOT EXISTS idx_org_provider_keys_org
  ON org_provider_keys (org_id, created_at DESC);
CREATE TABLE IF NOT EXISTS projects (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  repo           TEXT,
  org_id         TEXT REFERENCES orgs(id),
  created_by     TEXT,
  mediator_model TEXT NOT NULL DEFAULT 'z-ai/glm-5.2',
  attention_grace_ms INTEGER NOT NULL DEFAULT 900000,
  attention_cooldown_ms INTEGER NOT NULL DEFAULT 1800000,
  last_active_lease_at INTEGER,
  claim_generation INTEGER NOT NULL DEFAULT 0,
  archived_at INTEGER,
  archived_by TEXT,
  -- Provider key: inherit org default, pick an org-named key, or project secret.
  provider_key_mode TEXT NOT NULL DEFAULT 'inherit',
  provider_key_id TEXT,
  project_key_ciphertext TEXT,
  project_key_iv TEXT,
  project_key_tag TEXT,
  project_key_last4 TEXT,
  -- Model overrides (honored only when org.allow_project_model_override = 1).
  lite_model_mode TEXT,
  lite_model TEXT,
  thinking_model_mode TEXT,
  thinking_model TEXT
);
CREATE TABLE IF NOT EXISTS github_installations (${GITHUB_INSTALLATIONS_COLUMNS});
CREATE TABLE IF NOT EXISTS github_project_repos (
  project_id      TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  installation_id TEXT NOT NULL REFERENCES github_installations(installation_id) ON DELETE RESTRICT,
  repository_id   TEXT NOT NULL UNIQUE,
  full_name       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_seats (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK (role IN ('human','coder')),
  name         TEXT NOT NULL,
  consent_code TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_oauth_seats_owner
  ON oauth_seats (user_id, project_id, revoked_at);
-- Seat enrollment grants (Part A): a short-lived, single-use token an admin
-- mints so a teammate can self-enroll into a role-scoped seat. Only the
-- sha256 of the token is stored; redeemed_at/redeemed_key_id claim it once.
CREATE TABLE IF NOT EXISTS seat_enrollments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  redeemed_at INTEGER,
  redeemed_key_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_seat_enrollments_project
  ON seat_enrollments (project_id, created_at);
-- Per-project roles (Part F): generalizes the hardcoded human/coder pair. Each
-- project seeds a human + coder row; admins add custom roles. kind selects the
-- MCP tool surface (human tools vs coder tools); always_available marks a role
-- Frigg treats as always present (the human seat).
CREATE TABLE IF NOT EXISTS roles (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('human','worker')),
  display_name TEXT NOT NULL,
  system_prompt TEXT,
  model TEXT,
  always_available INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, slug)
);
CREATE TABLE IF NOT EXISTS tasks (${TASKS_COLUMNS});
CREATE INDEX IF NOT EXISTS idx_tasks_queue
  ON tasks (project_id, state, priority, id);
CREATE INDEX IF NOT EXISTS idx_tasks_archive
  ON tasks (project_id, state, updated_at DESC, id DESC);
-- Stateless human_submit retry ledger. A row is reserved and linked to its
-- task in the same transaction, so concurrent retries cannot double-file.
CREATE TABLE IF NOT EXISTS submission_idempotency (
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  submitted_by    TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  task_id         INTEGER,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (project_id, submitted_by, idempotency_key)
);
CREATE TABLE IF NOT EXISTS task_transitions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  from_state TEXT NOT NULL,
  to_state   TEXT NOT NULL,
  changed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_transitions_project_time
  ON task_transitions (project_id, changed_at DESC, id DESC);
-- Pull-created, host-delivered unattended-work episodes. One row per task is
-- updated in place; episode increments only after resolution + cooldown, so
-- the derived task:episode id is stable across repeated human_status reads.
CREATE TABLE IF NOT EXISTS attention_alerts (
  task_id            INTEGER PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  episode            INTEGER NOT NULL DEFAULT 1,
  episode_started_at INTEGER NOT NULL,
  queue_generation   INTEGER NOT NULL DEFAULT 0,
  claim_generation   INTEGER NOT NULL DEFAULT 0,
  resolved_at        INTEGER,
  cooldown_until     INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attention_alerts_project
  ON attention_alerts (project_id, resolved_at);
-- Structured dependency edges (#57). Edge A->B is {task_id: B, depends_on: A}:
-- "B depends on A". Claiming skips a QUEUED task while any predecessor is not
-- DONE — an automatic, self-clearing gate distinct from BLOCKED.
CREATE TABLE IF NOT EXISTS task_deps (
  task_id    INTEGER NOT NULL REFERENCES tasks(id),
  depends_on INTEGER NOT NULL REFERENCES tasks(id),
  PRIMARY KEY (task_id, depends_on)
);
CREATE TABLE IF NOT EXISTS evidence (${EVIDENCE_COLUMNS});
CREATE INDEX IF NOT EXISTS idx_evidence_task ON evidence (task_id);
CREATE TABLE IF NOT EXISTS attempts (${ATTEMPTS_COLUMNS});
CREATE INDEX IF NOT EXISTS idx_attempts_task ON attempts (task_id);
CREATE TABLE IF NOT EXISTS jobs (${JOBS_COLUMNS});
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status, id);
CREATE TABLE IF NOT EXISTS mediator_usage (
  job_id              INTEGER PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id),
  kind                TEXT NOT NULL,
  requested_model     TEXT,
  resolved_model      TEXT,
  prompt_tokens       INTEGER NOT NULL DEFAULT 0,
  completion_tokens   INTEGER NOT NULL DEFAULT 0,
  cached_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_discount_usd  REAL,
  cost_usd            REAL,
  completion_count    INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mediator_usage_project_day
  ON mediator_usage (project_id, created_at);
-- One row per provider invocation. attempt separates worker retries while
-- invocation separates multi-call jobs such as queue consolidation. Terminal
-- fields stay nullable until the worker knows whether the invocation succeeded,
-- failed, or caused the durable job to retry.
CREATE TABLE IF NOT EXISTS job_policy_log (
  project_id           TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  job_id                INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  task_id               INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  attempt               INTEGER NOT NULL CHECK (attempt > 0),
  invocation            INTEGER NOT NULL CHECK (invocation > 0),
  kind                  TEXT NOT NULL CHECK (length(kind) > 0),
  classified_difficulty TEXT CHECK (classified_difficulty IN ('simple','medium','hard')),
  model                 TEXT NOT NULL CHECK (length(model) > 0),
  effort                TEXT NOT NULL CHECK (effort IN ('none','low','high','xhigh','enabled','budgeted')),
  max_tokens            INTEGER NOT NULL CHECK (max_tokens > 0),
  rollout_arm           TEXT NOT NULL CHECK (rollout_arm IN ('flat','routed')),
  latency_ms            INTEGER CHECK (latency_ms >= 0),
  tokens_in             INTEGER NOT NULL DEFAULT 0 CHECK (tokens_in >= 0),
  tokens_out            INTEGER NOT NULL DEFAULT 0 CHECK (tokens_out >= 0),
  outcome               TEXT CHECK (outcome IN ('ok','fail','retry')),
  quality_signal        TEXT CHECK (quality_signal IN ('rejected','steered','reopened')),
  quality_signaled_at   INTEGER,
  started_at            INTEGER NOT NULL,
  finished_at           INTEGER,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  PRIMARY KEY (job_id, attempt, invocation)
);
CREATE INDEX IF NOT EXISTS idx_job_policy_log_project_time
  ON job_policy_log (project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_job_policy_log_task_time
  ON job_policy_log (task_id, created_at);
CREATE TABLE IF NOT EXISTS threads (${THREADS_COLUMNS});
CREATE INDEX IF NOT EXISTS idx_threads_project ON threads (project_id, id);
CREATE TABLE IF NOT EXISTS thread_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id  INTEGER NOT NULL REFERENCES threads(id),
  role       TEXT NOT NULL CHECK (role IN ('human','coder','mediator','system')),
  author     TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  reasoning  TEXT,
  structured TEXT,
  model      TEXT,
  usage      TEXT
);
CREATE INDEX IF NOT EXISTS idx_thread_messages_thread ON thread_messages (thread_id, id);
CREATE TABLE IF NOT EXISTS session_events (${SESSION_EVENTS_COLUMNS});
CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events (session_id, seq);
CREATE TABLE IF NOT EXISTS mcp_sessions (
  id           TEXT PRIMARY KEY,
  key_id       TEXT NOT NULL,
  member_name  TEXT NOT NULL,
  project_ids  TEXT NOT NULL,
  capabilities TEXT NOT NULL DEFAULT '{}',
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  closed_at    INTEGER,
  next_event_sequence INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_mcp_sessions_key ON mcp_sessions (key_id, closed_at, expires_at);
CREATE TABLE IF NOT EXISTS mcp_events (
  event_id   TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES mcp_sessions(id) ON DELETE CASCADE,
  stream_id  TEXT NOT NULL,
  sequence   INTEGER NOT NULL,
  message    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (session_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_mcp_events_replay ON mcp_events (session_id, stream_id, sequence);
CREATE TABLE IF NOT EXISTS decision_log (${DECISION_COLUMNS});
CREATE TABLE IF NOT EXISTS questions (${QUESTIONS_COLUMNS});
CREATE TABLE IF NOT EXISTS negotiations (${NEGOTIATIONS_COLUMNS});
CREATE TABLE IF NOT EXISTS project_context_domains (
  project_id        TEXT NOT NULL REFERENCES projects(id),
  domain            TEXT NOT NULL,
  last_refreshed_at INTEGER,
  last_checked_at   INTEGER,
  dirty_since       INTEGER,
  dirty_reason      TEXT,
  requested_generation INTEGER NOT NULL DEFAULT 0,
  applied_generation   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, domain)
);
CREATE INDEX IF NOT EXISTS idx_project_context_domains_dirty
  ON project_context_domains (dirty_since, last_checked_at);
CREATE TABLE IF NOT EXISTS memory_docs (
  project_id  TEXT NOT NULL REFERENCES projects(id),
  path        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (length(type) > 0),
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  tags        TEXT NOT NULL DEFAULT '[]',
  body        TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  source_task INTEGER,
  as_of       TEXT,
  supersedes  TEXT NOT NULL DEFAULT '[]',
  superseded_by TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (project_id, path)
);
-- task_id (#86): a curate entry is attributed to the task whose decision
-- crossed the curate threshold (the max-decision of the pass). Nullable so
-- historical/unmappable rows stay valid; a null entry surfaces in no task
-- timeline. The timeline read scopes on it, ending the whole-project dump.
CREATE TABLE IF NOT EXISTS memory_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id    INTEGER REFERENCES tasks(id),
  entry      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS task_notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES tasks(id),
  agent      TEXT NOT NULL,
  note       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_notes_task ON task_notes (task_id, id);
CREATE TABLE IF NOT EXISTS steers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     INTEGER NOT NULL REFERENCES tasks(id),
  author      TEXT NOT NULL,
  instruction TEXT NOT NULL,
  delivered   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS catchup_watermarks (
  project_id      TEXT NOT NULL REFERENCES projects(id),
  member          TEXT NOT NULL,
  watermark_at    INTEGER NOT NULL,
  last_decision_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, member)
);
-- Multi-human async conflict conversations (#77). The mediator opens one when
-- two members submit conflicting/duplicate-divergent work: the participants
-- discuss across sessions and the conversation closes into a recorded
-- decision. Additive tables — messages reuse the threads/thread_messages
-- topology (task 27) via the anchor thread_id, so no thread-kind widening and
-- no decision_log surgery is needed. state OPEN -> CLOSED (settled) / EXPIRED
-- (timed out with partial input); deadline is an absolute ms timestamp.
CREATE TABLE IF NOT EXISTS conversations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  thread_id  INTEGER NOT NULL REFERENCES threads(id),
  topic      TEXT NOT NULL,
  state      TEXT NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN','CLOSED','EXPIRED')),
  deadline   INTEGER NOT NULL,
  summary    TEXT,
  created_at INTEGER NOT NULL,
  closed_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_conversations_open
  ON conversations (state, deadline);
CREATE TABLE IF NOT EXISTS conversation_participants (
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  member          TEXT NOT NULL,
  replied_at      INTEGER,
  PRIMARY KEY (conversation_id, member)
);
CREATE TABLE IF NOT EXISTS conversation_tasks (
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  task_id         INTEGER NOT NULL REFERENCES tasks(id),
  PRIMARY KEY (conversation_id, task_id)
);
CREATE TABLE IF NOT EXISTS conversation_decisions (
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  decision_id     INTEGER NOT NULL REFERENCES decision_log(id),
  PRIMARY KEY (conversation_id, decision_id)
);
-- Web Push subscriptions (task #418). Per-user per-device; better-auth user id
-- is stored without a hard FK so auth migrations can rebuild "user" freely.
-- revoked_at soft-deletes on logout, explicit disable, or push 404/410.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint         TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  p256dh           TEXT NOT NULL,
  auth             TEXT NOT NULL,
  user_agent       TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  last_success_at  INTEGER,
  last_error_at    INTEGER,
  revoked_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user
  ON push_subscriptions (user_id, revoked_at);
-- Durable push dedup: one native notification per episode per device.
CREATE TABLE IF NOT EXISTS push_delivery_log (
  endpoint    TEXT NOT NULL,
  episode_id  TEXT NOT NULL,
  sent_at     INTEGER NOT NULL,
  PRIMARY KEY (endpoint, episode_id)
);
CREATE INDEX IF NOT EXISTS idx_push_delivery_log_episode
  ON push_delivery_log (episode_id, sent_at);
-- Age-out prune filters on sent_at alone; needs a leading sent_at key
-- (the episode composite above cannot serve that predicate).
CREATE INDEX IF NOT EXISTS idx_push_delivery_log_sent_at
  ON push_delivery_log (sent_at);
-- Public marketing waitlist (task #509). Email-only capture; no auth FK.
CREATE TABLE IF NOT EXISTS waitlist_emails (
  email      TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  source     TEXT
);
CREATE INDEX IF NOT EXISTS idx_waitlist_emails_created
  ON waitlist_emails (created_at);
`;

// SQLite defers FK checks to write time, so the circular tasks<->threads
// reference can live inline-free here too; the sqlite driver has always
// shipped without a hard constraint on root_thread_id since the split.
const SQLITE_TAIL = `
CREATE INDEX IF NOT EXISTS idx_tasks_block_recovery
  ON tasks (state, block_requeue_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_open_ci_fix
  ON tasks (parent_id, ci_fix_key)
  WHERE ci_fix_key IS NOT NULL AND state <> 'DONE';
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_inflight_coalesce
  ON jobs (project_id, kind, coalesce_key)
  WHERE coalesce_key IS NOT NULL AND status IN ('pending','running');
CREATE UNIQUE INDEX IF NOT EXISTS idx_questions_project_open_text
  ON questions (project_id, question) WHERE task_id IS NULL AND status='open';
CREATE UNIQUE INDEX IF NOT EXISTS idx_questions_project_open_domain
  ON questions (project_id, domain) WHERE task_id IS NULL AND status='open' AND domain IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_negotiations_open_subject
  ON negotiations (subject_task_id) WHERE state NOT IN ('accepted','declined','cancelled');
CREATE INDEX IF NOT EXISTS idx_negotiations_party
  ON negotiations (party_identity) WHERE state IN ('awaiting_party','awaiting_person');
CREATE TRIGGER IF NOT EXISTS tasks_record_state_transition
AFTER UPDATE OF state ON tasks
WHEN OLD.state <> NEW.state
BEGIN
  INSERT INTO task_transitions (project_id, task_id, from_state, to_state, changed_at)
  VALUES (NEW.project_id, NEW.id, OLD.state, NEW.state, NEW.updated_at);
END;
`;

// Postgres: add the circular FK once both tables exist. Idempotent via the
// duplicate_object guard — SCHEMA runs on every boot. DEFERRABLE so the
// migration script can insert tasks before their root threads inside one
// SET CONSTRAINTS ... DEFERRED transaction.
const POSTGRES_TAIL = `
-- GitHub App repository access expanded from selected-only to selected/all.
-- Existing installations keep their row while the enum-like CHECK is widened.
DO $$ DECLARE legacy_check TEXT;
BEGIN
  SELECT c.conname INTO legacy_check
    FROM pg_constraint c
   WHERE c.conrelid = 'github_installations'::regclass
     AND c.contype = 'c'
     AND pg_get_constraintdef(c.oid) LIKE '%repository_selection%'
     AND pg_get_constraintdef(c.oid) NOT LIKE '%all%'
   LIMIT 1;
  IF legacy_check IS NOT NULL THEN
    EXECUTE format('ALTER TABLE github_installations DROP CONSTRAINT %I', legacy_check);
    ALTER TABLE github_installations ADD CONSTRAINT github_installations_repository_selection_check
      CHECK (repository_selection IN ('selected','all'));
  END IF;
END $$;
DO $$ BEGIN
  ALTER TABLE mcp_sessions ADD COLUMN next_event_sequence BIGINT NOT NULL DEFAULT 1;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE tasks ADD COLUMN block_kind TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE tasks ADD COLUMN block_requeue_at BIGINT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE tasks ADD COLUMN hold_cause TEXT CHECK (hold_cause IN ('conflict','question','dependency','explicit'));
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE tasks ADD COLUMN ci_fix_key TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE tasks ADD COLUMN merge_probe_transient_since BIGINT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_tasks_block_recovery
  ON tasks (state, block_requeue_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_open_ci_fix
  ON tasks (parent_id, ci_fix_key)
  WHERE ci_fix_key IS NOT NULL AND state <> 'DONE';
ALTER TABLE questions ALTER COLUMN task_id DROP NOT NULL;
DROP INDEX IF EXISTS idx_questions_project_unique;
DO $$ BEGIN
  ALTER TABLE questions ADD COLUMN domain TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE questions ADD COLUMN refresh_trigger TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE questions ADD COLUMN answered_by TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE questions ADD COLUMN answered_at BIGINT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE questions ADD COLUMN curated_at BIGINT;
  UPDATE questions
     SET curated_at = COALESCE(answered_at, created_at)
   WHERE task_id IS NULL AND status='answered' AND curated_at IS NULL;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE jobs ADD COLUMN coalesce_key TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE negotiations ADD COLUMN question_id BIGINT REFERENCES questions(id);
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_inflight_coalesce
  ON jobs (project_id, kind, coalesce_key)
  WHERE coalesce_key IS NOT NULL AND status IN ('pending','running');
CREATE UNIQUE INDEX IF NOT EXISTS idx_questions_project_open_text
  ON questions (project_id, question) WHERE task_id IS NULL AND status='open';
CREATE UNIQUE INDEX IF NOT EXISTS idx_questions_project_open_domain
  ON questions (project_id, domain) WHERE task_id IS NULL AND status='open' AND domain IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_negotiations_open_subject
  ON negotiations (subject_task_id) WHERE state NOT IN ('accepted','declined','cancelled');
CREATE INDEX IF NOT EXISTS idx_negotiations_party
  ON negotiations (party_identity) WHERE state IN ('awaiting_party','awaiting_person');
DO $$ DECLARE legacy_check TEXT;
BEGIN
  SELECT c.conname INTO legacy_check
    FROM pg_constraint c
    JOIN LATERAL unnest(c.conkey) AS key(attnum) ON TRUE
    JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=key.attnum
   WHERE c.conrelid = 'jobs'::regclass
     AND c.contype = 'c'
     AND a.attname = 'kind'
     AND pg_get_constraintdef(c.oid) NOT LIKE '%refresh%'
   LIMIT 1;
  IF legacy_check IS NOT NULL THEN
    EXECUTE format('ALTER TABLE jobs DROP CONSTRAINT %I', legacy_check);
    ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check
      CHECK (kind IN ('groom','review','answer','curate','discuss','reconcile','catchup','seal','enhance','conciliate','consolidate','refresh'));
  END IF;
END $$;
-- Widen attempts.outcome for awaiting_merge (open-PR completion).
DO $$ DECLARE legacy_check TEXT;
BEGIN
  SELECT c.conname INTO legacy_check
    FROM pg_constraint c
    JOIN LATERAL unnest(c.conkey) AS key(attnum) ON TRUE
    JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=key.attnum
   WHERE c.conrelid = 'attempts'::regclass
     AND c.contype = 'c'
     AND a.attname = 'outcome'
     AND pg_get_constraintdef(c.oid) NOT LIKE '%awaiting_merge%'
   LIMIT 1;
  IF legacy_check IS NOT NULL THEN
    EXECUTE format('ALTER TABLE attempts DROP CONSTRAINT %I', legacy_check);
    ALTER TABLE attempts ADD CONSTRAINT attempts_outcome_check
      CHECK (outcome IN ('lease_expired','completed','blocked','plan_window_expired','released','awaiting_merge'));
  END IF;
END $$;
-- Retire degraded GitHub verification as an application state. Existing rows
-- move directly to DONE before the old CHECK is replaced; fresh schemas
-- already carry the narrower CHECK and skip this block.
DO $$ DECLARE legacy_check TEXT;
BEGIN
  SELECT c.conname INTO legacy_check
    FROM pg_constraint c
   WHERE c.conrelid = 'tasks'::regclass
     AND c.contype = 'c'
     AND pg_get_constraintdef(c.oid) LIKE '%PENDING_VERIFICATION%'
   LIMIT 1;
  IF legacy_check IS NOT NULL THEN
    EXECUTE format('ALTER TABLE tasks DROP CONSTRAINT %I', legacy_check);
    DROP TRIGGER IF EXISTS tasks_record_state_transition ON tasks;
    UPDATE tasks
       SET state = 'DONE', pr_verification = NULL, pr_verification_etag = NULL
     WHERE state = 'PENDING_VERIFICATION';
    ALTER TABLE tasks ADD CONSTRAINT tasks_state_check
      CHECK (state IN ('INCUBATING','QUEUED','CLAIMED','PLANNED','EXECUTING','AWAITING_MERGE','DONE','BLOCKED','PARKED','HELD'));
  END IF;
END $$;
-- Widen tasks.state for AWAITING_MERGE (truthful open-PR completion). Existing
-- databases that already carry the post-PENDING_VERIFICATION CHECK need a
-- separate widen; fresh schemas already include AWAITING_MERGE above.
DO $$ DECLARE legacy_check TEXT;
BEGIN
  SELECT c.conname INTO legacy_check
    FROM pg_constraint c
   WHERE c.conrelid = 'tasks'::regclass
     AND c.contype = 'c'
     AND pg_get_constraintdef(c.oid) LIKE '%EXECUTING%'
     AND pg_get_constraintdef(c.oid) NOT LIKE '%AWAITING_MERGE%'
   LIMIT 1;
  IF legacy_check IS NOT NULL THEN
    EXECUTE format('ALTER TABLE tasks DROP CONSTRAINT %I', legacy_check);
    DROP TRIGGER IF EXISTS tasks_record_state_transition ON tasks;
    ALTER TABLE tasks ADD CONSTRAINT tasks_state_check
      CHECK (state IN ('INCUBATING','QUEUED','CLAIMED','PLANNED','EXECUTING','AWAITING_MERGE','DONE','BLOCKED','PARKED','HELD'));
  END IF;
END $$;
DO $$ BEGIN
  ALTER TABLE tasks ADD CONSTRAINT tasks_root_thread_id_fkey
    FOREIGN KEY (root_thread_id) REFERENCES threads(id) DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE projects ADD COLUMN org_id TEXT REFERENCES orgs(id);
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE projects ADD COLUMN created_by TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE projects ADD COLUMN attention_grace_ms BIGINT NOT NULL DEFAULT 900000;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE projects ADD COLUMN attention_cooldown_ms BIGINT NOT NULL DEFAULT 1800000;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE projects ADD COLUMN last_active_lease_at BIGINT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE projects ADD COLUMN claim_generation BIGINT NOT NULL DEFAULT 0;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE orgs ADD COLUMN created_by TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE orgs ADD COLUMN archived_at BIGINT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE orgs ADD COLUMN archived_by TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE projects ADD COLUMN archived_at BIGINT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE projects ADD COLUMN archived_by TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE orgs ADD COLUMN provider_id TEXT NOT NULL DEFAULT 'openrouter';
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE orgs ADD COLUMN custom_base_url TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE orgs ADD COLUMN lite_model_mode TEXT NOT NULL DEFAULT 'use_default';
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE orgs ADD COLUMN lite_model TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE orgs ADD COLUMN thinking_model_mode TEXT NOT NULL DEFAULT 'use_default';
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE orgs ADD COLUMN thinking_model TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE orgs ADD COLUMN allow_project_model_override BIGINT NOT NULL DEFAULT 0;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE orgs ADD COLUMN project_create_policy TEXT NOT NULL DEFAULT 'any_org_member';
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE orgs ADD COLUMN default_provider_key_id TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE orgs ADD COLUMN stripe_customer_id TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE orgs ADD COLUMN stripe_subscription_id TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE orgs ADD COLUMN plan TEXT NOT NULL DEFAULT 'none';
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE orgs ADD COLUMN seat_quantity BIGINT NOT NULL DEFAULT 0;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE orgs ADD COLUMN billing_status TEXT NOT NULL DEFAULT 'none';
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE orgs ADD COLUMN current_period_end BIGINT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE orgs ADD COLUMN billing_email TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE orgs ADD COLUMN billing_last_event_created BIGINT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS stripe_events (
  event_id     TEXT PRIMARY KEY,
  processed_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS org_provider_keys (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  ciphertext  TEXT NOT NULL,
  iv          TEXT NOT NULL,
  tag         TEXT NOT NULL,
  last4       TEXT NOT NULL,
  created_at  BIGINT NOT NULL,
  created_by  TEXT
);
CREATE INDEX IF NOT EXISTS idx_org_provider_keys_org
  ON org_provider_keys (org_id, created_at DESC);
DO $$ BEGIN
  ALTER TABLE projects ADD COLUMN provider_key_mode TEXT NOT NULL DEFAULT 'inherit';
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE projects ADD COLUMN provider_key_id TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE projects ADD COLUMN project_key_ciphertext TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE projects ADD COLUMN project_key_iv TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE projects ADD COLUMN project_key_tag TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE projects ADD COLUMN project_key_last4 TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE projects ADD COLUMN lite_model_mode TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE projects ADD COLUMN lite_model TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE projects ADD COLUMN thinking_model_mode TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE projects ADD COLUMN thinking_model TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
CREATE OR REPLACE FUNCTION record_task_state_transition() RETURNS trigger AS $$
BEGIN
  IF OLD.state IS DISTINCT FROM NEW.state THEN
    INSERT INTO task_transitions (project_id, task_id, from_state, to_state, changed_at)
    VALUES (NEW.project_id, NEW.id, OLD.state, NEW.state, NEW.updated_at);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DO $$ BEGIN
  CREATE TRIGGER tasks_record_state_transition
    AFTER UPDATE OF state ON tasks
    FOR EACH ROW EXECUTE FUNCTION record_task_state_transition();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Curate attribution (#86): add task_id, then backfill historical
-- curated@<id> rows by parsing the decision id and reading its task. Only
-- fills NULL rows -> idempotent; unmappable/task-less decisions stay null.
DO $$ BEGIN
  ALTER TABLE decision_log ADD COLUMN citations TEXT NOT NULL DEFAULT '[]';
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
-- Image attachment metadata (#172). Object bytes stay in R2; legacy evidence
-- rows receive only nullable metadata columns. Widen the generated kind CHECK
-- exactly once, regardless of the constraint name chosen by Postgres.
DO $$ BEGIN
  ALTER TABLE evidence ADD COLUMN blob_ref TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE evidence ADD COLUMN mime_type TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE evidence ADD COLUMN caption TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ DECLARE legacy_check TEXT;
BEGIN
  SELECT c.conname INTO legacy_check
    FROM pg_constraint c
   WHERE c.conrelid = 'evidence'::regclass
     AND c.contype = 'c'
     AND pg_get_constraintdef(c.oid) LIKE '%kind%'
     AND pg_get_constraintdef(c.oid) NOT LIKE '%image%'
   LIMIT 1;
  IF legacy_check IS NOT NULL THEN
    EXECUTE format('ALTER TABLE evidence DROP CONSTRAINT %I', legacy_check);
    ALTER TABLE evidence ADD CONSTRAINT evidence_kind_check
      CHECK (kind IN ('code','stacktrace','log','link','research','image'));
  END IF;
END $$;
DO $$ BEGIN
  ALTER TABLE evidence ADD CONSTRAINT evidence_image_metadata_check CHECK (
    (kind = 'image' AND blob_ref IS NOT NULL AND mime_type IS NOT NULL
      AND path IS NULL AND lines IS NULL AND snippet IS NULL AND note IS NULL)
    OR
    (kind <> 'image' AND blob_ref IS NULL AND mime_type IS NULL AND caption IS NULL)
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE memory_log ADD COLUMN task_id BIGINT REFERENCES tasks(id);
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE memory_docs ADD COLUMN source_task BIGINT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE memory_docs ADD COLUMN as_of TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE memory_docs ADD COLUMN supersedes TEXT NOT NULL DEFAULT '[]';
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE memory_docs ADD COLUMN superseded_by TEXT NOT NULL DEFAULT '[]';
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE tasks ADD COLUMN queued_at BIGINT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE tasks ADD COLUMN queue_generation BIGINT NOT NULL DEFAULT 0;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE tasks ADD COLUMN lease_ttl_ms BIGINT NOT NULL DEFAULT 1800000;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
-- Legacy DBs did not record queue entry. updated_at is the conservative lower
-- bound: it may delay an alert after metadata edits, but cannot falsely age a
-- task that requeued recently. New transitions maintain queued_at exactly.
UPDATE tasks SET queued_at = updated_at WHERE queued_at IS NULL AND state = 'QUEUED';
UPDATE tasks SET queue_generation = 1 WHERE queue_generation = 0 AND state = 'QUEUED';
-- Bidirectional root link (#499): backfill threads.task_id from tasks.root_thread_id.
UPDATE threads th
   SET task_id = owner.task_id
  FROM (
    SELECT root_thread_id AS thread_id, MIN(id) AS task_id
      FROM tasks
     WHERE root_thread_id IS NOT NULL
     GROUP BY root_thread_id
  ) owner
 WHERE th.id = owner.thread_id
   AND th.task_id IS NULL;
DO $$ BEGIN
  ALTER TABLE attention_alerts ADD COLUMN queue_generation BIGINT NOT NULL DEFAULT 0;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE attention_alerts ADD COLUMN claim_generation BIGINT NOT NULL DEFAULT 0;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
UPDATE memory_log ml
   SET task_id = dl.task_id
  FROM decision_log dl
 WHERE ml.task_id IS NULL
   AND ml.entry LIKE 'curated@%:%'
   AND dl.project_id = ml.project_id
   AND dl.id = (substring(ml.entry from '^curated@(\\d+):'))::bigint
   AND dl.task_id IS NOT NULL;
`;

// These task ids intentionally lack foreign keys because merge retargeting
// and historical imports need to rewrite them. Repair legacy dangling and
// cross-Project values on every boot so retries and taskless memory updates
// cannot remain poisoned forever. Both statements are idempotent and use SQL
// accepted by SQLite and Postgres.
const TASK_METADATA_REPAIR = `
DELETE FROM submission_idempotency
 WHERE task_id IS NULL
    OR NOT EXISTS (
     SELECT 1 FROM tasks
      WHERE tasks.id = submission_idempotency.task_id
        AND tasks.project_id = submission_idempotency.project_id
   );
UPDATE memory_docs
   SET source_task = NULL
 WHERE source_task IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM tasks
      WHERE tasks.id = memory_docs.source_task
        AND tasks.project_id = memory_docs.project_id
   );
`;

/**
 * One schema, two dialects. The Postgres rendering swaps SQLite's rowid
 * AUTOINCREMENT for an identity column (BY DEFAULT, so the migration script
 * can insert explicit ids) and widens every INTEGER to BIGINT — the codebase
 * stores Date.now() millisecond timestamps, which overflow int4.
 */
export function renderSchema(dialect: Dialect): string {
  if (dialect === "sqlite") return SCHEMA + SQLITE_TAIL + TASK_METADATA_REPAIR;
  return (
    SCHEMA.replaceAll(
      "INTEGER PRIMARY KEY AUTOINCREMENT",
      "BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY",
    ).replace(/\bINTEGER\b/g, "BIGINT") + POSTGRES_TAIL + TASK_METADATA_REPAIR
  );
}

/**
 * Every application table, in FK-safe insert order (parents first). tasks
 * precedes threads: with tasks_root_thread_id_fkey deferred, task rows may
 * point at not-yet-inserted root threads, while threads.task_id and the
 * threads.root_id self-reference (roots have lower ids) check immediately.
 */
export const TABLES_IN_INSERT_ORDER = [
  "orgs",
  "projects",
  "github_installations",
  "github_project_repos",
  "oauth_seats",
  "seat_enrollments",
  "roles",
  "tasks",
  "task_transitions",
  "attention_alerts",
  "task_deps",
  "threads",
  "thread_messages",
  "session_events",
  "mcp_sessions",
  "mcp_events",
  "evidence",
  "attempts",
  "jobs",
  "mediator_usage",
  "job_policy_log",
  "decision_log",
  "questions",
  "negotiations",
  "project_context_domains",
  "memory_docs",
  "memory_log",
  "task_notes",
  "steers",
  "catchup_watermarks",
  "conversations",
  "conversation_participants",
  "conversation_tasks",
  "conversation_decisions",
  "push_subscriptions",
  "push_delivery_log",
  "waitlist_emails",
] as const;
