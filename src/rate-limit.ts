/**
 * Simple fixed-window rate limiter for abuse surfaces (waitlist, MCP 401).
 * In-process only; multi-instance deployments should also use edge CF rules.
 */

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

export interface RateLimiter {
  check(key: string, nowMs?: number): RateLimitResult;
}

export function createFixedWindowLimiter(opts: {
  limit: number;
  windowMs: number;
}): RateLimiter {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  const limit = opts.limit;
  const windowMs = opts.windowMs;

  return {
    check(key: string, nowMs = Date.now()): RateLimitResult {
      const existing = buckets.get(key);
      if (!existing || nowMs >= existing.resetAt) {
        buckets.set(key, { count: 1, resetAt: nowMs + windowMs });
        return { allowed: true, remaining: Math.max(0, limit - 1), retryAfterSec: Math.ceil(windowMs / 1000) };
      }
      if (existing.count >= limit) {
        return {
          allowed: false,
          remaining: 0,
          retryAfterSec: Math.max(1, Math.ceil((existing.resetAt - nowMs) / 1000)),
        };
      }
      existing.count += 1;
      return {
        allowed: true,
        remaining: Math.max(0, limit - existing.count),
        retryAfterSec: Math.max(1, Math.ceil((existing.resetAt - nowMs) / 1000)),
      };
    },
  };
}

/** Waitlist: 5 submissions per IP per minute. */
export const WAITLIST_LIMITER = createFixedWindowLimiter({ limit: 5, windowMs: 60_000 });

/** MCP 401 bursts: 30 failures per IP per minute before 429. */
export const MCP_401_LIMITER = createFixedWindowLimiter({ limit: 30, windowMs: 60_000 });

/** Auth abuse soft limit: 20 /api/auth POSTs per IP per minute. */
export const AUTH_POST_LIMITER = createFixedWindowLimiter({ limit: 20, windowMs: 60_000 });
