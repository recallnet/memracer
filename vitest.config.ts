import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // Browser tests need chromium; they run via vitest.browser.config.ts
    // (pnpm test:browser) so `pnpm test` stays browser-free.
    exclude: [...configDefaults.exclude, "tests/browser/**"],
    // Vitest 3 defaults to the forks pool, so threads.maxThreads is ignored.
    // Bound the active pool directly; the auth-heavy HTTP suites otherwise
    // oversubscribe the host and intermittently drop loopback requests.
    maxWorkers: 2,
    testTimeout: 15000,
  },
});
