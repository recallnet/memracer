import * as React from "react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, KeyRound, Shield } from "lucide-react";
import { dashboardApi } from "../data/api.js";
import { queryKeys } from "../data/query-keys.js";
import type { MembershipDto, OrgBillingDto, OrgSettingsDto } from "../data/dto.js";
import { previewResolvedModels } from "../lib/org-settings-models.js";
import { Button } from "./ui/button.js";
import { Card } from "./ui/card.js";
import { Select } from "./ui/select.js";
import { EmptyState, ErrorState, LoadingState, resolveQueryView } from "./ui/state.js";
import { GitHubConnectionPanel } from "./auxiliary-views.js";

export function isActivePaidBilling(billing: Pick<OrgBillingDto, "plan" | "billingStatus"> | null | undefined): boolean {
  if (!billing) return false;
  if (billing.billingStatus !== "active") return false;
  return billing.plan === "solo" || billing.plan === "team" || billing.plan === "enterprise";
}

/** Paid plan card + Manage billing portal: active or past_due (needs payment recovery). */
export function showBillingPortalCard(
  billing: Pick<OrgBillingDto, "plan" | "billingStatus" | "hasCustomer"> | null | undefined,
): boolean {
  if (!billing) return false;
  const paidPlan = billing.plan === "solo" || billing.plan === "team" || billing.plan === "enterprise";
  if (!paidPlan) return false;
  if (billing.billingStatus === "active") return true;
  // past_due keeps portal so the customer can update payment method.
  return billing.billingStatus === "past_due" && Boolean(billing.hasCustomer);
}

export function billingStateAttr(
  billing: Pick<OrgBillingDto, "plan" | "billingStatus"> | null | undefined,
): "active" | "past_due" | "unpaid" {
  if (!billing) return "unpaid";
  if (billing.billingStatus === "past_due") return "past_due";
  if (isActivePaidBilling(billing)) return "active";
  return "unpaid";
}

export function OrgSettingsView({
  membership,
  orgProjectCount = 0,
}: {
  membership: MembershipDto;
  /** Projects in this org (context only — form is org-scoped). */
  orgProjectCount?: number;
}) {
  const orgId = membership.orgId;
  const client = useQueryClient();
  const settings = useQuery({
    queryKey: queryKeys.orgSettings(orgId ?? ""),
    queryFn: () => dashboardApi.orgSettings(orgId!),
    enabled: Boolean(orgId),
    retry: false,
    refetchOnWindowFocus: true,
  });
  const roster = useQuery({
    queryKey: queryKeys.orgRoster(orgId ?? ""),
    queryFn: () => dashboardApi.orgRoster(orgId!),
    enabled: Boolean(orgId),
    retry: false,
  });

  const [billingBanner, setBillingBanner] = useState<string | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("billing") !== "success") return;
    if (params.get("org") && orgId && params.get("org") !== orgId) return;
    setBillingBanner("Checkout complete. Your plan should appear below after webhooks settle — refresh if still unpaid.");
    void client.invalidateQueries({ queryKey: queryKeys.orgSettings(orgId ?? "") });
    params.delete("billing");
    const next = `${window.location.pathname}?${params.toString()}${window.location.hash}`;
    window.history.replaceState(null, "", next.endsWith("?") ? window.location.pathname : next);
  }, [client, orgId]);

  if (!orgId) {
    return (
      <Card className="settings-view" aria-label="Org settings">
        <EmptyState label="Select a project that belongs to an organization to open Org Settings." />
      </Card>
    );
  }

  const view = resolveQueryView({
    error: settings.isError && !settings.data,
    pending: settings.isPending && !settings.data,
    empty: false,
  });

  return (
    <Card className="settings-view org-settings-view" aria-label="Org settings">
      <header className="team-title">
        <div>
          <span className="section-kicker">Organization</span>
          <h1>{membership.orgName ?? orgId}</h1>
          <p className="org-settings-context">
            Org-level policy, provider, and keys for{" "}
            <b>{orgProjectCount || "its"}</b>
            {orgProjectCount === 1 ? " project" : " projects"}
            {" · "}
            <code>{orgId}</code>
            . Switching projects in this org does not change these values.
          </p>
          <p>
            Customer inference is BYOK only. Project-level model overrides live under{" "}
            <b>Project settings</b>, not here.
          </p>
        </div>
      </header>

      {billingBanner && (
        <p className="settings-seat-banner" role="status">
          {billingBanner}{" "}
          <Button type="button" variant="ghost" size="sm" onClick={() => setBillingBanner(null)}>
            Dismiss
          </Button>
        </p>
      )}

      {view === "error" ? (
        <ErrorState label="Org settings unavailable." retry={() => void settings.refetch()} />
      ) : view === "loading" ? (
        <LoadingState label="Loading org settings…" />
      ) : settings.data ? (
        <OrgSettingsBody
          membership={membership}
          data={settings.data}
          rosterCount={roster.data?.members.length ?? 0}
          onSaved={() => void client.invalidateQueries({ queryKey: queryKeys.orgSettings(orgId) })}
        />
      ) : null}
    </Card>
  );
}

function OrgSettingsBody({
  membership,
  data,
  rosterCount,
  onSaved,
}: {
  membership: MembershipDto;
  data: OrgSettingsDto;
  rosterCount: number;
  onSaved: () => void;
}) {
  const [name, setName] = useState(data.name);
  const [policy, setPolicy] = useState(data.projectCreatePolicy);
  const [providerId, setProviderId] = useState(data.providerId);
  const [customBaseUrl, setCustomBaseUrl] = useState(data.customBaseUrl ?? "");
  const [liteMode, setLiteMode] = useState(data.liteModelMode);
  const [liteModel, setLiteModel] = useState(data.liteModel ?? "");
  const [thinkingMode, setThinkingMode] = useState(data.thinkingModelMode);
  const [thinkingModel, setThinkingModel] = useState(data.thinkingModel ?? "");
  const [allowProjectOverride, setAllowProjectOverride] = useState(data.allowProjectModelOverride);
  const [keyLabel, setKeyLabel] = useState("");
  const [keySecret, setKeySecret] = useState("");
  const [error, setError] = useState("");

  const selectedProvider = useMemo(
    () => data.providers.find((p) => p.id === providerId) ?? null,
    [data.providers, providerId],
  );

  const preview = useMemo(
    () =>
      previewResolvedModels({
        provider: selectedProvider,
        liteMode,
        liteModel,
        thinkingMode,
        thinkingModel,
        serverLite: data.resolvedLiteModel,
        serverThinking: data.resolvedThinkingModel,
      }),
    [
      selectedProvider,
      liteMode,
      liteModel,
      thinkingMode,
      thinkingModel,
      data.resolvedLiteModel,
      data.resolvedThinkingModel,
    ],
  );

  const save = useMutation({
    mutationFn: () =>
      dashboardApi.updateOrgSettings(data.id, {
        name: name.trim(),
        projectCreatePolicy: policy,
        providerId,
        customBaseUrl: providerId === "custom" ? customBaseUrl.trim() : null,
        liteModelMode: liteMode,
        liteModel: liteMode === "override" ? liteModel.trim() : null,
        thinkingModelMode: thinkingMode,
        thinkingModel: thinkingMode === "override" ? thinkingModel.trim() : null,
        allowProjectModelOverride: allowProjectOverride,
      }),
    onSuccess: () => {
      setError("");
      onSaved();
    },
    onError: (err) => setError(String(err)),
  });

  const addKey = useMutation({
    mutationFn: () => dashboardApi.createProviderKey(data.id, keyLabel.trim(), keySecret.trim()),
    onSuccess: () => {
      setKeyLabel("");
      setKeySecret("");
      setError("");
      onSaved();
    },
    onError: (err) => setError(String(err)),
  });

  const deleteKey = useMutation({
    mutationFn: (id: string) => dashboardApi.deleteProviderKey(data.id, id),
    onSuccess: () => {
      setError("");
      onSaved();
    },
    onError: (err) => setError(String(err)),
  });

  const setDefault = useMutation({
    mutationFn: (id: string) => dashboardApi.setDefaultProviderKey(data.id, id),
    onSuccess: () => {
      setError("");
      onSaved();
    },
    onError: (err) => setError(String(err)),
  });

  const providerOptions = data.providers.map((p) => ({ value: p.id, label: p.label }));
  const modeOptions = [
    { value: "use_default", label: "Use catalog default (auto-updates)" },
    { value: "override", label: "Override (sticky model id)" },
  ];

  const submitSave = (event: FormEvent) => {
    event.preventDefault();
    if (!data.isAdmin) return;
    save.mutate();
  };

  const submitKey = (event: FormEvent) => {
    event.preventDefault();
    if (!data.isAdmin || !keyLabel.trim() || !keySecret.trim()) return;
    addKey.mutate();
  };

  const [checkoutPlan, setCheckoutPlan] = useState<"solo" | "team">("team");
  const [checkoutSeats, setCheckoutSeats] = useState(4);
  const billing = data.billing;

  const startCheckout = useMutation({
    mutationFn: () => dashboardApi.billingCheckout(data.id, { plan: checkoutPlan, seats: checkoutSeats }),
    onSuccess: (result) => {
      window.location.href = result.url;
    },
    onError: (err) => setError(String(err)),
  });
  const openPortal = useMutation({
    mutationFn: () => dashboardApi.billingPortal(data.id),
    onSuccess: (result) => {
      window.location.href = result.url;
    },
    onError: (err) => setError(String(err)),
  });

  const planActive = isActivePaidBilling(billing);
  const portalCard = showBillingPortalCard(billing);
  const billingState = billingStateAttr(billing);

  return (
    <div className="team-grid settings-section-stack">
      {!data.isAdmin && (
        <p className="scope-copy" role="status">
          Read-only. Only the org creator can change provider keys and policy.
        </p>
      )}

      {billing && (
        <div className="settings-band" data-settings-band="status">
          <p className="settings-band-label">Status</p>
          <section className="admin-panel" aria-labelledby="org-billing-heading" data-billing-state={billingState}>
            <header className="admin-section-heading">
              <div>
                <h2 id="org-billing-heading">Billing</h2>
                {billingState === "unpaid" && (
                  <p className="scope-copy">
                    Required to invite teammates or run Frigg. Solo $5/seat (≤15) · Team $29/seat. Checkout accepts promo codes. No free tier.
                  </p>
                )}
                {billingState === "active" && (
                  <p className="scope-copy">Active subscription for this organization. Seat and plan changes go through the Stripe customer portal.</p>
                )}
                {billingState === "past_due" && (
                  <p className="scope-copy">
                    Payment past due. Update the payment method in Manage billing to restore invites and Frigg. Expansion stays blocked until the invoice is paid.
                  </p>
                )}
              </div>
            </header>

            {portalCard ? (
              <div className="settings-plan-card" data-testid="current-plan-card" data-plan-active={planActive ? "true" : "false"} data-billing-status={billing.billingStatus}>
                <p className="settings-plan-card-title">Current plan</p>
                <ul className="settings-plan-metrics" aria-label="Plan summary">
                  <li><span>Plan</span><b>{billing.plan}</b></li>
                  <li><span>Seats</span><b>{billing.seatQuantity || "—"}</b></li>
                  <li><span>Status</span><b>{billing.billingStatus}</b></li>
                  {billing.currentPeriodEnd ? (
                    <li><span>Period ends</span><b>{new Date(billing.currentPeriodEnd).toLocaleDateString()}</b></li>
                  ) : null}
                </ul>
                {billing.billingEmail ? <p className="scope-copy">{billing.billingEmail}</p> : null}
                {data.isAdmin && billing.stripeConfigured && (
                  <div className="settings-form-actions">
                    <Button
                      type="button"
                      disabled={openPortal.isPending || !billing.hasCustomer}
                      onClick={() => openPortal.mutate()}
                    >
                      {openPortal.isPending ? "Opening portal…" : "Manage billing"}
                    </Button>
                  </div>
                )}
                {data.isAdmin && billing.stripeConfigured && !billing.hasCustomer && (
                  <p className="scope-copy" role="status">Portal unavailable until a Stripe customer is attached.</p>
                )}
              </div>
            ) : (
              <>
                <div className="settings-plan-card" data-plan-active="false" data-testid="plan-summary-card">
                  <p className="settings-plan-card-title">Plan status</p>
                  <ul className="settings-plan-metrics" aria-label="Plan summary">
                    <li><span>Plan</span><b>{billing.plan}</b></li>
                    <li><span>Seats</span><b>{billing.seatQuantity || "—"}</b></li>
                    <li><span>Status</span><b>{billing.billingStatus}</b></li>
                  </ul>
                  {billing.billingEmail ? <p className="scope-copy">{billing.billingEmail}</p> : null}
                </div>
                {data.isAdmin && billing.stripeConfigured && (
                  <form
                    className="settings-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      startCheckout.mutate();
                    }}
                  >
                    <label>
                      Plan
                      <Select
                        ariaLabel="Billing plan"
                        value={checkoutPlan}
                        onValueChange={(value) => setCheckoutPlan(value as "solo" | "team")}
                        options={[
                          { value: "solo", label: "Solo ($5 / seat, max 15)" },
                          { value: "team", label: "Team ($29 / seat)" },
                        ]}
                      />
                    </label>
                    <label>
                      Seats
                      <input
                        type="number"
                        min={1}
                        max={checkoutPlan === "solo" ? 15 : 100}
                        value={checkoutSeats}
                        onChange={(e) => setCheckoutSeats(Number(e.target.value) || 1)}
                      />
                    </label>
                    <div className="settings-form-actions">
                      <Button type="submit" disabled={startCheckout.isPending}>
                        {startCheckout.isPending ? "Starting Checkout…" : "Upgrade / Checkout"}
                      </Button>
                    </div>
                  </form>
                )}
              </>
            )}
            {data.isAdmin && !billing.stripeConfigured && (
              <p className="scope-copy" role="status">Stripe is not configured on this host.</p>
            )}
          </section>
        </div>
      )}

      <div className="settings-band" data-settings-band="configure">
        <p className="settings-band-label">Configure</p>
      <section className="admin-panel" aria-labelledby="org-identity-heading">
        <header className="admin-section-heading">
          <div>
            <h2 id="org-identity-heading"><Building2 size={16} /> Organization</h2>
            <p className="scope-copy">Name, ownership, and who may create projects in this org.</p>
          </div>
          <Shield size={18} />
        </header>
        <form className="settings-form" onSubmit={submitSave}>
          <label>
            Org name
            <input
              required
              value={name}
              disabled={!data.isAdmin}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <p className="scope-copy">
            Owner: <code>{data.createdBy ?? "unknown"}</code>
            {" · "}
            Directory: <b>{rosterCount}</b> membership rows
          </p>
          <label>
            Who can create projects
            <Select
              ariaLabel="Project create policy"
              value={policy}
              onValueChange={(value) => setPolicy(value as typeof policy)}
              options={[
                { value: "any_org_member", label: "Any org member" },
                { value: "org_admins_only", label: "Org admins only" },
              ]}
              disabled={!data.isAdmin}
            />
          </label>
          {data.isAdmin && (
            <div className="settings-form-actions">
              <Button type="submit" disabled={save.isPending}>
                Save org policy
              </Button>
            </div>
          )}
        </form>
      </section>

      <section className="admin-panel" aria-labelledby="org-github-heading">
        <header className="admin-section-heading">
          <div>
            <h2 id="org-github-heading">GitHub (org installation)</h2>
            <p className="scope-copy">
              Installation is org-level. Per-project repositories are managed under Project settings.
            </p>
          </div>
        </header>
        <GitHubConnectionPanel membership={membership} scope="org" />
      </section>

      <section className="admin-panel" aria-labelledby="org-provider-heading">
        <header className="admin-section-heading">
          <div>
            <h2 id="org-provider-heading">Provider &amp; models</h2>
            <p className="scope-copy">
              OpenAI-compatible endpoint for Frigg across every project in this organization.
            </p>
          </div>
        </header>

        <div className="settings-resolved" role="status" aria-live="polite">
          <b>Resolved for Frigg (preview)</b>
          <p className="scope-copy">
            Lite: <code>{preview.lite || "—"}</code>
            {" · "}
            Thinking: <code>{preview.thinking || "—"}</code>
          </p>
          <p className="settings-catalog-hint">
            Updates as you change provider or mode. Save to persist. Server last saved: lite{" "}
            <code>{data.resolvedLiteModel}</code>, thinking <code>{data.resolvedThinkingModel}</code>.
          </p>
        </div>

        <form className="settings-form" onSubmit={submitSave}>
          <label>
            Provider
            <Select
              ariaLabel="Model provider"
              value={providerId}
              onValueChange={setProviderId}
              options={providerOptions}
              disabled={!data.isAdmin}
            />
          </label>
          {selectedProvider && (
            <p className="settings-catalog-hint">
              Catalog defaults for {selectedProvider.label}: lite{" "}
              <code>{selectedProvider.defaultLiteModel}</code>, thinking{" "}
              <code>{selectedProvider.defaultThinkingModel}</code>
              {selectedProvider.baseUrl ? (
                <>
                  {" · "}base <code>{selectedProvider.baseUrl}</code>
                </>
              ) : null}
            </p>
          )}
          {providerId === "custom" && (
            <label>
              Custom base URL (https)
              <input
                required
                placeholder="https://gateway.example.com/v1"
                value={customBaseUrl}
                disabled={!data.isAdmin}
                onChange={(e) => setCustomBaseUrl(e.target.value)}
              />
            </label>
          )}
          <label>
            Lite model
            <Select
              ariaLabel="Lite model mode"
              value={liteMode}
              onValueChange={(v) => setLiteMode(v as typeof liteMode)}
              options={modeOptions}
              disabled={!data.isAdmin}
            />
          </label>
          <p className="settings-catalog-hint">
            Catalog default: <code>{selectedProvider?.defaultLiteModel ?? "—"}</code>
          </p>
          {liteMode === "override" && (
            <>
              <label>
                Lite model id
                <input
                  required
                  value={liteModel}
                  disabled={!data.isAdmin}
                  placeholder={selectedProvider?.defaultLiteModel ?? "provider/model-id"}
                  onChange={(e) => setLiteModel(e.target.value)}
                />
              </label>
              {selectedProvider && data.isAdmin && (
                <div className="settings-default-chips">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setLiteModel(selectedProvider.defaultLiteModel)}
                  >
                    Use catalog lite default
                  </Button>
                </div>
              )}
            </>
          )}
          <label>
            Thinking model
            <Select
              ariaLabel="Thinking model mode"
              value={thinkingMode}
              onValueChange={(v) => setThinkingMode(v as typeof thinkingMode)}
              options={modeOptions}
              disabled={!data.isAdmin}
            />
          </label>
          <p className="settings-catalog-hint">
            Catalog default: <code>{selectedProvider?.defaultThinkingModel ?? "—"}</code>
          </p>
          {thinkingMode === "override" && (
            <>
              <label>
                Thinking model id
                <input
                  required
                  value={thinkingModel}
                  disabled={!data.isAdmin}
                  placeholder={selectedProvider?.defaultThinkingModel ?? "provider/model-id"}
                  onChange={(e) => setThinkingModel(e.target.value)}
                />
              </label>
              {selectedProvider && data.isAdmin && (
                <div className="settings-default-chips">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setThinkingModel(selectedProvider.defaultThinkingModel)}
                  >
                    Use catalog thinking default
                  </Button>
                </div>
              )}
            </>
          )}
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={allowProjectOverride}
              disabled={!data.isAdmin}
              onChange={(e) => setAllowProjectOverride(e.target.checked)}
            />
            Allow projects to override lite/thinking models (Project settings only)
          </label>
          {data.isAdmin && (
            <div className="settings-form-actions">
              <Button type="submit" disabled={save.isPending}>
                Save provider &amp; models
              </Button>
            </div>
          )}
        </form>
      </section>

      <section className="admin-panel token-panel" aria-labelledby="org-keys-heading">
        <header className="token-panel-heading">
          <div>
            <h2 id="org-keys-heading">Provider API keys</h2>
            <p>
              Inference keys for Frigg (not MCP seats). Secrets are write-only — only last4 is shown after save.
              Without a key, mediator jobs fail closed (or use host fallback when configured).
            </p>
          </div>
          <span className="section-count">
            <b>{data.keys.length}</b>
            <KeyRound size={16} />
          </span>
        </header>
        {data.isAdmin && (
          <form className="settings-form" onSubmit={submitKey}>
            <label>
              Label
              <input
                required
                placeholder="e.g. OpenRouter production"
                value={keyLabel}
                onChange={(e) => setKeyLabel(e.target.value)}
              />
            </label>
            <label>
              API key
              <input
                required
                type="password"
                autoComplete="off"
                placeholder="sk-…"
                value={keySecret}
                onChange={(e) => setKeySecret(e.target.value)}
              />
            </label>
            <div className="settings-form-actions">
              <Button disabled={addKey.isPending}>Add key</Button>
            </div>
          </form>
        )}
        {data.keys.length === 0 ? (
          <EmptyState label="No provider keys yet. Add one to run customer inference." />
        ) : (
          <ul className="access-ledger" aria-label="Provider keys">
            {data.keys.map((key) => (
              <li key={key.id} className="invite-row">
                <span>
                  <b>{key.label}</b>
                  {" · "}
                  <code>…{key.last4}</code>
                  {key.isDefault ? " · default" : ""}
                </span>
                {data.isAdmin && (
                  <span className="token-actions">
                    {!key.isDefault && (
                      <Button
                        variant="ghost"
                        size="sm"
                        type="button"
                        onClick={() => setDefault.mutate(key.id)}
                        disabled={setDefault.isPending}
                      >
                        Make default
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      type="button"
                      onClick={() => deleteKey.mutate(key.id)}
                      disabled={deleteKey.isPending}
                    >
                      Delete
                    </Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      </div>

      {(error || save.isError || addKey.isError) && (
        <p role="alert">{error || String(save.error ?? addKey.error)}</p>
      )}
    </div>
  );
}
