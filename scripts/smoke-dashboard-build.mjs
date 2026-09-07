import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import express from "express";

const SMOKE_TIMEOUT_MS = 5_000;

function directoryUrl(configuredPath, fallback) {
  return configuredPath ? pathToFileURL(`${resolve(configuredPath)}/`) : fallback;
}

const root = directoryUrl(
  process.env.MEMRACER_DASHBOARD_SMOKE_ROOT,
  new URL("../src/dashboard/web-dist/", import.meta.url),
);
const [html, marketingHtml, js, marketingJs, css] = await Promise.all([
  readFile(new URL("index.html", root), "utf8"),
  readFile(new URL("marketing.html", root), "utf8"),
  stat(new URL("app.js", root)),
  stat(new URL("marketing.js", root)),
  stat(new URL("dashboard.css", root)),
]);

if (!html.includes('src="/dashboard/app.js"')) throw new Error("dashboard build does not use its canonical /dashboard base");
if (!html.includes('href="/dashboard/dashboard.css"')) throw new Error("dashboard build does not link deterministic dashboard.css");
if (!marketingHtml.includes('src="/dashboard/marketing.js"')) {
  throw new Error("marketing build does not use its canonical /dashboard/marketing.js entry");
}
if (!marketingHtml.includes('href="/dashboard/dashboard.css"')) {
  throw new Error("marketing build does not link deterministic dashboard.css");
}
const themeBootstrap = html.indexOf("memracer.react.theme");
const stylesheet = html.indexOf('href="/dashboard/dashboard.css"');
const moduleEntry = html.indexOf('src="/dashboard/app.js"');
if (themeBootstrap < 0 || themeBootstrap > stylesheet || themeBootstrap > moduleEntry) {
  throw new Error("dashboard theme bootstrap must run before stylesheet and module assets");
}
const marketingTheme = marketingHtml.indexOf("memracer.react.theme");
const marketingStylesheet = marketingHtml.indexOf('href="/dashboard/dashboard.css"');
const marketingModule = marketingHtml.indexOf('src="/dashboard/marketing.js"');
if (marketingTheme < 0 || marketingTheme > marketingStylesheet || marketingTheme > marketingModule) {
  throw new Error("marketing theme bootstrap must run before stylesheet and module assets");
}
if (js.size === 0 || marketingJs.size === 0 || css.size === 0) {
  throw new Error("dashboard build emitted an empty asset");
}

const publicRoot = fileURLToPath(directoryUrl(
  process.env.MEMRACER_DASHBOARD_SMOKE_PUBLIC_ROOT,
  new URL("../src/dashboard/public/", import.meta.url),
));
const app = express();
app.get("/dashboard/manifest.json", (_req, res) => res.sendFile("manifest.json", { root: publicRoot }));
app.use("/dashboard/next", (_req, res) => res.sendStatus(404));
app.use("/dashboard", express.static(fileURLToPath(root)));
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve, reject) => {
  server.once("listening", resolve);
  server.once("error", reject);
});
try {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("dashboard smoke server has no TCP address");
  const origin = `http://127.0.0.1:${address.port}`;
  const signal = AbortSignal.timeout(SMOKE_TIMEOUT_MS);
  const responses = await Promise.all([
    fetch(`${origin}/dashboard/`, { signal }),
    fetch(`${origin}/dashboard/app.js`, { signal }),
    fetch(`${origin}/dashboard/marketing.js`, { signal }),
    fetch(`${origin}/dashboard/dashboard.css`, { signal }),
    fetch(`${origin}/dashboard/manifest.json`, { signal }),
    fetch(`${origin}/dashboard/next/`, { signal }),
  ]);
  const [servedHtml] = await Promise.all(responses.map((response, index) => (
    index === 0 ? response.text() : response.arrayBuffer()
  )));
  if (responses.slice(0, 5).some((response) => !response.ok) || responses[5].status !== 404) {
    throw new Error(`dashboard static mount failed: ${responses.map((response) => response.status).join(", ")}`);
  }
  if (!servedHtml.includes("/dashboard/app.js")) throw new Error("served canonical HTML points at the wrong app");
} finally {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.closeAllConnections();
      reject(new Error(`dashboard smoke server did not close within ${SMOKE_TIMEOUT_MS}ms`));
    }, SMOKE_TIMEOUT_MS);
    server.close((error) => {
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    });
  });
}

console.log(
  `dashboard static smoke: /dashboard/ served; /dashboard/next unavailable; app.js ${js.size} bytes; marketing.js ${marketingJs.size} bytes; dashboard.css ${css.size} bytes`,
);
