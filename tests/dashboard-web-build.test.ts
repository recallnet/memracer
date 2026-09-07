import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("canonical React dashboard build contract", () => {
  it("uses a separate compiler and deterministic production output", () => {
    const vite = readFileSync(join(process.cwd(), "vite.dashboard.config.ts"), "utf8");
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { scripts: Record<string, string>; dependencies?: Record<string, string> };
    const serverTsconfig = JSON.parse(readFileSync(join(process.cwd(), "tsconfig.json"), "utf8")) as {
      exclude: string[]; compilerOptions: { paths: Record<string, string[]> };
    };
    const production = readFileSync(join(process.cwd(), "src/dashboard/web/index.html"), "utf8");
    expect(vite).toContain('base: "/dashboard/"');
    expect(vite).toContain('outDir: "../web-dist"');
    expect(vite).toMatch(/entryFileNames:.*app\.js/);
    expect(vite).toMatch(/marketing\.js/);
    expect(vite).toContain('"dashboard.css"');
    expect(vite).toContain("marketing.html");
    expect(pkg.scripts["typecheck:dashboard"]).toContain("tsconfig.dashboard.json");
    expect(pkg.scripts["build:dashboard"]).toContain("pnpm typecheck:dashboard");
    expect(pkg.scripts["build:dashboard"]).toContain("smoke-dashboard-build.mjs");
    expect(pkg.scripts.test).toMatch(/build:dashboard.*vitest run/);
    expect(serverTsconfig.exclude).toContain("src/dashboard/web");
    expect(serverTsconfig.exclude).toContain("src/dashboard/render");
    expect(serverTsconfig.compilerOptions.paths["@/*"]).toEqual(["src/dashboard/web/*"]);
    expect(pkg.scripts.build).toContain("src/dashboard/web-dist dist/dashboard/web-dist");
    expect(pkg.scripts.build).toContain("src/dashboard/public dist/dashboard/public");
    expect(pkg.scripts.build).not.toContain("build-island");
    expect(pkg.scripts["build:island"]).toBeUndefined();
    expect(pkg.dependencies?.["@visx/scale"]).toBeUndefined();
    expect(pkg.dependencies?.["@visx/shape"]).toBeUndefined();
    expect(production).toContain('rel="manifest" href="/dashboard/manifest.json"');
    expect(production).toContain('rel="apple-touch-icon"');
    expect(production).not.toContain("/dashboard/next");
  });

  it("ships one dashboard entry while retaining auth, PWA, setup, and integrated session sources", () => {
    for (const file of [
      "src/dashboard/public/index.html", "src/dashboard/public/app.js",
      "src/dashboard/public/url-state.js", "src/dashboard/public/island.js",
      "scripts/build-island.mjs",
    ]) expect(existsSync(resolve(file)), file).toBe(false);

    for (const file of [
      "src/dashboard/public/styles.css", "src/dashboard/public/signin.html",
      "src/dashboard/public/join.html", "src/dashboard/public/manifest.json",
      "src/dashboard/public/role-contracts.js",
      "src/dashboard/public/role-contracts.d.ts", "src/dashboard/island/index.tsx",
      "src/dashboard/trace-model.ts",
    ]) expect(existsSync(resolve(file)), file).toBe(true);
    expect(existsSync(resolve("src/dashboard/trace-layout.ts"))).toBe(false);
    expect(existsSync(resolve("src/dashboard/render/CausalGraph.tsx"))).toBe(false);
  });

  it("contains no remote runtime font or CDN requests", () => {
    const files = [
      "src/dashboard/web/index.html", "src/dashboard/web/styles/theme.css",
      "src/dashboard/web/src/main.tsx", "src/dashboard/web/src/app.tsx",
    ];
    for (const file of files) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      expect(source, file).not.toMatch(/https?:\/\//);
      expect(source, file).not.toMatch(/@import\s+url/);
    }
  });

  it("finishes the static smoke after serving an asset larger than the socket buffer", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "memracer-dashboard-smoke-"));
    const buildRoot = join(fixture, "web-dist");
    const publicRoot = join(fixture, "public");
    mkdirSync(buildRoot);
    mkdirSync(publicRoot);
    writeFileSync(join(buildRoot, "index.html"), [
      '<script>localStorage.getItem("memracer.react.theme")</script>',
      '<link rel="stylesheet" href="/dashboard/dashboard.css">',
      '<script type="module" src="/dashboard/app.js"></script>',
    ].join("\n"));
    writeFileSync(join(buildRoot, "marketing.html"), [
      '<script>localStorage.getItem("memracer.react.theme")</script>',
      '<link rel="stylesheet" href="/dashboard/dashboard.css">',
      '<script type="module" src="/dashboard/marketing.js"></script>',
    ].join("\n"));
    writeFileSync(join(buildRoot, "app.js"), Buffer.alloc(2 * 1024 * 1024, "x"));
    writeFileSync(join(buildRoot, "marketing.js"), Buffer.alloc(64 * 1024, "y"));
    writeFileSync(join(buildRoot, "dashboard.css"), "body { color: white; }");
    writeFileSync(join(publicRoot, "manifest.json"), "{}");

    try {
      const result = await execFileAsync(process.execPath, [resolve("scripts/smoke-dashboard-build.mjs")], {
        env: {
          ...process.env,
          MEMRACER_DASHBOARD_SMOKE_ROOT: buildRoot,
          MEMRACER_DASHBOARD_SMOKE_PUBLIC_ROOT: publicRoot,
        },
        timeout: 5_000,
      });
      expect(result.stdout).toContain("dashboard static smoke: /dashboard/ served");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }, 7_000);

  it("provides a resolvable Tailwind v4 shadcn CLI manifest", () => {
    const root = process.cwd();
    const manifest = JSON.parse(readFileSync(join(root, "components.json"), "utf8")) as {
      style: string; rsc: boolean; tsx: boolean; iconLibrary: string;
      tailwind: { config: string; css: string; baseColor: string; cssVariables: boolean; prefix: string };
      aliases: Record<string, string>;
    };
    const dashboardTsconfig = JSON.parse(readFileSync(join(root, "tsconfig.dashboard.json"), "utf8")) as {
      compilerOptions: { paths: Record<string, string[]> };
    };
    const vite = readFileSync(join(root, "vite.dashboard.config.ts"), "utf8");

    expect(manifest).toMatchObject({ style: "new-york", rsc: false, tsx: true, iconLibrary: "lucide" });
    expect(manifest.tailwind).toEqual({
      config: "", css: "src/dashboard/web/styles/theme.css", baseColor: "slate", cssVariables: true, prefix: "",
    });
    expect(existsSync(resolve(root, manifest.tailwind.css))).toBe(true);
    expect(dashboardTsconfig.compilerOptions.paths["@/*"]).toEqual(["src/dashboard/web/*"]);
    expect(vite).toContain('alias: { "@": dashboardRoot }');
    expect(vite).toContain("fileURLToPath(new URL");

    const aliasRoot = resolve(root, dashboardTsconfig.compilerOptions.paths["@/*"][0].replace(/\/\*$/, ""));
    for (const [name, alias] of Object.entries(manifest.aliases)) {
      expect(alias, name).toMatch(/^@\//);
      const target = resolve(aliasRoot, alias.slice(2));
      if (name === "utils") expect(existsSync(`${target}.ts`)).toBe(true);
      else expect(existsSync(target)).toBe(true);
    }
  });
});
