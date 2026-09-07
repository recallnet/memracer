import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { previewResolvedModels } from "../src/dashboard/web/lib/org-settings-models.js";
import { OrgSettingsView } from "../src/dashboard/web/components/org-settings-view.js";
import type { MembershipDto, OrgSettingsDto } from "../src/dashboard/web/data/dto.js";

vi.mock("../src/dashboard/web/data/api.js", () => ({
  dashboardApi: {
    orgSettings: vi.fn(async () => sampleOrgSettings),
    orgRoster: vi.fn(async () => ({ members: [] })),
  },
}));

const sampleOrgSettings: OrgSettingsDto = {
  id: "org_1",
  name: "Acme Fleet",
  createdBy: "owner",
  isAdmin: true,
  projectCreatePolicy: "any_org_member",
  providerId: "openrouter",
  customBaseUrl: null,
  liteModelMode: "use_default",
  liteModel: null,
  thinkingModelMode: "use_default",
  thinkingModel: null,
  resolvedLiteModel: "google/gemini-3.1-flash-lite",
  resolvedThinkingModel: "z-ai/glm-5.2",
  allowProjectModelOverride: false,
  providers: [
    {
      id: "openrouter",
      label: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      defaultLiteModel: "google/gemini-3.1-flash-lite",
      defaultThinkingModel: "z-ai/glm-5.2",
    },
    {
      id: "xai",
      label: "xAI",
      baseUrl: "https://api.x.ai/v1",
      defaultLiteModel: "grok-3-mini",
      defaultThinkingModel: "grok-3",
    },
  ],
  keys: [],
  billing: {
    plan: "team",
    seatQuantity: 4,
    billingStatus: "active",
    billingEmail: "billing@acme.test",
    currentPeriodEnd: Date.UTC(2026, 7, 1),
    stripeConfigured: true,
    hasCustomer: true,
  },
};

const membership: MembershipDto = {
  projectId: "p1",
  projectName: "Alpha",
  role: "admin",
  orgId: "org_1",
  orgName: "Acme Fleet",
  repo: null,
};

describe("previewResolvedModels", () => {
  const provider = {
    id: "openrouter",
    defaultLiteModel: "google/gemini-3.1-flash-lite",
    defaultThinkingModel: "z-ai/glm-5.2",
  };

  it("uses catalog defaults when mode is use_default", () => {
    expect(
      previewResolvedModels({
        provider,
        liteMode: "use_default",
        liteModel: "",
        thinkingMode: "use_default",
        thinkingModel: "",
      }),
    ).toEqual({
      lite: "google/gemini-3.1-flash-lite",
      thinking: "z-ai/glm-5.2",
    });
  });

  it("prefers override text when mode is override", () => {
    expect(
      previewResolvedModels({
        provider,
        liteMode: "override",
        liteModel: "custom/lite",
        thinkingMode: "override",
        thinkingModel: "custom/think",
      }),
    ).toEqual({ lite: "custom/lite", thinking: "custom/think" });
  });
});

describe("OrgSettingsView chrome", () => {
  it("renders org-scoped header and settings-form layout (not invite-form)", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    // Prefetch so SSR path can show body after one render cycle via query cache.
    await client.prefetchQuery({
      queryKey: ["org", "org_1", "settings"],
      queryFn: async () => sampleOrgSettings,
    });
    // Use real query keys shape
    const { queryKeys } = await import("../src/dashboard/web/data/query-keys.js");
    await client.prefetchQuery({
      queryKey: queryKeys.orgSettings("org_1"),
      queryFn: async () => sampleOrgSettings,
    });
    await client.prefetchQuery({
      queryKey: queryKeys.orgRoster("org_1"),
      queryFn: async () => ({ members: [] }),
    });

    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <OrgSettingsView membership={membership} orgProjectCount={3} />
      </QueryClientProvider>,
    );

    expect(html).toContain("Organization");
    expect(html).toContain("Acme Fleet");
    expect(html).toContain("3");
    expect(html).toMatch(/projects/);
    expect(html).toContain("settings-form");
    expect(html).not.toMatch(/class="invite-form"/);
    expect(html).toContain("Catalog default");
    expect(html).toContain("google/gemini-3.1-flash-lite");
    expect(html).toContain("Resolved for Frigg");
    expect(html).toContain("Org installation");
    expect(html).not.toContain("Project repository");
    expect(html).toContain('data-github-scope="org"');
    expect(html).toContain('data-settings-band="status"');
    expect(html).toContain('data-settings-band="configure"');
    expect(html).toContain("settings-plan-card");
    expect(html).toContain("Current plan");
    expect(html).toContain("settings-plan-metrics");
    // status band appears before configure in document order
    expect(html.indexOf('data-settings-band="status"')).toBeLessThan(html.indexOf('data-settings-band="configure"'));
  });

  it("stays org-stable when membership.repo differs (shell project would not reframe form)", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { queryKeys } = await import("../src/dashboard/web/data/query-keys.js");
    await client.prefetchQuery({
      queryKey: queryKeys.orgSettings("org_1"),
      queryFn: async () => sampleOrgSettings,
    });
    await client.prefetchQuery({
      queryKey: queryKeys.orgRoster("org_1"),
      queryFn: async () => ({ members: [] }),
    });

    const p1: MembershipDto = { ...membership, projectId: "p1", projectName: "Alpha", repo: "acme/alpha" };
    const p2: MembershipDto = { ...membership, projectId: "p2", projectName: "Beta", repo: "acme/beta" };

    const html1 = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <OrgSettingsView membership={p1} orgProjectCount={2} />
      </QueryClientProvider>,
    );
    const html2 = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <OrgSettingsView membership={p2} orgProjectCount={2} />
      </QueryClientProvider>,
    );

    expect(html1).toContain("org_1");
    expect(html2).toContain("org_1");
    expect(html1).not.toContain("acme/alpha");
    expect(html2).not.toContain("acme/beta");
    expect(html1).not.toContain("Project repository");
    expect(html2).not.toContain("Project repository");
  });
});
