/**
 * Canonical public host for memracer product surface.
 * Primary: memracer.com. Legacy: memracer.recall.net during transition.
 */

export const PRIMARY_PUBLIC_ORIGIN = "https://memracer.com";
export const LEGACY_PUBLIC_ORIGIN = "https://memracer.recall.net";

export const PUBLIC_ORIGINS = [PRIMARY_PUBLIC_ORIGIN, LEGACY_PUBLIC_ORIGIN] as const;

/** Default MCP endpoint on the primary host. */
export const PRIMARY_MCP_URL = `${PRIMARY_PUBLIC_ORIGIN}/mcp`;

export function resolvePublicUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.MEMRACER_PUBLIC_URL?.trim();
  if (raw) return raw.replace(/\/$/, "");
  // Prefer primary in production-ish boots; localhost for bare local.
  if (env.NODE_ENV === "production" || env.RAILWAY_ENVIRONMENT) {
    return PRIMARY_PUBLIC_ORIGIN;
  }
  return "http://localhost:3000";
}

export function trustedAuthOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const origins = new Set<string>([
    PRIMARY_PUBLIC_ORIGIN,
    LEGACY_PUBLIC_ORIGIN,
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:8787",
    "http://127.0.0.1:8787",
  ]);
  const publicUrl = resolvePublicUrl(env);
  origins.add(publicUrl);
  // Also trust the host of PUBLIC_URL if it differs.
  return [...origins];
}

export function isLegacyPublicHost(host: string | undefined): boolean {
  if (!host) return false;
  const h = host.split(":")[0]?.toLowerCase() ?? "";
  return h === "memracer.recall.net";
}

export function isPrimaryPublicHost(host: string | undefined): boolean {
  if (!host) return false;
  const h = host.split(":")[0]?.toLowerCase() ?? "";
  return h === "memracer.com" || h === "www.memracer.com";
}
