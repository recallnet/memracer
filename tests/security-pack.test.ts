import { describe, expect, it } from "vitest";
import { createFixedWindowLimiter, WAITLIST_LIMITER } from "../src/rate-limit.js";
import { securityHeadersMiddleware } from "../src/security-headers.js";

describe("rate-limit fixed window", () => {
  it("allows up to limit then denies", () => {
    const limiter = createFixedWindowLimiter({ limit: 3, windowMs: 60_000 });
    const now = 1_000_000;
    expect(limiter.check("k", now).allowed).toBe(true);
    expect(limiter.check("k", now + 1).allowed).toBe(true);
    expect(limiter.check("k", now + 2).allowed).toBe(true);
    const denied = limiter.check("k", now + 3);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSec).toBeGreaterThan(0);
  });

  it("resets after window", () => {
    const limiter = createFixedWindowLimiter({ limit: 1, windowMs: 1000 });
    expect(limiter.check("r", 0).allowed).toBe(true);
    expect(limiter.check("r", 500).allowed).toBe(false);
    expect(limiter.check("r", 1000).allowed).toBe(true);
  });

  it("exports waitlist limiter with documented 5/min capacity", () => {
    // 5 allowed then deny in same window
    for (let i = 0; i < 5; i++) {
      expect(WAITLIST_LIMITER.check(`wl-test-${Date.now()}`, Date.now()).allowed).toBe(true);
    }
    const ip = `wl-burst-${Date.now()}`;
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) expect(WAITLIST_LIMITER.check(ip, t0).allowed).toBe(true);
    expect(WAITLIST_LIMITER.check(ip, t0).allowed).toBe(false);
  });
});

describe("security headers middleware", () => {
  it("sets baseline defense headers", () => {
    const headers: Record<string, string> = {};
    const mw = securityHeadersMiddleware({ hsts: true });
    let nextCalled = false;
    mw(
      {} as never,
      {
        setHeader: (k: string, v: string) => {
          headers[k] = v;
        },
      } as never,
      () => {
        nextCalled = true;
      },
    );
    expect(nextCalled).toBe(true);
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["Content-Security-Policy"]).toContain("default-src 'self'");
    expect(headers["Strict-Transport-Security"]).toContain("max-age=");
  });
});
