import type {
  AgentsDto, ApiKeysDto, AttentionDto, CompletedTasksDto, ConfigDto, ConversationDto, ConversationsDto, DecisionsDto, HealthDto,
  GitHubConnectionDto, InviteDto, InvitesDto, KnowledgeActivityDto, KnowledgeDocDto, KnowledgeDto, MeDto, OrgRosterDto, OrgSettingsDto, ProjectInferenceDto, ProjectsDto,
  PushStatusDto, QuestionsDto, QueueDto, SeatReadinessDto, SessionDto, TaskDetailDto, TeamDto, ThreadDetailDto, ThreadsDto, AnalyticsDto, AnalyticsPeriod,
  TaskImagesDto, TimelineDto, WarmingDto,
} from "./dto.js";
import type { Role } from "./dto.js";

export class DashboardApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "DashboardApiError";
  }
  get unauthorized(): boolean { return this.status === 401; }
  get missing(): boolean { return this.status === 404; }
}

export type GetJson = <T>(path: string) => Promise<T>;
export type SendJson = <T>(path: string, method: "POST" | "PATCH" | "DELETE", body?: unknown) => Promise<T>;

export const getJson: GetJson = async <T>(path: string): Promise<T> => {
  const response = await fetch(`/api${path}`, { credentials: "same-origin", headers: { Accept: "application/json" } });
  if (!response.ok) throw new DashboardApiError(response.status, await response.text());
  return response.json() as Promise<T>;
};

export const sendJson: SendJson = async <T>(path: string, method: "POST" | "PATCH" | "DELETE", body?: unknown): Promise<T> => {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new DashboardApiError(response.status, await response.text());
  return response.json() as Promise<T>;
};

const projectPath = (project: string, suffix: string) => `/p/${encodeURIComponent(project)}/${suffix}`;
export interface PageParams { cursor?: string; limit?: number }
export interface CompletedTasksParams { q?: string; limit?: number; offset?: number }

function pagePath(path: string, page?: PageParams): string {
  if (!page?.cursor && page?.limit === undefined) return path;
  const query = new URLSearchParams();
  if (page.cursor) query.set("cursor", page.cursor);
  if (page.limit !== undefined) query.set("limit", String(page.limit));
  return `${path}?${query}`;
}

function completedTasksPath(project: string, params?: CompletedTasksParams): string {
  const path = projectPath(project, "tasks/done");
  if (!params || (params.q === undefined && params.limit === undefined && params.offset === undefined)) return path;
  const query = new URLSearchParams();
  if (params.q !== undefined) query.set("q", params.q);
  if (params.limit !== undefined) query.set("limit", String(params.limit));
  if (params.offset !== undefined) query.set("offset", String(params.offset));
  return `${path}?${query}`;
}

export function createDashboardApi(get: GetJson = getJson, send: SendJson = sendJson) {
  return {
    projects: () => get<ProjectsDto>("/projects"),
    me: () => get<MeDto>("/me"),
    session: () => get<SessionDto>("/session"),
    /** Update signed-in display name (better-auth /api/auth/update-user). */
    updateDisplayName: async (name: string) => {
      const response = await fetch("/api/auth/update-user", {
        method: "POST",
        credentials: "same-origin",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      if (!response.ok) throw new DashboardApiError(response.status, await response.text());
      return response.json() as Promise<{ user?: { name?: string } }>;
    },
    config: () => get<ConfigDto>("/config"),
    orgRoster: (org: string) => get<OrgRosterDto>(`/orgs/${encodeURIComponent(org)}/roster`),
    orgSettings: (org: string) => get<OrgSettingsDto>(`/orgs/${encodeURIComponent(org)}/settings`),
    updateOrgSettings: (org: string, body: Record<string, unknown>) =>
      send<{ ok: true }>(`/orgs/${encodeURIComponent(org)}/settings`, "PATCH", body),
    billingCheckout: (org: string, body: { plan: "solo" | "team"; seats: number }) =>
      send<{ url: string; sessionId: string }>(`/orgs/${encodeURIComponent(org)}/billing/checkout`, "POST", body),
    billingPortal: (org: string) =>
      send<{ url: string }>(`/orgs/${encodeURIComponent(org)}/billing/portal`, "POST", {}),
    createProviderKey: (org: string, label: string, secret: string) =>
      send<{ id: string; label: string; last4: string; createdAt: number; isDefault: boolean }>(
        `/orgs/${encodeURIComponent(org)}/provider-keys`,
        "POST",
        { label, secret },
      ),
    deleteProviderKey: (org: string, keyId: string) =>
      send<{ ok: true }>(`/orgs/${encodeURIComponent(org)}/provider-keys/${encodeURIComponent(keyId)}`, "DELETE"),
    setDefaultProviderKey: (org: string, keyId: string) =>
      send<{ ok: true }>(`/orgs/${encodeURIComponent(org)}/provider-keys/${encodeURIComponent(keyId)}/default`, "POST"),
    githubConnection: (org: string) => get<GitHubConnectionDto>(`/orgs/${encodeURIComponent(org)}/github`),
    invite: (token: string) => get<InviteDto>(`/invite/${encodeURIComponent(token)}`),
    queue: (project: string, page?: PageParams) => get<QueueDto>(pagePath(projectPath(project, "queue"), page)),
    completedTasks: (project: string, params?: CompletedTasksParams) => get<CompletedTasksDto>(completedTasksPath(project, params)),
    warming: (project: string, page?: PageParams) => get<WarmingDto>(pagePath(projectPath(project, "warming"), page)),
    agents: (project: string) => get<AgentsDto>(projectPath(project, "agents")),
    health: (project: string) => get<HealthDto>(projectPath(project, "health")),
    threads: (project: string, page?: PageParams) => get<ThreadsDto>(pagePath(projectPath(project, "threads"), page)),
    thread: (project: string, id: number) => get<ThreadDetailDto>(projectPath(project, `threads/${id}`)),
    questions: (project: string, page?: PageParams) => get<QuestionsDto>(pagePath(projectPath(project, "questions"), page)),
    attention: (project: string) => get<AttentionDto>(projectPath(project, "attention")),
    pushStatus: () => get<PushStatusDto>("/push/status"),
    pushSubscribe: (body: { endpoint: string; keys: { p256dh: string; auth: string } }) =>
      send<PushStatusDto & { ok: true }>("/push/subscribe", "POST", body),
    pushUnsubscribe: (endpoint: string) =>
      send<PushStatusDto & { ok: true }>("/push/subscribe", "DELETE", { endpoint }),
    task: (project: string, id: number) => get<TaskDetailDto>(projectPath(project, `tasks/${id}`)),
    taskImages: (project: string, id: number) => get<TaskImagesDto>(projectPath(project, `tasks/${id}/images`)),
    taskImageUrl: (project: string, id: number) => projectPath(project, `images/${id}`),
    timeline: (project: string, id: number) => get<TimelineDto>(projectPath(project, `tasks/${id}/timeline`)),
    conversations: (project: string) => get<ConversationsDto>(projectPath(project, "conversations")),
    conversation: (project: string, id: number) => get<ConversationDto>(projectPath(project, `conversations/${id}`)),
    decisions: (project: string, page?: PageParams) => get<DecisionsDto>(pagePath(projectPath(project, "decisions"), page)),
    knowledgeActivity: (project: string) => get<KnowledgeActivityDto>(projectPath(project, "knowledge/activity")),
    knowledge: (project: string, query = "") => get<KnowledgeDto>(`${projectPath(project, "knowledge")}${query ? `?q=${encodeURIComponent(query)}` : ""}`),
    knowledgeDoc: (project: string, path: string) => get<KnowledgeDocDto>(`${projectPath(project, "knowledge/doc")}?path=${encodeURIComponent(path)}`),
    team: (project: string) => get<TeamDto>(projectPath(project, "team")),
    analytics: (project: string, period: AnalyticsPeriod = "7d") => get<AnalyticsDto>(`${projectPath(project, "analytics")}?period=${period}`),
    invites: (project: string) => get<InvitesDto>(projectPath(project, "invites")),
    apiKeys: (project: string) => get<ApiKeysDto>(projectPath(project, "api-keys")),
    seatReadiness: (project: string) => get<SeatReadinessDto>(projectPath(project, "seat-readiness")),
    createOrg: (name: string) => send<{ id: string; name: string; warning?: string }>("/orgs", "POST", { name }),
    createProject: (org: string, name: string, repo?: string) => send<{ id: string; name: string; warning?: string }>(`/orgs/${encodeURIComponent(org)}/projects`, "POST", { name, repo: repo || undefined }),
    linkGitHub: (callbackURL: string) => send<{ url: string; redirect: boolean }>("/auth/link-social", "POST", { provider: "github", callbackURL }),
    startGitHubInstall: (org: string, returnTo: string) => send<{ installUrl: string }>(`/orgs/${encodeURIComponent(org)}/github/install`, "POST", { returnTo }),
    createGitHubProject: (org: string, name: string, repositoryId: string) => send<{ id: string; name: string; repo: string; warning?: string }>(`/orgs/${encodeURIComponent(org)}/github/projects`, "POST", { name, repositoryId }),
    deleteProject: (project: string, name: string) => send<{ ok: true }>(`/p/${encodeURIComponent(project)}`, "DELETE", { name }),
    projectInference: (project: string) => get<ProjectInferenceDto>(projectPath(project, "inference")),
    updateProjectInference: (project: string, body: Record<string, unknown>) =>
      send<{ ok: true }>(projectPath(project, "inference"), "PATCH", body),
    createInvite: (project: string, email: string, role: Role = "human") => send<{ email: string; role: Role; inviteUrl: string }>(projectPath(project, "invite"), "POST", { email, role }),
    /** Admin-only: mint a single-use enrollment grant for a role. Returns a ready-to-paste
     * onboarding prompt embedding a one-time token that expires in 15 minutes. */
    mintEnrollment: (project: string, role: string) => send<{ token: string; prompt: string; role: string; expiresAt: number }>(projectPath(project, "enrollments"), "POST", { role }),
    createApiKey: (project: string, input: { name: string; type: "human" | "coder"; clarificationMode?: "form" | "text" }) => send<{ key: string; id: string; name: string; type: "human" | "coder"; start: string | null; createdAt: number | null }>(projectPath(project, "api-keys"), "POST", input),
    updateApiKey: (project: string, id: string, input: { name?: string; clarificationMode?: "form" | "text" } | "form" | "text") => send<{ id: string; name?: string; clarificationMode?: "text" }>(projectPath(project, `api-keys/${encodeURIComponent(id)}`), "PATCH", typeof input === "string" ? { clarificationMode: input } : input),
    revokeApiKey: (project: string, id: string) => send<{ ok: true }>(projectPath(project, `api-keys/${encodeURIComponent(id)}`), "DELETE"),
  };
}

export const dashboardApi = createDashboardApi();
