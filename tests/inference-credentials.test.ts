import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import {
  assertProjectInferenceReadyForMcp,
  InferenceConfigError,
  mediatorPolicyEnvFromInference,
  resolveInferenceForProject,
} from "../src/inference-credentials.js";
import {
  mediatorRoutingPolicyFromEnv,
  routeMediatorJob,
} from "../src/mediator/routing-policy.js";
import { encryptSecret } from "../src/secrets.js";

const env = { BETTER_AUTH_SECRET: "test-secret-key-for-byok-envelope-32b" };

async function seedOrgProject(opts?: {
  withKey?: boolean;
  keySecret?: string;
  liteMode?: "use_default" | "override";
  liteModel?: string;
  projectKeyMode?: "inherit" | "org_key" | "project_secret";
  projectSecret?: string;
  allowProjectModels?: boolean;
  projectLiteOverride?: string;
}) {
  const db = openDb(":memory:");
  const orgId = "org-byok";
  const projectId = "proj-byok";
  await db
    .prepare("INSERT INTO orgs (id, name, created_by, created_at) VALUES (?, ?, ?, ?)")
    .run(orgId, "BYOK Org", "user-1", Date.now());
  // Active paid plan required for Frigg (no free tier).
  await db
    .prepare(
      "UPDATE orgs SET plan = ?, seat_quantity = ?, billing_status = ? WHERE id = ?",
    )
    .run("team", 10, "active", orgId);
  await db
    .prepare(
      "INSERT INTO projects (id, name, org_id, created_by, mediator_model) VALUES (?, ?, ?, ?, ?)",
    )
    .run(projectId, "Proj", orgId, "user-1", "z-ai/glm-5.2");

  if (opts?.liteMode === "override" && opts.liteModel) {
    await db
      .prepare("UPDATE orgs SET lite_model_mode = ?, lite_model = ? WHERE id = ?")
      .run("override", opts.liteModel, orgId);
  }
  if (opts?.allowProjectModels) {
    await db
      .prepare("UPDATE orgs SET allow_project_model_override = 1 WHERE id = ?")
      .run(orgId);
    if (opts.projectLiteOverride) {
      await db
        .prepare(
          "UPDATE projects SET lite_model_mode = ?, lite_model = ? WHERE id = ?",
        )
        .run("override", opts.projectLiteOverride, projectId);
    }
  }

  let keyId: string | null = null;
  if (opts?.withKey) {
    const secret = opts.keySecret ?? "sk-or-v1-org-default-key-aaaa";
    const enc = encryptSecret(secret, env);
    keyId = randomUUID();
    await db
      .prepare(
        `INSERT INTO org_provider_keys
          (id, org_id, label, ciphertext, iv, tag, last4, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(keyId, orgId, "default", enc.ciphertext, enc.iv, enc.tag, enc.last4, Date.now(), "user-1");
    await db
      .prepare("UPDATE orgs SET default_provider_key_id = ? WHERE id = ?")
      .run(keyId, orgId);
  }

  if (opts?.projectKeyMode === "project_secret" && opts.projectSecret) {
    const enc = encryptSecret(opts.projectSecret, env);
    await db
      .prepare(
        `UPDATE projects SET provider_key_mode = 'project_secret',
          project_key_ciphertext = ?, project_key_iv = ?, project_key_tag = ?,
          project_key_last4 = ? WHERE id = ?`,
      )
      .run(enc.ciphertext, enc.iv, enc.tag, enc.last4, projectId);
  }

  return { db, orgId, projectId, keyId };
}

describe("resolveInferenceForProject", () => {
  it("fails closed when org has no key and no OPENROUTER_API_KEY is provided", async () => {
    const { db, projectId } = await seedOrgProject({ withKey: false });
    // Host key on process.env alone does not count — resolution uses the env bag.
    process.env.OPENROUTER_API_KEY = "sk-host-must-not-be-used";
    await expect(resolveInferenceForProject(db, projectId, env)).rejects.toBeInstanceOf(
      InferenceConfigError,
    );
    await expect(resolveInferenceForProject(db, projectId, env)).rejects.toThrow(
      /Org Settings/i,
    );
    await db.close();
  });

  it("resolves org default key + use_default models from catalog", async () => {
    const { db, projectId } = await seedOrgProject({
      withKey: true,
      keySecret: "sk-or-v1-org-default-key-zzzz",
    });
    const resolved = await resolveInferenceForProject(db, projectId, env);
    expect(resolved.apiKey).toBe("sk-or-v1-org-default-key-zzzz");
    expect(resolved.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(resolved.liteModel).toBe("google/gemini-3.1-flash-lite");
    expect(resolved.thinkingModel).toBe("z-ai/glm-5.2");
    expect(resolved.keySource).toBe("org_default");
    expect(resolved.keyLast4).toBe("zzzz");
    await db.close();
  });

  it("keeps explicit overrides sticky when catalog defaults would differ", async () => {
    const { db, projectId } = await seedOrgProject({
      withKey: true,
      liteMode: "override",
      liteModel: "my-pinned/lite-v1",
    });
    const resolved = await resolveInferenceForProject(db, projectId, env);
    expect(resolved.liteModel).toBe("my-pinned/lite-v1");
    expect(resolved.liteMode).toBe("override");
    expect(resolved.thinkingModel).toBe("z-ai/glm-5.2");
    await db.close();
  });

  it("applies org lite override to routed cheap arms without env CHEAP_QUALIFIED", async () => {
    const { db, projectId } = await seedOrgProject({
      withKey: true,
      liteMode: "override",
      liteModel: "deepseek/deepseek-v4-flash",
    });
    const resolved = await resolveInferenceForProject(db, projectId, env);
    expect(resolved.liteModel).toBe("deepseek/deepseek-v4-flash");
    expect(resolved.liteMode).toBe("override");

    // Host env says cheap is NOT qualified and pins a different cheap model —
    // the override must still win for routed lite arms.
    const policyEnv = mediatorPolicyEnvFromInference(resolved, {
      ...env,
      MEMRACER_MEDIATOR_POLICY_MODE: "routed",
      MEMRACER_MEDIATOR_CHEAP_QUALIFIED: "0",
      MEMRACER_MEDIATOR_CHEAP_MODEL: "google/gemini-3.1-flash-lite",
    });
    expect(policyEnv.MEMRACER_MEDIATOR_CHEAP_MODEL).toBe("deepseek/deepseek-v4-flash");
    expect(policyEnv.MEMRACER_MEDIATOR_CLASSIFIER_MODEL).toBe("deepseek/deepseek-v4-flash");
    expect(policyEnv.MEMRACER_MEDIATOR_CHEAP_QUALIFIED).toBe("1");

    const policy = mediatorRoutingPolicyFromEnv(policyEnv, resolved.mediatorModel);
    expect(policy.cheapModel).toBe("deepseek/deepseek-v4-flash");
    expect(policy.classifierModel).toBe("deepseek/deepseek-v4-flash");
    expect(policy.cheapQualified).toBe(true);
    expect(routeMediatorJob(policy, "refresh", "routed").model).toBe("deepseek/deepseek-v4-flash");
    expect(routeMediatorJob(policy, "answer", "routed").model).toBe("deepseek/deepseek-v4-flash");
    expect(routeMediatorJob(policy, "groom", "routed", "simple").model).toBe("deepseek/deepseek-v4-flash");
    await db.close();
  });

  it("uses project secret override when set", async () => {
    const { db, projectId } = await seedOrgProject({
      withKey: true,
      keySecret: "sk-org-key",
      projectKeyMode: "project_secret",
      projectSecret: "sk-project-only-key-9999",
    });
    const resolved = await resolveInferenceForProject(db, projectId, env);
    expect(resolved.apiKey).toBe("sk-project-only-key-9999");
    expect(resolved.keySource).toBe("project_secret");
    expect(resolved.keyLast4).toBe("9999");
    await db.close();
  });

  it("honors project model override only when org allows it", async () => {
    const denied = await seedOrgProject({
      withKey: true,
      allowProjectModels: false,
      projectLiteOverride: "should-be-ignored",
    });
    // When flag is false, seed helper still only sets project fields if allow=true.
    await denied.db
      .prepare("UPDATE projects SET lite_model_mode = ?, lite_model = ? WHERE id = ?")
      .run("override", "should-be-ignored", denied.projectId);
    const deniedResolved = await resolveInferenceForProject(denied.db, denied.projectId, env);
    expect(deniedResolved.liteModel).toBe("google/gemini-3.1-flash-lite");
    await denied.db.close();

    const allowed = await seedOrgProject({
      withKey: true,
      allowProjectModels: true,
      projectLiteOverride: "project/lite-override",
    });
    const allowedResolved = await resolveInferenceForProject(allowed.db, allowed.projectId, env);
    expect(allowedResolved.liteModel).toBe("project/lite-override");
    await allowed.db.close();
  });
});

describe("host OPENROUTER fallback", () => {
  it("fails closed by default when org has no key (no allowlist)", async () => {
    const { db, projectId } = await seedOrgProject({ withKey: false });
    await expect(
      resolveInferenceForProject(db, projectId, {
        ...env,
        OPENROUTER_API_KEY: "sk-or-host-fallback-zzzz",
      }),
    ).rejects.toBeInstanceOf(InferenceConfigError);
    await db.close();
  });

  it("uses host key for allowlisted org missing key and preserves org provider", async () => {
    const { db, projectId, orgId } = await seedOrgProject({ withKey: false });
    await db.prepare("UPDATE orgs SET provider_id = ? WHERE id = ?").run("openrouter", orgId);
    const resolved = await resolveInferenceForProject(db, projectId, {
      ...env,
      OPENROUTER_API_KEY: "sk-or-host-fallback-zzzz",
      MEMRACER_HOST_FALLBACK_ORGS: orgId,
    });
    expect(resolved.keySource).toBe("host_fallback");
    expect(resolved.apiKey).toBe("sk-or-host-fallback-zzzz");
    expect(resolved.providerId).toBe("openrouter");
    await db.close();
  });

  it("does not host-fallback for unknown-provider config errors", async () => {
    const { db, projectId, orgId } = await seedOrgProject({ withKey: true });
    await db.prepare("UPDATE orgs SET provider_id = ? WHERE id = ?").run("not-a-provider", orgId);
    await expect(
      resolveInferenceForProject(db, projectId, {
        ...env,
        OPENROUTER_API_KEY: "sk-or-host-fallback-zzzz",
        MEMRACER_HOST_FALLBACK_ORGS: orgId,
      }),
    ).rejects.toThrow(/unknown provider/i);
    await db.close();
  });

  it("stays fail-closed when MEMRACER_BYOK_STRICT=1 even if allowlisted", async () => {
    const { db, projectId, orgId } = await seedOrgProject({ withKey: false });
    await expect(
      resolveInferenceForProject(db, projectId, {
        ...env,
        OPENROUTER_API_KEY: "sk-or-host-fallback-zzzz",
        MEMRACER_HOST_FALLBACK_ORGS: orgId,
        MEMRACER_BYOK_STRICT: "1",
      }),
    ).rejects.toBeInstanceOf(InferenceConfigError);
    await db.close();
  });
});

describe("Frigg requires active paid plan", () => {
  it("rejects unpaid orgs even with a provider key", async () => {
    const { db, projectId, orgId } = await seedOrgProject({ withKey: true });
    await db.prepare("UPDATE orgs SET plan = ?, billing_status = ? WHERE id = ?").run("none", "none", orgId);
    await expect(
      resolveInferenceForProject(db, projectId, {
        ...env,
        OPENROUTER_API_KEY: "sk-host",
      }),
    ).rejects.toThrow(/Subscribe to a plan/i);
    await db.close();
  });
});

describe("null org_id MCP gate exception", () => {
  it("assertProjectInferenceReadyForMcp skips projects without org (internal/fixture)", async () => {
    const db = openDb(":memory:");
    await db.prepare("INSERT INTO projects (id, name, repo, mediator_model) VALUES (?, ?, ?, ?)")
      .run("p-no-org", "P", "r/p", "z-ai/glm-5.2");
    await expect(assertProjectInferenceReadyForMcp(db, "p-no-org", env)).resolves.toBeUndefined();
    await expect(resolveInferenceForProject(db, "p-no-org", env)).rejects.toThrow(/no organization/i);
    await db.close();
  });
});
