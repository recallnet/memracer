/**
 * Resolve BYOK provider credentials + models for a customer project.
 *
 * Customer orgs fail closed without a usable key (default). Host
 * `OPENROUTER_API_KEY` fallback is allowlisted only: true missing-key errors
 * for orgs listed in `MEMRACER_HOST_FALLBACK_ORGS` (or internal org allowlist),
 * and never for unknown-provider / base-url / corrupt-key config errors.
 * Fallback keeps the org's configured provider and models — it only substitutes
 * the API key material.
 */

import type { Db } from "./db/driver.js";
import {
  type ModelMode,
  type ProviderId,
  isProviderId,
  resolveBaseUrl,
  resolveModels,
} from "./provider-catalog.js";
import { decryptSecret } from "./secrets.js";

export type InferenceConfigReason =
  | "missing_key"
  | "config"
  | "billing"
  | "not_found";

export class InferenceConfigError extends Error {
  readonly code = "inference_config" as const;
  readonly reason: InferenceConfigReason;
  constructor(message: string, reason: InferenceConfigReason = "config") {
    super(message);
    this.name = "InferenceConfigError";
    this.reason = reason;
  }
}

export interface ResolvedInference {
  projectId: string;
  orgId: string;
  providerId: ProviderId;
  baseUrl: string;
  apiKey: string;
  liteModel: string;
  thinkingModel: string;
  /** Effective lite mode after org/project resolution (`override` or `use_default`). */
  liteMode: ModelMode;
  /** Alias for routing policy glm / thinking arm. */
  mediatorModel: string;
  keySource: "org_default" | "org_named" | "project_secret" | "host_fallback";
  keyLabel: string | null;
  keyLast4: string;
}

type OrgRow = {
  id: string;
  provider_id: string | null;
  custom_base_url: string | null;
  lite_model_mode: string | null;
  lite_model: string | null;
  thinking_model_mode: string | null;
  thinking_model: string | null;
  allow_project_model_override: number | null;
  default_provider_key_id: string | null;
  plan: string | null;
  seat_quantity: number | null;
  billing_status: string | null;
};

type ProjectRow = {
  id: string;
  org_id: string | null;
  provider_key_mode: string | null;
  provider_key_id: string | null;
  project_key_ciphertext: string | null;
  project_key_iv: string | null;
  project_key_tag: string | null;
  project_key_last4: string | null;
  lite_model_mode: string | null;
  lite_model: string | null;
  thinking_model_mode: string | null;
  thinking_model: string | null;
  mediator_model: string;
};

type KeyRow = {
  id: string;
  org_id: string;
  label: string;
  ciphertext: string;
  iv: string;
  tag: string;
  last4: string;
};

function asMode(raw: string | null | undefined, fallback: ModelMode = "use_default"): ModelMode {
  return raw === "override" ? "override" : fallback;
}

function actionableNoKey(): InferenceConfigError {
  return new InferenceConfigError(
    "No provider API key configured for this organization. An org admin must add a key in Org Settings.",
    "missing_key",
  );
}

export function isMissingKeyError(err: InferenceConfigError): boolean {
  return err.reason === "missing_key";
}

/** Orgs allowed to use host OPENROUTER when they have no key (bootstrap/internal only). */
export function hostFallbackOrgAllowlisted(
  orgId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.MEMRACER_HOST_FALLBACK_ORGS?.trim();
  if (!raw) return false;
  return raw.split(",").map((s) => s.trim()).filter(Boolean).includes(orgId);
}

async function loadOrgKey(db: Db, orgId: string, keyId: string): Promise<KeyRow> {
  const row = await db
    .prepare(
      `SELECT id, org_id, label, ciphertext, iv, tag, last4
         FROM org_provider_keys WHERE id = ? AND org_id = ?`,
    )
    .get<KeyRow>(keyId, orgId);
  if (!row) {
    throw new InferenceConfigError(
      "Provider key not found. Re-select a key or add a new one in Org Settings.",
      "missing_key",
    );
  }
  return row;
}

/**
 * Host key material only — preserves org provider + model configuration.
 * Allowed solely for missing_key on allowlisted orgs.
 */
async function hostFallback(
  db: Db,
  projectId: string,
  orgId: string,
  env: NodeJS.ProcessEnv,
  cause: InferenceConfigError,
): Promise<ResolvedInference> {
  // Default fail-closed. Allowlist is the only opt-in for host spend.
  if (!hostFallbackOrgAllowlisted(orgId, env)) throw cause;
  // Explicit kill-switch even for allowlisted orgs.
  if (env.MEMRACER_BYOK_STRICT === "1") throw cause;
  if (!isMissingKeyError(cause)) throw cause;

  const hostKey = env.OPENROUTER_API_KEY?.trim();
  if (!hostKey) throw cause;

  // Re-resolve provider/models from org config; only swap the secret.
  const project = await db
    .prepare(
      `SELECT id, org_id, provider_key_mode, provider_key_id,
              project_key_ciphertext, project_key_iv, project_key_tag, project_key_last4,
              lite_model_mode, lite_model, thinking_model_mode, thinking_model, mediator_model
         FROM projects WHERE id = ?`,
    )
    .get<ProjectRow>(projectId);
  if (!project?.org_id) throw cause;
  const org = await db
    .prepare(
      `SELECT id, provider_id, custom_base_url, lite_model_mode, lite_model,
              thinking_model_mode, thinking_model, allow_project_model_override,
              default_provider_key_id, plan, seat_quantity, billing_status
         FROM orgs WHERE id = ?`,
    )
    .get<OrgRow>(orgId);
  if (!org) throw cause;

  const providerRaw = org.provider_id?.trim() || "openrouter";
  if (!isProviderId(providerRaw)) throw cause;
  const providerId = providerRaw;
  let baseUrl: string;
  try {
    baseUrl = resolveBaseUrl(providerId, org.custom_base_url);
  } catch {
    throw cause;
  }
  const allowProjectModels = Number(org.allow_project_model_override ?? 0) === 1;
  const liteMode = allowProjectModels && project.lite_model_mode
    ? asMode(project.lite_model_mode)
    : asMode(org.lite_model_mode);
  const thinkingMode = allowProjectModels && project.thinking_model_mode
    ? asMode(project.thinking_model_mode)
    : asMode(org.thinking_model_mode);
  const liteOverride = allowProjectModels && liteMode === "override"
    ? project.lite_model
    : org.lite_model;
  const thinkingOverride = allowProjectModels && thinkingMode === "override"
    ? project.thinking_model
    : org.thinking_model;
  let models: { liteModel: string; thinkingModel: string };
  try {
    models = resolveModels({
      providerId,
      liteMode,
      liteOverride,
      thinkingMode,
      thinkingOverride,
    });
  } catch {
    throw cause;
  }

  console.warn(
    `[byok-fallback] project=${projectId} org=${orgId}: ${cause.message} Using host key for allowlisted org; provider=${providerId}. Customer orgs must set an org key in Org Settings.`,
  );
  return {
    projectId,
    orgId,
    providerId,
    baseUrl,
    apiKey: hostKey,
    liteModel: models.liteModel,
    thinkingModel: models.thinkingModel,
    liteMode,
    mediatorModel: models.thinkingModel,
    keySource: "host_fallback",
    keyLabel: "host",
    keyLast4: hostKey.slice(-4),
  };
}

export async function resolveInferenceForProject(
  db: Db,
  projectId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedInference> {
  try {
    return await resolveInferenceForProjectStrict(db, projectId, env);
  } catch (err) {
    if (!(err instanceof InferenceConfigError)) throw err;
    // Never host-fallback past billing, missing project, or non-missing-key config.
    if (err.reason !== "missing_key") throw err;
    const project = await db
      .prepare("SELECT org_id FROM projects WHERE id = ?")
      .get<{ org_id: string | null }>(projectId);
    const orgId = project?.org_id;
    if (!orgId) throw err;
    return hostFallback(db, projectId, orgId, env, err);
  }
}

/**
 * MCP edge gate: BYOK (or project_secret) only — never host OPENROUTER fallback.
 *
 * **null org_id exception (internal / test fixtures only):** projects without
 * an organization skip this gate. Customer signup always attaches an org; once
 * `org_id` is set the gate is mandatory. Mediator `resolveInferenceForProject`
 * still requires an org for real inference (throws config error).
 */
export async function assertProjectInferenceReadyForMcp(
  db: Db,
  projectId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const row = await db
    .prepare("SELECT org_id FROM projects WHERE id = ?")
    .get<{ org_id: string | null }>(projectId);
  if (!row) {
    throw new InferenceConfigError(`project not found: ${projectId}`, "not_found");
  }
  // Internal/test fixtures without org: skip MCP gate (documented exception).
  if (!row.org_id) return;
  await resolveInferenceForProjectStrict(db, projectId, env);
}

/** True when the project has a decryptable org key or project_secret (not host). */
export async function projectHasUsableByokInference(
  db: Db,
  projectId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  try {
    await assertProjectInferenceReadyForMcp(db, projectId, env);
    return true;
  } catch (err) {
    if (err instanceof InferenceConfigError) return false;
    throw err;
  }
}

async function resolveInferenceForProjectStrict(
  db: Db,
  projectId: string,
  env: NodeJS.ProcessEnv,
): Promise<ResolvedInference> {
  const project = await db
    .prepare(
      `SELECT id, org_id, provider_key_mode, provider_key_id,
              project_key_ciphertext, project_key_iv, project_key_tag, project_key_last4,
              lite_model_mode, lite_model, thinking_model_mode, thinking_model, mediator_model
         FROM projects WHERE id = ?`,
    )
    .get<ProjectRow>(projectId);
  if (!project) throw new InferenceConfigError(`project not found: ${projectId}`, "not_found");
  if (!project.org_id) {
    throw new InferenceConfigError(
      "Project has no organization. Customer inference requires an org with a provider key in Org Settings.",
      "config",
    );
  }

  const org = await db
    .prepare(
      `SELECT id, provider_id, custom_base_url, lite_model_mode, lite_model,
              thinking_model_mode, thinking_model, allow_project_model_override,
              default_provider_key_id, plan, seat_quantity, billing_status
         FROM orgs WHERE id = ?`,
    )
    .get<OrgRow>(project.org_id);
  if (!org) throw new InferenceConfigError("organization not found for project", "not_found");

  // No free tier: Frigg requires an active Solo/Team/Enterprise subscription.
  const { friggAllowed } = await import("./billing/limits.js");
  if (
    !friggAllowed({
      id: org.id,
      plan: org.plan,
      seat_quantity: org.seat_quantity,
      billing_status: org.billing_status,
    })
  ) {
    throw new InferenceConfigError(
      "Subscribe to a plan in Org Settings before using Frigg. There is no free tier.",
      "billing",
    );
  }

  const providerRaw = org.provider_id?.trim() || "openrouter";
  if (!isProviderId(providerRaw)) {
    throw new InferenceConfigError(`unknown provider: ${providerRaw}`, "config");
  }
  const providerId = providerRaw;

  let baseUrl: string;
  try {
    baseUrl = resolveBaseUrl(providerId, org.custom_base_url);
  } catch (err) {
    throw new InferenceConfigError(err instanceof Error ? err.message : String(err));
  }

  const allowProjectModels = Number(org.allow_project_model_override ?? 0) === 1;
  const liteMode = allowProjectModels && project.lite_model_mode
    ? asMode(project.lite_model_mode)
    : asMode(org.lite_model_mode);
  const thinkingMode = allowProjectModels && project.thinking_model_mode
    ? asMode(project.thinking_model_mode)
    : asMode(org.thinking_model_mode);
  const liteOverride = allowProjectModels && liteMode === "override"
    ? project.lite_model
    : org.lite_model;
  const thinkingOverride = allowProjectModels && thinkingMode === "override"
    ? project.thinking_model
    : org.thinking_model;

  let models: { liteModel: string; thinkingModel: string };
  try {
    models = resolveModels({
      providerId,
      liteMode,
      liteOverride,
      thinkingMode,
      thinkingOverride,
    });
  } catch (err) {
    throw new InferenceConfigError(err instanceof Error ? err.message : String(err));
  }

  const keyMode = project.provider_key_mode ?? "inherit";

  if (keyMode === "project_secret") {
    if (
      !project.project_key_ciphertext
      || !project.project_key_iv
      || !project.project_key_tag
    ) {
      throw actionableNoKey();
    }
    const apiKey = decryptSecret(
      {
        ciphertext: project.project_key_ciphertext,
        iv: project.project_key_iv,
        tag: project.project_key_tag,
      },
      env,
    );
    return {
      projectId,
      orgId: org.id,
      providerId,
      baseUrl,
      apiKey,
      liteModel: models.liteModel,
      thinkingModel: models.thinkingModel,
      liteMode,
      mediatorModel: models.thinkingModel,
      keySource: "project_secret",
      keyLabel: "project",
      keyLast4: project.project_key_last4 ?? "****",
    };
  }

  const keyId =
    keyMode === "org_key" && project.provider_key_id
      ? project.provider_key_id
      : org.default_provider_key_id;
  if (!keyId) throw actionableNoKey();

  const keyRow = await loadOrgKey(db, org.id, keyId);
  const apiKey = decryptSecret(
    { ciphertext: keyRow.ciphertext, iv: keyRow.iv, tag: keyRow.tag },
    env,
  );
  return {
    projectId,
    orgId: org.id,
    providerId,
    baseUrl,
    apiKey,
    liteModel: models.liteModel,
    thinkingModel: models.thinkingModel,
    liteMode,
    mediatorModel: models.thinkingModel,
    keySource: keyMode === "org_key" ? "org_named" : "org_default",
    keyLabel: keyRow.label,
    keyLast4: keyRow.last4,
  };
}

/**
 * Build the env overlay that routes Frigg jobs through org/project model
 * resolution. Explicit lite overrides always qualify the cheap arm so the
 * resolved lite model is not stuck behind MEMRACER_MEDIATOR_CHEAP_QUALIFIED.
 */
export function mediatorPolicyEnvFromInference(
  creds: Pick<ResolvedInference, "liteModel" | "liteMode">,
  processEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const policyEnv: NodeJS.ProcessEnv = {
    ...processEnv,
    MEMRACER_MEDIATOR_CHEAP_MODEL: creds.liteModel,
    MEMRACER_MEDIATOR_CLASSIFIER_MODEL: creds.liteModel,
  };
  if (creds.liteMode === "override") {
    // Admin chose this model; do not leave routed cheap arms on the thinking model.
    policyEnv.MEMRACER_MEDIATOR_CHEAP_QUALIFIED = "1";
  }
  return policyEnv;
}
