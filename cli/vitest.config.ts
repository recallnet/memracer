import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    pool: "forks",
    poolOptions: { forks: { minForks: 1, maxForks: 2 } },
    testTimeout: 15000,
  },
});
