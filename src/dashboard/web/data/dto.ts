import type { TaskState } from "../lib/url-state.js";

export type Role = "human" | "coder" | "admin";
export type ActorRole = "human" | "coder" | "mediator" | "system";

export type ProjectCreatePolicy = "org_admins_only" | "any_org_member";
export type ModelModeDto = "use_default" | "override";

export interface OrgProviderKeyDto {
  id: string;
  label: string;
  last4: string;
  createdAt: number;
  createdBy: string | null;
  isDefault: boolean;
}

export interface OrgProviderCatalogEntryDto {
  id: string;
  label: string;
  baseUrl: string | null;
  defaultLiteModel: string;
  defaultThinkingModel: string;
}

export interface OrgBillingDto {
  plan: string;
  seatQuantity: number;
  billingStatus: string;
  currentPeriodEnd: number | null;
  billingEmail: string | null;
  hasCustomer: boolean;
  stripeConfigured: boolean;
}

export interface OrgSettingsDto {
  id: string;
  name: string;
  createdBy: string | null;
  isAdmin: boolean;
  projectCreatePolicy: ProjectCreatePolicy;
  providerId: string;
  customBaseUrl: string | null;
  liteModelMode: ModelModeDto;
  liteModel: string | null;
  thinkingModelMode: ModelModeDto;
  thinkingModel: string | null;
  resolvedLiteModel: string;
  resolvedThinkingModel: string;
  allowProjectModelOverride: boolean;
  defaultProviderKeyId: string | null;
  keys: OrgProviderKeyDto[];
  providers: OrgProviderCatalogEntryDto[];
  billing?: OrgBillingDto;
}

export interface ProjectInferenceDto {
  providerKeyMode: "inherit" | "org_key" | "project_secret";
  providerKeyId: string | null;
  projectKeyLast4: string | null;
  allowProjectModelOverride: boolean;
  liteModelMode: ModelModeDto | null;
  liteModel: string | null;
  thinkingModelMode: ModelModeDto | null;
  thinkingModel: string | null;
  orgKeys: Array<{ id: string; label: string; last4: string; isDefault: boolean }>;
}

export interface MembershipDto {
  projectId: string;
  projectName: string;
  repo: string | null;
  role: Role;
  orgId: string | null;
  orgName: string | null;
}

export interface ProjectsDto { projects: MembershipDto[] }
export interface MeDto { name: string; memberships: MembershipDto[] }
export interface SessionDto { userId: string; name: string; email: string | null }
export interface ConfigDto {
  vapidPublicKey?: string | null;
}
export type AttentionKind = "queue_alert" | "question" | "conversation" | "blocked" | "lease";
export interface AttentionItemDto {
  episode_id: string;
  kind: AttentionKind;
  project: string;
  project_name?: string;
  task_id: number | null;
  title: string;
  reason: string;
  recovery: string;
  question_id?: number;
  conversation_id?: number;
  badge?: string;
  state?: string;
  actor_name?: string;
  actor_role?: ActorRole;
  expires_at?: number;
  pushable: boolean;
  task_uri: string | null;
  dashboard_url: string | null;
}
export interface AttentionDto { items: AttentionItemDto[] }
export interface PushStatusDto {
  configured: boolean;
  vapid_public_key: string | null;
  subscribed: boolean;
  subscription_count: number;
  last_error_at: number | null;
}
export interface OrgRosterDto {
  org: { id: string; name: string };
  members: Array<{ userId: string; name: string; email: string; projectId: string; projectName: string; role: Role; joinedAt: number | null }>;
}
export interface GitHubConnectionDto {
  configured: boolean;
  linked: boolean;
  /** True when the user OAuth token is missing/expired and cannot be refreshed — show Reconnect. */
  reauthRequired?: boolean;
  installation: { id: string; accountLogin: string; repositorySelection: "selected" | "all" } | null;
  repositories: Array<{ id: string; name: string; fullName: string; private: boolean }>;
}
export interface InvitesDto { invites: Array<{ email: string; role: Role; expiresAt: number; inviteUrl: string }> }
export interface InviteDto { project: { id: string; name: string }; email: string; role: Role; status: "pending"; hasAccount: boolean }
export interface ApiKeysDto {
  keys: Array<{
    id: string; name: string; type: "human" | "coder"; authMethod: "static" | "oauth";
    clarificationMode: "form" | "text"; prefix: string;
    createdAt: number | null; lastUsedAt: number | null;
  }>;
}

/** Project-wide MCP seat counts + maturity (no secrets). */
export interface SeatReadinessDto {
  factoryReady: boolean;
  humanSeats: number;
  coderSeats: number;
  hasTaskHistory: boolean;
  /** Org has an active paid plan — Frigg only grooms submissions when true. */
  friggReady: boolean;
}

/** Columns shared by the queue row and the full Queue.brief task record. */
export interface TaskSummaryDto {
  id: number;
  title: string;
  body: string;
  priority: number;
  state: TaskState;
  base_sha: string | null;
  repo: string | null;
  submitted_by: string;
  lease_agent: string | null;
  lease_expires_at: number | null;
  result_summary: string | null;
  result_pr_url: string | null;
  result_pr_number: number | null;
  pr_verification: string | null;
  grooming_rationale: string | null;
  parent_id: number | null;
  /** Present when parent_id is set (queue + detail join). */
  parent_title?: string | null;
  parent_submitted_by?: string | null;
  incubate_until: number | null;
  hold_cause: "conflict" | "question" | "dependency" | "explicit" | null;
  created_at: number;
  updated_at: number;
}

/** Machine-readable operational disposition (API may omit on older servers). */
export interface OperationalDispositionDto {
  disposition: string;
  holding: boolean;
  reason: string;
  since: number | null;
  next_owner: string;
  retry_or_expiry: number | null;
  waiting_on: number[];
}

/** Queue-only projections do not appear on the full task-detail response. */
export interface QueueTaskDto extends TaskSummaryDto {
  evidence_count: number;
  latest_attempt_note: string | null;
  operational?: OperationalDispositionDto | null;
}
export interface TaskTransitionDto {
  id: number;
  task_id: number;
  title: string;
  from_state: TaskState;
  to_state: TaskState;
  changed_at: number;
}
export interface QueueOverviewDto {
  window: { label: "last 7 days"; since: number };
  current?: { open: number; active: number; ready: number; done: number };
  trends: { open: number; active: number; ready: number; done: number };
  transitions: TaskTransitionDto[];
}
export interface PageDto { next_cursor: string | null }
export interface QueueDto extends PageDto { tasks: QueueTaskDto[]; overview: QueueOverviewDto }
export interface CompletedTaskDto {
  id: number;
  title: string;
  state: "DONE";
  submitted_by: string;
  updated_at: number;
  result_pr_url: string | null;
  result_pr_number: number | null;
  pr_verification: string | null;
}
export interface CompletedTasksDto {
  tasks: CompletedTaskDto[];
  offset: number;
  limit: number;
  next_offset: number | null;
}

export interface WarmingTaskDto {
  id: number; title: string; body: string; priority: number; state: "INCUBATING";
  submitted_by: string; incubate_until: number; created_at: number; updated_at: number;
  contributor_count: number; thread_count: number;
}
export interface WarmingDto extends PageDto { tasks: WarmingTaskDto[] }

export interface AgentDto { agent: string; task_id: number; title: string; state: "CLAIMED" | "PLANNED" | "EXECUTING"; lease_expires_at: number }
export interface AgentsDto { agents: AgentDto[]; queued: number }

export interface ThreadDto {
  id: number; kind: string; task_id: number | null; root_id: number | null; created_at: number;
  task_title: string | null; task_state: TaskState | null; summary: string | null;
  first_message: string | null; last_message: string | null; first_human_message: string | null;
  last_author: string | null; last_role: ActorRole | null; last_activity: number;
}
export interface ThreadsDto extends PageDto { threads: ThreadDto[] }
export interface ThreadMessageDto { role: string; author: string; content: string; created_at: number }
export interface SessionEventDto {
  id: number; parent_id: number | null; thread_id: number | null; task_id: number | null;
  seq: number; type: string; role: ActorRole; author: string; content: string;
  status: "ok" | "error" | "pending"; start_time: number; end_time: number | null;
}
export interface ThreadDetailDto {
  id: number; kind: string; task_id: number | null; root_id: number | null; created_at: number;
  messages: ThreadMessageDto[]; session_id: number; session: SessionEventDto[];
}

export interface CitationDto { type: "task" | "thread" | "decision" | "evidence" | "pr"; id: number; url: string; label: string }
export interface ScopedDecisionDto { id: number; kind: string; summary: string; rationale: string; created_at: number; citations: CitationDto[] }
export interface ProjectDecisionDto extends ScopedDecisionDto { task_id: number | null }
export interface DecisionsDto extends PageDto { decisions: ProjectDecisionDto[] }

export interface QuestionDto {
  id: number; task_id: number | null; task_title: string | null; asked_by: string; question: string;
  answer: string | null; answered_by: string | null; status: "open" | "answered"; created_at: number;
}
export interface QuestionsDto extends PageDto { questions: QuestionDto[] }

export interface TeamMemberDto { name: string; role: Role; email: string | null; userId: string | null; joinedAt: number | null }
export interface TeamDto { members: TeamMemberDto[] }

export type AnalyticsPeriod = "24h" | "7d" | "30d" | "all";
export interface AnalyticsContributionCountsDto {
  steer: number; create: number; complete: number; answer: number; total: number;
}
export interface AnalyticsAgentContributionDto {
  id: string; label: string; contributions: AnalyticsContributionCountsDto;
}
export interface AnalyticsContributorDto {
  id: string | null; name: string; email: string | null; role: Role;
  task_count: number; completed_count: number; active_count: number;
  last_activity_at: number | null; idle: boolean; name_collision: boolean;
  contributions: AnalyticsContributionCountsDto; agent_contributions: AnalyticsAgentContributionDto[];
}
export interface AnalyticsAgentDto {
  id: string; label: string; owner_id: string | null; owner_name: string | null;
  revoked: boolean; unresolved: boolean; state_counts: Record<string, number>;
  attempt_count: number; completed_attempts: number; last_activity_at: number | null;
}
export interface AnalyticsRoutingDto {
  model: string; rollout_arm: string; invocations: number; successful: number;
  failed: number; retried: number; average_latency_ms: number | null;
  tokens_in: number; tokens_out: number; quality_signals: number;
  /** Spend from mediator_usage for this resolved model (0 when unknown). */
  cost_usd: number;
}
export interface AnalyticsScorecardModelDto {
  model: string; completions: number; cost_usd: number;
}
export interface AnalyticsScorecardDto {
  kind: string; jobs: number; completions: number; cost_usd: number;
  invocations: number; successful: number; failed: number; average_latency_ms: number | null;
  /** Per-resolved_model segments for stacked scorecard bars (null model → "unknown"). */
  by_model: AnalyticsScorecardModelDto[];
}
export interface AnalyticsDto {
  period: AnalyticsPeriod; window: { since: number | null; label: string };
  headline: {
    members: number; active_members: number; tasks: number; active_tasks: number;
    completed_tasks: number; task_completion_rate: number; total_cost_usd: number;
    contributions: number; tasks_shipped: number; frigg_jobs: number;
    trends: {
      contributions: number | null; tasks_shipped: number | null; active_members: number | null;
      frigg_jobs: number | null; frigg_spend: number | null;
    };
  };
  contributors: AnalyticsContributorDto[]; agents: AnalyticsAgentDto[];
  routing: AnalyticsRoutingDto[]; scorecard: AnalyticsScorecardDto[];
  spend_series: AnalyticsSpendBucketDto[];
}
export interface AnalyticsSpendSegmentDto { model: string; cost_usd: number }
export interface AnalyticsSpendBucketDto {
  bucket: string;
  bucket_start: number;
  label: string;
  total_usd: number;
  segments: AnalyticsSpendSegmentDto[];
}

export interface EvidenceDto {
  id: number; kind: "code" | "stacktrace" | "log" | "link" | "research";
  path: string | null; lines: string | null; snippet: string | null; note: string | null;
}
export interface TaskQuestionDto { question: string; answer: string | null; answered_by?: string | null; status: string; asked_by: string }
export interface TaskImageDto {
  id: number;
  mime_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  caption: string | null;
}
export interface TaskImagesDto { images: TaskImageDto[] }
export interface TaskDetailDto extends TaskSummaryDto {
  project_id: string;
  watermark: string | null;
  result_pr_description: string | null;
  root_thread_id: number | null;
  plan: string | null;
  plan_deadline: number | null;
  plan_approved_at: number | null;
  queued_at: number | null;
  queue_generation: number;
  waiting_on: number[];
  evidence: EvidenceDto[];
  attempts: Array<{ agent: string; outcome: string; notes: string | null }>;
  notes: Array<{ agent: string; note: string; created_at: number }>;
  questions: TaskQuestionDto[];
  threads: Array<{ id: number; kind: string; root_id: number | null; created_at: number }>;
  decisions: ScopedDecisionDto[];
  grooming_citations: CitationDto[];
}

export type TimelineItemDto =
  | { kind: "bubble"; type: string; thread_id: number; role: string; author: string; content: string; reasoning: string | null; structured: unknown; model: string | null; usage: unknown; created_at: number }
  | { kind: "event"; type: "decision"; decision_id: number; decision_kind: string; summary: string; rationale: string; citations: CitationDto[]; created_at: number }
  | { kind: "event"; type: "question"; asked_by: string; question: string; answer: string | null; answered_by: string | null; status: string; created_at: number }
  | { kind: "event"; type: "steer"; author: string; instruction: string; delivered: boolean; created_at: number }
  | { kind: "event"; type: "memory"; entry: string; created_at: number }
  | { kind: "event"; type: "evidence"; evidence_id: number; evidence_kind: string; path: string | null; lines: string | null; snippet: string | null; note: string | null; created_at: number }
  | { kind: "event"; type: "pr"; pr_url: string; pr_number: number | null; summary: string | null; created_at: number };
export interface TimelineDto { timeline: TimelineItemDto[]; evidence: EvidenceDto[] }

export interface ConversationParticipantDto { member: string; replied_at: number | null }
export interface ConversationRowDto {
  id: number; project_id: string; thread_id: number; topic: string;
  state: "OPEN" | "CLOSED" | "EXPIRED"; deadline: number; summary: string | null;
  created_at: number; closed_at: number | null;
}
export interface ConversationSummaryDto extends ConversationRowDto {
  participants: ConversationParticipantDto[]; task_ids: number[]; message_count: number; decision_count: number;
}
export interface ConversationsDto { conversations: ConversationSummaryDto[] }
export interface ConversationDto extends ConversationRowDto {
  participants: ConversationParticipantDto[];
  task_ids: number[];
  messages: ThreadMessageDto[];
  decision_ids: number[];
  tasks: Array<{ id: number; title: string; state: TaskState }>;
  decisions: ScopedDecisionDto[];
}

export interface KnowledgeConceptDto { path: string; type: string; title: string; description: string; tags: string[]; updated_at: number }
export interface KnowledgeDto { concepts: KnowledgeConceptDto[] }
export interface ConceptLinkDto { path: string; title: string }
export interface MarkdownLinkTargetDto { href: string; path: string }
export interface KnowledgeTaskRefDto { id: number; title: string }
export interface KnowledgeDecisionRefDto { id: number; kind: string; summary: string }
export interface KnowledgeProvenanceDto extends KnowledgeDecisionRefDto { created_at: number; task: KnowledgeTaskRefDto | null }
export interface KnowledgeUpdateDto {
  id: number; action: "wrote" | "updated" | "curated"; path: string; title: string; type: string;
  created_at: number; task: KnowledgeTaskRefDto | null; decision: KnowledgeDecisionRefDto | null;
}
export interface KnowledgeConventionDto {
  path: string; title: string; description: string; updated_at: number; enforcement: KnowledgeProvenanceDto | null;
}
export interface KnowledgeDecisionDto extends KnowledgeProvenanceDto { concepts: ConceptLinkDto[] }
export interface KnowledgeActivityDto {
  updates: KnowledgeUpdateDto[];
  conventions: KnowledgeConventionDto[];
  decisions: KnowledgeDecisionDto[];
}
export interface KnowledgeDocDto extends KnowledgeConceptDto {
  body: string; links: ConceptLinkDto[]; linkTargets: MarkdownLinkTargetDto[]; backlinks: ConceptLinkDto[]; provenance: KnowledgeProvenanceDto[];
}

export interface HealthDto {
  inFlight: number;
  sweepErrors: { count: number; lastMessage: string | null; lastAt: number | null; escalated: boolean };
  drainErrors: { count: number; lastMessage: string | null; lastAt: number | null; escalated: boolean };
}
