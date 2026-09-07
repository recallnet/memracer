import type { PrCheck, PrVerifier } from "../../src/github-pr.js";

/**
 * In-process stub for coder_complete. Returns merged-green so MCP integration
 * tests can exercise DONE without hitting GitHub.
 */
export function mergedGreenPrVerifier(
  overrides: Partial<PrCheck> = {},
): PrVerifier {
  return {
    async check(): Promise<PrCheck> {
      return {
        state: "merged-green",
        etag: "test-etag",
        headSha: "deadbeef",
        ...overrides,
      };
    },
  } as PrVerifier;
}
