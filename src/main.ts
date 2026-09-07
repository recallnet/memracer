import { openDb, openPostgresDb } from "./db.js";
import { fileURLToPath } from "node:url";
import { createApp } from "./server.js";
import { FakeDriver } from "./mediator/fake.js";
import { DEFAULT_MAX_TOKENS, OpenRouterDriver, openRouterOptionsFromEnv } from "./mediator/openrouter.js";
import type { MediatorDriver } from "./mediator/driver.js";
import type { JobRow } from "./mediator/worker.js";
import { JobPolicyLog } from "./mediator/job-policy-log.js";
import { PolicyAwareMediatorDriver } from "./mediator/policy-driver.js";
import {
  createOpenRouterGroomClassifier,
  mediatorRoutingPolicyFromEnv,
  type GroomDifficultyClassifier,
} from "./mediator/routing-policy.js";
import { createImageBlobStoreFromEnv } from "./image-attachments.js";
import { MemoryStore } from "./mediator/memory.js";
import { effectPromiseRunner, makeMediatorRuntime } from "./mediator/effect-runtime.js";
import { installShutdownSignalHandlers, makeGracefulShutdown } from "./graceful-shutdown.js";
import { assertDashboardArtifacts } from "./dashboard-artifacts.js";
import {
  githubAppAuthConfig,
  InstallationTokenProvider,
  lookupInstallationIdForRepo,
} from "./github-app.js";
import { GhTokenSource, PrMergePoller, PrVerifier } from "./github-pr.js";
import { assertBootConfig, loadBootConfig } from "./config.js";
import { mediatorPolicyEnvFromInference, resolveInferenceForProject } from "./inference-credentials.js";

const bootConfig = loadBootConfig(process.env);
assertBootConfig(bootConfig);
// Fail closed: never run production against a Stripe test secret key.
if (process.env.STRIPE_SECRET_KEY?.trim()) {
  const { assertStripeSecretKey } = await import("./billing/stripe.js");
  assertStripeSecretKey(process.env.STRIPE_SECRET_KEY, process.env);
}

const DB_PATH = process.env.MEMRACER_DB_PATH ?? "memracer.db";
const PORT = Number(process.env.PORT ?? process.env.MEMRACER_PORT ?? 8787);
const DRIVER = bootConfig.mediatorDriver;
// Public dashboard base URL. When set, discuss/answer replies carry shareable
// reference links; unset degrades to no links (never an error).
const PUBLIC_URL = process.env.MEMRACER_PUBLIC_URL;
// Outer pipeline timeout. Each OpenRouter retry/backoff operation already
// stops after 180s; this wider bound covers full handler/tool-loop work.
const JOB_TIMEOUT_MS = Number(process.env.MEMRACER_JOB_TIMEOUT_MS ?? 300_000);
assertDashboardArtifacts(fileURLToPath(new URL("./dashboard/web-dist/", import.meta.url)));

// DATABASE_URL selects the Postgres backend; unset means SQLite, the
// default (see docs/postgres-migration.md).
const DATABASE_URL = process.env.DATABASE_URL;
const db = DATABASE_URL ? await openPostgresDb(DATABASE_URL) : openDb(DB_PATH);
await new MemoryStore(db).repairMalformedBodies();
const runtime = makeMediatorRuntime({ db });
const jobPolicyLog = new JobPolicyLog(db);
const groomClassifiers = new Map<string, GroomDifficultyClassifier>();

async function driverFor(projectId: string, job?: JobRow): Promise<MediatorDriver> {
  if (DRIVER === "fake") return new FakeDriver();
  // Prefer org BYOK; host OPENROUTER_API_KEY is a bootstrap fallback unless MEMRACER_BYOK_STRICT=1.
  const creds = await resolveInferenceForProject(db, projectId, process.env);
  const apiKey = creds.apiKey;
  const baseUrl = creds.baseUrl;
  const mediator_model = creds.mediatorModel;
  const options = openRouterOptionsFromEnv(process.env);
  // Cheap/classifier models come from org BYOK resolution; env only supplies budgets/mode.
  // Explicit lite overrides force CHEAP_QUALIFIED so routed cheap arms use the override.
  const policyEnv = mediatorPolicyEnvFromInference(creds, process.env);
  if (!job) {
    return new OpenRouterDriver(apiKey, mediator_model, baseUrl, {
      ...options,
      effectRunner: effectPromiseRunner(runtime),
    });
  }
  const policy = mediatorRoutingPolicyFromEnv(policyEnv, mediator_model);
  const classifierKey = JSON.stringify({
    model: policy.classifierModel,
    maxTokens: policy.budgets.classifier,
    providerIgnore: options.providerIgnore,
    baseUrl,
  });
  let classifier = groomClassifiers.get(classifierKey);
  if (!classifier) {
    classifier = createOpenRouterGroomClassifier({
      apiKey,
      model: policy.classifierModel,
      maxTokens: policy.budgets.classifier,
      providerIgnore: options.providerIgnore,
      baseUrl,
    });
    groomClassifiers.set(classifierKey, classifier);
    if (groomClassifiers.size > 16) {
      const oldest = groomClassifiers.keys().next().value as string | undefined;
      if (oldest !== undefined) groomClassifiers.delete(oldest);
    }
  }
  return new PolicyAwareMediatorDriver({
    projectId,
    job,
    policy,
    classifier,
    recorder: jobPolicyLog,
    prepareRoute: (route) => {
      if (!route.useFlatOptions) return route;
      const reasoning = options.reasoning;
      const telemetryEffort = reasoning === true
        ? "enabled"
        : reasoning === false || reasoning === undefined
          ? "none"
          : "max_tokens" in reasoning
            ? "budgeted"
            : reasoning.effort;
      return {
        ...route,
        telemetryEffort,
        telemetryMaxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      };
    },
    createDriver: (route, observeUsage) => new OpenRouterDriver(apiKey, route.model, baseUrl, {
      ...options,
      ...(route.useFlatOptions ? {} : {
        maxTokens: route.maxTokens,
        reasoning: route.effort === "none" ? false : { effort: route.effort },
      }),
      effectRunner: effectPromiseRunner(runtime),
      cacheSessionId: `memracer:${projectId}:${job.id}`,
      meter: (usage) => {
        observeUsage(usage);
        console.log(`[mediator-completion-usage] ${JSON.stringify({
          job_id: job.id,
          project_id: projectId,
          kind: job.kind,
          policy_model: route.model,
          policy_effort: route.telemetryEffort ?? route.effort,
          policy_max_tokens: route.telemetryMaxTokens ?? route.maxTokens,
          policy_difficulty: route.difficulty ?? null,
          ...usage,
        })}`);
      },
    }),
  });
}

// PR verification is fail-closed: without a token, coder_complete refuses.
// Order: App installation token (per enrolled repo) → MEMRACER_GITHUB_TOKEN → `gh auth token`.
// Boot already validated mission-critical credentials via assertBootConfig.
const appAuth = bootConfig.github.hasAppAuth
  ? githubAppAuthConfig(process.env)
  : null;
const installationTokens = appAuth
  ? new InstallationTokenProvider(appAuth, (repo) => lookupInstallationIdForRepo(db, repo))
  : null;
// Prefer boot-validated token; still allow `gh auth token` when env PAT is unset.
const configuredPat = bootConfig.github.token;
const ghTokens = new GhTokenSource(
  configuredPat
    ? async () => configuredPat
    : undefined,
  installationTokens,
);
const prVerifier = new PrVerifier({ tokens: ghTokens });
if (ghTokens.hasInstallationProvider() && (await ghTokens.hasPatOrGh())) {
  console.log("[github-pr] App installation tokens + PAT/gh available — coder_complete will verify PRs");
} else if (ghTokens.hasInstallationProvider()) {
  console.log("[github-pr] App installation tokens available — coder_complete will verify PRs for enrolled repos");
} else if (await ghTokens.hasPatOrGh()) {
  console.log("[github-pr] PAT/gh token available — coder_complete will verify PRs");
} else {
  // Only reachable under MEMRACER_MEDIATOR_DRIVER=fake (assertBootConfig allows it).
  console.warn(
    "[github-pr] PR verification unavailable — set MEMRACER_GITHUB_APP_ID + MEMRACER_GITHUB_APP_PRIVATE_KEY " +
      "(with enrolled github_project_repos) or MEMRACER_GITHUB_TOKEN / `gh auth` — coder_complete will refuse until configured",
  );
}

const { app, queue, worker } = createApp(db, {
  driverFor,
  runtime,
  publicUrl: PUBLIC_URL,
  imageBlobStore: createImageBlobStoreFromEnv(),
  workerOpts: { jobTimeoutMs: JOB_TIMEOUT_MS },
  prVerifier,
  githubWebhookSecret: bootConfig.github.webhookSecret,
});
// Webhook-primary merge settle is registered in createApp (/api/github/webhooks).
// PrMergePoller is the 5-minute backstop for missed deliveries only.
const prPoller = new PrMergePoller(db, queue, worker, prVerifier);
prPoller.start();
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `memracer listening on http://127.0.0.1:${PORT} (db: ${DATABASE_URL ? "postgres" : DB_PATH}, mediator: ${DRIVER})`,
  );
});
const shutdown = makeGracefulShutdown({ server, worker, runtime, db });
// unref'd backstop poller timer does not keep the process alive; stop on signal for cleanliness.
const stopPoller = () => prPoller.stop();
process.once("SIGINT", stopPoller);
process.once("SIGTERM", stopPoller);
installShutdownSignalHandlers(shutdown);
