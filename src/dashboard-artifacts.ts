import { readdirSync, statSync } from "node:fs";
import path from "node:path";

export const DASHBOARD_REQUIRED_FILES = [
  "index.html",
  "app.js",
  "marketing.html",
  "marketing.js",
  "dashboard.css",
] as const;

function nonEmptyFile(file: string): boolean {
  try {
    const info = statSync(file);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

function hasNonEmptyAsset(root: string): boolean {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return false;
  }
  return entries.some((entry) => {
    const file = path.join(root, entry);
    try {
      const info = statSync(file);
      return info.isDirectory() ? hasNonEmptyAsset(file) : info.isFile() && info.size > 0;
    } catch {
      return false;
    }
  });
}

/** Return stable, human-readable paths for every missing or empty artifact. */
export function missingDashboardArtifacts(root: string): string[] {
  const missing: string[] = [];
  for (const name of DASHBOARD_REQUIRED_FILES) {
    if (!nonEmptyFile(path.join(root, name))) missing.push(name);
  }
  if (!hasNonEmptyAsset(path.join(root, "assets"))) missing.push("assets");
  return missing;
}

/** Fail before listen() when the release cannot serve the dashboard. */
export function assertDashboardArtifacts(root: string): void {
  const missing = missingDashboardArtifacts(root);
  if (missing.length === 0) return;
  const message = `dashboard artifacts missing or empty at ${root}: ${missing.join(", ")}`;
  console.error(`[critical] ${message}`);
  throw new Error(message);
}
