import { describe, expect, it } from "vitest";
import { createDashboardApi } from "../src/dashboard/web/data/api.js";
import { queryKeys } from "../src/dashboard/web/data/query-keys.js";

describe("typed dashboard read API", () => {
  it("preserves every existing GET path and escapes scoped identifiers", async () => {
    const paths: string[] = [];
    const api = createDashboardApi(async <T>(path: string) => { paths.push(path); return {} as T; });
    await Promise.all([
      api.projects(), api.me(), api.session(), api.config(), api.orgRoster("org/a"), api.githubConnection("org/a"), api.invite("a/b"),
      api.queue("a/b"), api.completedTasks("p", { q: "100% done", limit: 25, offset: 50 }), api.warming("p"), api.agents("p"), api.health("p"),
      api.threads("p"), api.thread("p", 4), api.questions("p"), api.attention("p"), api.pushStatus(), api.task("p", 5), api.taskImages("p", 5), api.timeline("p", 5),
      api.conversations("p"), api.conversation("p", 6), api.decisions("p"), api.knowledgeActivity("p"), api.knowledge("p", "a b"),
      api.knowledgeDoc("p", "tech/api.md"), api.team("p"), api.analytics("p"), api.invites("p"), api.apiKeys("p"), api.seatReadiness("p"),
    ]);
    expect(paths).toEqual([
      "/projects", "/me", "/session", "/config", "/orgs/org%2Fa/roster", "/orgs/org%2Fa/github", "/invite/a%2Fb",
      "/p/a%2Fb/queue", "/p/p/tasks/done?q=100%25+done&limit=25&offset=50", "/p/p/warming", "/p/p/agents", "/p/p/health",
      "/p/p/threads", "/p/p/threads/4", "/p/p/questions", "/p/p/attention", "/push/status", "/p/p/tasks/5", "/p/p/tasks/5/images", "/p/p/tasks/5/timeline",
      "/p/p/conversations", "/p/p/conversations/6", "/p/p/decisions", "/p/p/knowledge/activity", "/p/p/knowledge?q=a%20b",
      "/p/p/knowledge/doc?path=tech%2Fapi.md", "/p/p/team", "/p/p/analytics?period=7d", "/p/p/invites", "/p/p/api-keys", "/p/p/seat-readiness",
    ]);
  });

  it("uses project-rooted query keys that can be invalidated together", () => {
    expect(queryKeys.queue("p1").slice(0, 2)).toEqual(queryKeys.project("p1"));
    expect(queryKeys.completedTasks("p1", { q: "needle", limit: 25, offset: 50 })).toEqual([
      "project", "p1", "tasks", "done", { q: "needle", limit: 25, offset: 50 },
    ]);
    expect(queryKeys.task("p1", 12)).toEqual(["project", "p1", "task", 12]);
    expect(queryKeys.taskImages("p1", 12)).toEqual(["project", "p1", "task", 12, "images"]);
    expect(queryKeys.knowledgeActivity("p1")).toEqual(["project", "p1", "knowledge", "activity"]);
    expect(queryKeys.knowledge("p1", "abc")).toEqual(["project", "p1", "knowledge", "abc"]);
    expect(queryKeys.githubConnection("org/a")).toEqual(["org", "org/a", "github"]);
  });

  it("exposes cursor parameters on every paged read", async () => {
    const paths: string[] = [];
    const api = createDashboardApi(async <T>(path: string) => { paths.push(path); return {} as T; });
    await api.queue("p", { cursor: "a/b", limit: 25 });
    await api.warming("p", { limit: 5 });
    await api.threads("p", { cursor: "next" });
    await api.questions("p", { limit: 10 });
    await api.decisions("p", { cursor: "last", limit: 1 });
    expect(paths).toEqual([
      "/p/p/queue?cursor=a%2Fb&limit=25",
      "/p/p/warming?limit=5",
      "/p/p/threads?cursor=next",
      "/p/p/questions?limit=10",
      "/p/p/decisions?cursor=last&limit=1",
    ]);
  });

  it("mintEnrollment posts the role and returns the parsed onboarding grant", async () => {
    const calls: Array<{ path: string; method: string; body: unknown }> = [];
    const grant = { token: "mzr_enrl_secret", prompt: "…memracer enroll mzr_enrl_secret…", role: "human", expiresAt: 1234 };
    const api = createDashboardApi(async <T>() => ({} as T), async <T>(path: string, method: "POST" | "PATCH" | "DELETE", body?: unknown) => {
      calls.push({ path, method, body });
      return grant as T;
    });
    const result = await api.mintEnrollment("org/a", "human");
    expect(calls).toEqual([{ path: "/p/org%2Fa/enrollments", method: "POST", body: { role: "human" } }]);
    expect(result).toEqual(grant);
  });

  it("builds authenticated image URLs without routing binary responses through the JSON API", () => {
    const api = createDashboardApi();
    expect(api.taskImageUrl("p/a", 17)).toBe("/p/p%2Fa/images/17");
  });

  it("preserves the existing administration routes and payloads", async () => {
    const sends: Array<{ path: string; method: string; body: unknown }> = [];
    const api = createDashboardApi(async <T>() => ({} as T), async <T>(path: string, method: "POST" | "PATCH" | "DELETE", body?: unknown) => {
      sends.push({ path, method, body });
      return {} as T;
    });
    await api.createOrg("Acme");
    await api.createProject("org/a", "Factory", "recallnet/memracer");
    await api.linkGitHub("https://example.test/dashboard");
    await api.startGitHubInstall("org/a", "/dashboard?view=team");
    await api.createGitHubProject("org/a", "Factory", "501");
    await api.createInvite("p/a", "ada@example.com");
    await api.mintEnrollment("p/a", "coder");
    await api.createApiKey("p/a", { name: "runner", type: "coder" });
    await api.updateApiKey("p/a", "key/a", "text");
    await api.revokeApiKey("p/a", "key/a");
    await api.deleteProject("p/a", "Factory");
    expect(sends).toEqual([
      { path: "/orgs", method: "POST", body: { name: "Acme" } },
      { path: "/orgs/org%2Fa/projects", method: "POST", body: { name: "Factory", repo: "recallnet/memracer" } },
      { path: "/auth/link-social", method: "POST", body: { provider: "github", callbackURL: "https://example.test/dashboard" } },
      { path: "/orgs/org%2Fa/github/install", method: "POST", body: { returnTo: "/dashboard?view=team" } },
      { path: "/orgs/org%2Fa/github/projects", method: "POST", body: { name: "Factory", repositoryId: "501" } },
      { path: "/p/p%2Fa/invite", method: "POST", body: { email: "ada@example.com", role: "human" } },
      { path: "/p/p%2Fa/enrollments", method: "POST", body: { role: "coder" } },
      { path: "/p/p%2Fa/api-keys", method: "POST", body: { name: "runner", type: "coder" } },
      { path: "/p/p%2Fa/api-keys/key%2Fa", method: "PATCH", body: { clarificationMode: "text" } },
      { path: "/p/p%2Fa/api-keys/key%2Fa", method: "DELETE", body: undefined },
      { path: "/p/p%2Fa", method: "DELETE", body: { name: "Factory" } },
    ]);
  });
});
