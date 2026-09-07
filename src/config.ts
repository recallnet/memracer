/**
 * Boot-time config for mission-critical GitHub credentials.
 * Silent missing tokens caused orphan complete loops (#457/#460); validate loud.
 */

export interface GithubConfig {
  token: string | null;
  appId: string | null;
  appPrivateKey: string | null;
  webhookSecret: string | null;
  /** MEMRACER_GITHUB_TOKEN present (PAT path). */
  hasPat: boolean;
  /** APP_ID + PRIVATE_KEY both present. */
  hasAppAuth: boolean;
  /** WEBHOOK_SECRET present. */
  hasWebhook: boolean;
  /** Any path that can verify PRs (PAT or App). */
  canVerifyPr: boolean;
}

export interface BootConfig {
  mediatorDriver: string;
  github: GithubConfig;
}

export interface BootValidation {
  fatals: string[];
  warnings: string[];
}

function trim(env: NodeJS.ProcessEnv, key: string): string | null {
  const v = env[key]?.trim();
  return v ? v : null;
}

export function loadGithubConfig(env: NodeJS.ProcessEnv = process.env): GithubConfig {
  const token = trim(env, "MEMRACER_GITHUB_TOKEN");
  const appId = trim(env, "MEMRACER_GITHUB_APP_ID");
  const appPrivateKey = trim(env, "MEMRACER_GITHUB_APP_PRIVATE_KEY");
  const webhookSecret = trim(env, "MEMRACER_GITHUB_WEBHOOK_SECRET");
  const hasPat = token !== null;
  const hasAppAuth = appId !== null && appPrivateKey !== null;
  return {
    token,
    appId,
    appPrivateKey,
    webhookSecret,
    hasPat,
    hasAppAuth,
    hasWebhook: webhookSecret !== null,
    canVerifyPr: hasPat || hasAppAuth,
  };
}

export function loadBootConfig(env: NodeJS.ProcessEnv = process.env): BootConfig {
  return {
    mediatorDriver: (env.MEMRACER_MEDIATOR_DRIVER ?? "openrouter").trim() || "openrouter",
    github: loadGithubConfig(env),
  };
}

/**
 * Validate boot config. Fatal when production cannot verify PRs (unless
 * mediator driver is `fake` for local/test boots).
 */
export function validateBootConfig(cfg: BootConfig): BootValidation {
  const fatals: string[] = [];
  const warnings: string[] = [];
  const g = cfg.github;

  if (!g.canVerifyPr && cfg.mediatorDriver !== "fake") {
    fatals.push(
      "PR verification credentials missing: set MEMRACER_GITHUB_TOKEN " +
        "or both MEMRACER_GITHUB_APP_ID and MEMRACER_GITHUB_APP_PRIVATE_KEY. " +
        "Impact: DONE-gating will refuse all completions.",
    );
  }

  if ((g.appId !== null) !== (g.appPrivateKey !== null)) {
    warnings.push(
      g.appId
        ? "MEMRACER_GITHUB_APP_PRIVATE_KEY is unset while MEMRACER_GITHUB_APP_ID is set — App installation tokens disabled."
        : "MEMRACER_GITHUB_APP_ID is unset while MEMRACER_GITHUB_APP_PRIVATE_KEY is set — App installation tokens disabled.",
    );
  } else if (!g.hasAppAuth) {
    warnings.push(
      "MEMRACER_GITHUB_APP_ID / MEMRACER_GITHUB_APP_PRIVATE_KEY unset — App installation tokens disabled; " +
        "PR verify falls back to MEMRACER_GITHUB_TOKEN / `gh` only.",
    );
  }

  if (!g.hasWebhook) {
    warnings.push(
      "MEMRACER_GITHUB_WEBHOOK_SECRET unset — GitHub webhook settlements disabled; " +
        "AWAITING_MERGE relies on the poller backstop only.",
    );
  }

  return { fatals, warnings };
}

export interface AssertBootIo {
  error?: (msg: string) => void;
  warn?: (msg: string) => void;
  exit?: (code: number) => void;
}

/** Print warnings; on fatals print errors and exit non-zero. */
export function assertBootConfig(cfg: BootConfig, io: AssertBootIo = {}): void {
  const { fatals, warnings } = validateBootConfig(cfg);
  const warn = io.warn ?? ((msg: string) => console.warn(msg));
  const error = io.error ?? ((msg: string) => console.error(msg));
  const exit = io.exit ?? ((code: number) => process.exit(code));

  for (const w of warnings) {
    warn(`[boot-config] WARNING: ${w}`);
  }
  if (fatals.length === 0) return;
  for (const f of fatals) {
    error(`[boot-config] FATAL: ${f}`);
  }
  exit(1);
}
