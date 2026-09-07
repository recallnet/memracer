import { defineConfig } from "vitest/config";

/**
 * Browser suite: Playwright-as-a-library driving the real dashboard in
 * chromium (headless shell, installed via
 * `pnpm exec playwright install chromium --only-shell`).
 *
 * Runs in dev and CI only (`pnpm test:browser`); deliberately excluded from
 * `pnpm test`.
 */
export default defineConfig({
  test: {
    // The canonical React suite is the production acceptance gate.
    include: ["tests/browser/dashboard-react-home.browser.test.ts"],
    fileParallelism: false,
    poolOptions: { threads: { maxThreads: 2 } },
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
