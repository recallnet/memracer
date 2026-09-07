/**
 * Regenerate marketing Product section frames.
 *
 * Usage: pnpm marketing:shots
 *
 * Frame contract: every output PNG is exactly **1440×900** (16:10).
 * Product shots use a fixed viewport (no fullPage). MCP fixtures are
 * screenshot at the same size. Exit non-zero if dimensions or size fail.
 *
 * Boots an in-memory app + dense seed (see scripts/lib/marketing-seed.ts).
 */
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import {
  bootMarketingShotApp,
  PROJECT_ID,
  shutdownMarketingShotApp,
  type MarketingShotServer,
} from "./lib/marketing-seed.js";

const FRAME_W = 1440;
const FRAME_H = 900;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "src/dashboard/public/marketing/shots");
const FIXTURE_DIR = path.join(ROOT, "scripts/marketing-fixtures");

/** Only these files may remain under shots/. */
const REQUIRED = [
  "product-ops-1440x900.png",
  "product-timeline-1440x900.png",
  "product-analytics-1440x900.png",
  "mcp-human-1440x900.png",
  "mcp-coder-1440x900.png",
] as const;

async function applySession(
  context: import("playwright").BrowserContext,
  app: MarketingShotServer,
): Promise<void> {
  const eq = app.sessionCookie.indexOf("=");
  const name = app.sessionCookie.slice(0, eq);
  const value = app.sessionCookie.slice(eq + 1);
  const host = new URL(app.baseUrl);
  await context.addCookies([
    {
      name,
      value,
      domain: host.hostname,
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}

async function forceDark(page: Page): Promise<void> {
  // Must match THEME_STORAGE_KEY in src/dashboard/web/src/app.tsx
  await page.evaluate(() => {
    document.documentElement.setAttribute("data-theme", "dark");
    try {
      localStorage.setItem("memracer.react.theme", "dark");
    } catch {
      /* ignore */
    }
  });
}

async function assertFrame(file: string): Promise<void> {
  const full = path.join(OUT_DIR, file);
  const info = await stat(full);
  if (!info.isFile() || info.size < 1024) {
    throw new Error(`shot empty or missing: ${file} (size=${info.size})`);
  }
  // PNG IHDR: width/height big-endian at bytes 16–23
  const { readFile } = await import("node:fs/promises");
  const buf = await readFile(full);
  if (buf[0] !== 0x89 || buf.toString("ascii", 1, 4) !== "PNG") {
    throw new Error(`${file} is not a PNG`);
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width !== FRAME_W || height !== FRAME_H) {
    throw new Error(`${file} is ${width}×${height}, expected ${FRAME_W}×${FRAME_H}`);
  }
  console.log(`  ok ${file} (${width}×${height}, ${info.size} bytes)`);
}

async function shotViewport(page: Page, file: string): Promise<void> {
  await page.screenshot({
    path: path.join(OUT_DIR, file),
    fullPage: false,
    type: "png",
  });
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  const app = await bootMarketingShotApp();
  const browser = await chromium.launch();

  try {
    const context = await browser.newContext({
      viewport: { width: FRAME_W, height: FRAME_H },
      reducedMotion: "reduce",
      colorScheme: "dark",
    });
    await applySession(context, app);
    const page = await context.newPage();

    // Featured: ops floor — needs-you + queue density in viewport
    await page.goto(
      `${app.baseUrl}/dashboard/?project=${PROJECT_ID}&view=dashboard&sort=priority&direction=asc`,
    );
    await page.locator(".dashboard-shell").waitFor({ state: "visible", timeout: 30_000 });
    await forceDark(page);
    await page.waitForTimeout(700);
    // Keep story near top of ops surface
    await page.evaluate(() => window.scrollTo(0, 0));
    await shotViewport(page, "product-ops-1440x900.png");

    // Timeline moment
    await page.goto(
      `${app.baseUrl}/dashboard/?project=${PROJECT_ID}&view=dashboard&thread=${app.timelineRootThreadId}`,
    );
    await page.locator(".dashboard-shell").waitFor({ state: "visible" });
    await forceDark(page);
    await page.waitForTimeout(600);
    await page.evaluate(() => window.scrollTo(0, 0));
    await shotViewport(page, "product-timeline-1440x900.png");

    // Analytics
    await page.goto(`${app.baseUrl}/dashboard/?project=${PROJECT_ID}&view=team`);
    await page.locator(".dashboard-shell").waitFor({ state: "visible" });
    await forceDark(page);
    await page.waitForTimeout(700);
    await page.evaluate(() => window.scrollTo(0, 0));
    await shotViewport(page, "product-analytics-1440x900.png");

    // MCP fixtures at same frame
    for (const [fixture, out] of [
      ["claude-code-human.html", "mcp-human-1440x900.png"],
      ["claude-code-coder.html", "mcp-coder-1440x900.png"],
    ] as const) {
      const fileUrl = `file://${path.resolve(FIXTURE_DIR, fixture)}`;
      await page.goto(fileUrl);
      await page.waitForTimeout(200);
      await shotViewport(page, out);
    }

    await context.close();

    console.log("Validating frame contract…");
    for (const name of REQUIRED) {
      await assertFrame(name);
    }

    // Remove any leftover dump assets so the 8-shot gallery cannot return
    const keep = new Set<string>([...REQUIRED, ".generated", ".gitkeep"]);
    for (const name of await readdir(OUT_DIR)) {
      if (!keep.has(name)) {
        await unlink(path.join(OUT_DIR, name));
        console.log(`  removed stale ${name}`);
      }
    }

    await writeFile(
      path.join(OUT_DIR, ".generated"),
      `frame=${FRAME_W}x${FRAME_H}\ngenerated ${new Date().toISOString()}\n`,
      "utf8",
    );
    console.log(`All ${REQUIRED.length} frames written (${FRAME_W}×${FRAME_H}) → ${OUT_DIR}`);
  } finally {
    await browser.close();
    await shutdownMarketingShotApp(app);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
