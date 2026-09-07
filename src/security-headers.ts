/**
 * Baseline host self-defense headers for Express (dashboard + API + MCP).
 */

import type { RequestHandler } from "express";

/**
 * CSP tuned for dashboard SPA + marketing.
 * script-src keeps 'unsafe-inline' for static gate pages (signin/join) that
 * ship small inline handlers without a build step. SPA bundles are still
 * same-origin files only — no external script hosts.
 */
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self' https:",
  "form-action 'self'",
].join("; ");

export function securityHeadersMiddleware(opts?: {
  /** When true (HTTPS production), emit HSTS. */
  hsts?: boolean;
}): RequestHandler {
  const hsts = opts?.hsts ?? process.env.NODE_ENV === "production";
  return (_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Content-Security-Policy", CSP);
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (hsts) {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  };
}
