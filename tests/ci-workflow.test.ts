// tests/ci-workflow.test.ts: content contract for the CI workflow's cost and
// path gates. A GitHub Actions workflow has no runtime in this suite, so we
// assert the load-bearing wiring so the merge-queue-safe gating cannot
// silently drift.
//
// The sharp edge: conditionally skipped jobs feed the aggregate `ci` check a
// merge queue requires. These tests pin cancellation and skip semantics so an
// optimization cannot silently stall or weaken integration coverage.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CI = readFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
const job = (name: string) => CI.match(new RegExp(`^\\s{2}${name}:[\\s\\S]*?(?=^\\s{2}[a-z][a-z-]*:|(?![\\s\\S]))`, "m"))?.[0] ?? "";

describe("CI workflow: cost-smart merge-queue gate", () => {
  it("cancels only superseded runs for the same pull request", () => {
    expect(CI).toMatch(/workflow_dispatch:/);
    expect(CI).toMatch(/group:.*github\.event_name == 'pull_request'.*github\.event\.pull_request\.number.*github\.run_id/);
    expect(CI).toMatch(/cancel-in-progress:\s*\$\{\{ github\.event_name == 'pull_request' \}\}/);
  });

  it("runs required CI on merge-queue refs even when merge_group delivery is missing", () => {
    expect(CI).toMatch(
      /push:\s*\n(?:\s*#[^\n]*\n)*\s*branches:\s*\[main,\s*["']gh-readonly-queue\/main\/\*\*["']\]/,
    );
    expect(CI).toMatch(/merge_group:/); // primary GitHub Actions trigger remains
    const aggregate = CI.match(/^\s{2}ci:[\s\S]*$/m)?.[0] ?? "";
    expect(aggregate).toMatch(/if:\s*always\(\)/);
    expect(aggregate).not.toMatch(/github\.event_name\s*==\s*["']merge_group["']/);
    expect(CI).not.toMatch(/^\s+ref:\s*main\s*$/m); // checkout keeps the event SHA
    expect(CI).toMatch(/speculative SHA/);
  });

  it("the required test job runs the real server and dashboard build gate on every event", () => {
    const source = job("test");
    expect(source).not.toMatch(/^\s+if:/m);
    expect(source).toMatch(/pnpm build[\s\S]*?pnpm test/);
    expect(source).toMatch(/pnpm --dir cli run build[\s\S]*?pnpm --dir cli test/);
    expect(CI).not.toContain("pnpm exec tsc --noEmit");
  });

  it("builds the gitignored canonical React bundle from a fresh checkout before browser acceptance", () => {
    expect(job("browser-test")).toMatch(/pnpm build:dashboard[\s\S]*pnpm test:browser/);
  });

  it("runs every heavy suite on bounded Linux runners", () => {
    for (const jobName of ["test", "test-postgres", "browser-test"]) {
      const source = job(jobName);
      expect(source).toContain("runs-on: ubuntu-latest");
      expect(source).toContain("timeout-minutes: 15");
    }
  });

  it("keeps the Postgres suite fresh-checkout safe through the self-building test command", () => {
    expect(job("test-postgres")).toContain("pnpm test");
    expect(JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts.test)
      .toMatch(/build:dashboard.*vitest run/);
  });

  it("emits independent conservative database and browser path signals", () => {
    expect(CI).toMatch(/outputs:[\s\S]*db:.*steps\.detect\.outputs\.db[\s\S]*web:.*steps\.detect\.outputs\.web/);
    expect(CI).toContain("src/db.ts|src/db/*|src/queue.ts|src/mediator/pipelines.ts|src/dashboard.ts)");
    expect(CI).toContain("tests/helpers/db.ts|tests/helpers/pglite.ts|tests/db*.test.ts|tests/queue-*.test.ts|tests/dashboard-api.test.ts|tests/mediator-pipelines.test.ts)");
    expect(CI).toContain("src/dashboard/public/*|src/dashboard/web/*|tests/dashboard-web-*|tests/browser/*|vite.dashboard.config.ts|tsconfig.dashboard.json|scripts/smoke-dashboard-build.mjs)");
    expect(CI).toContain(".github/workflows/ci.yml|package.json|pnpm-lock.yaml|vitest.config.ts|vitest.browser.config.ts)");
  });

  it("test-postgres is gated on the changes detector", () => {
    expect(CI).toMatch(/^\s{2}test-postgres:/m);
    const source = job("test-postgres");
    expect(source).toMatch(/needs:\s*changes/);
    expect(source).toMatch(/if:\s*needs\.changes\.outputs\.db\s*==\s*'true'/);
  });

  it("browser-test is gated on the web changes signal", () => {
    const source = job("browser-test");
    expect(source).toMatch(/needs:\s*changes/);
    expect(source).toMatch(/if:\s*needs\.changes\.outputs\.web\s*==\s*'true'/);
  });

  it("the detector runs both gated suites on every non-PR integration event", () => {
    expect(CI).toMatch(/merge_group:/);
    expect(CI).toMatch(/github\.event_name.*!=.*pull_request/);
    expect(CI).toMatch(/db=true/);
    expect(CI).toMatch(/web=true/);
  });

  it("the aggregate requires test and treats gated suites as pass when skipped", () => {
    const source = job("ci");
    expect(source).toMatch(/needs:\s*\[test,\s*test-postgres,\s*browser-test\]/);
    expect(source).toMatch(/if:\s*always\(\)/);
    expect(source).toMatch(/needs\.test\.result.*=.*success/);
    expect(source).toMatch(/test-postgres failed/);
    expect(source).toMatch(/browser-test failed/);
    expect(source.match(/success\|skipped/g)?.length).toBe(2);
  });
});
