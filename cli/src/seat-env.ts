import { readFileSync } from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RedeemedSeat } from "./api.js";
import { appendGitignore } from "./harness/gitignore.js";

/** The per-seat env file written into a seat folder (URL + seat token). */
export const SEAT_ENV_FILE = ".memracer.env";

/** A seat's connection context: origin + token, plus its project/role. */
export interface SeatEnv {
  baseUrl: string;
  mcpUrl?: string;
  token: string;
  project?: string;
  role?: string;
}

/** The origin of an mcpUrl (`https://host/mcp` → `https://host`). */
export function originOf(mcpUrl: string): string {
  try {
    return new URL(mcpUrl).origin;
  } catch {
    return mcpUrl.replace(/\/mcp\/?$/, "");
  }
}

/**
 * Write a seat's `.memracer.env` into `folder` (mode 0600) and gitignore it, so
 * an agent in the seat can make its own memracer calls (URL + token) without
 * scraping ~/.memracer/credentials.json (Fix B). The file holds the seat secret.
 */
export async function writeSeatEnv(folder: string, seat: RedeemedSeat): Promise<void> {
  const body =
    `MEMRACER_URL=${originOf(seat.mcpUrl)}\n` +
    `MEMRACER_MCP_URL=${seat.mcpUrl}\n` +
    `MEMRACER_TOKEN=${seat.key}\n` +
    `MEMRACER_PROJECT=${seat.projectId}\n` +
    `MEMRACER_ROLE=${seat.role}\n`;
  const file = join(folder, SEAT_ENV_FILE);
  await writeFile(file, body, { mode: 0o600 });
  // writeFile's mode only applies on create — force 0600 even if it pre-existed.
  await chmod(file, 0o600);
  await appendGitignore(folder, SEAT_ENV_FILE);
}

/** Parse `KEY=VALUE` lines, ignoring blanks and `#` comments. */
function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

/**
 * The seat context when run inside a seat folder (Fix B). Prefers a
 * direnv-loaded process env (MEMRACER_URL + MEMRACER_TOKEN), then a
 * `.memracer.env` file in `cwd`. Returns null when neither yields a URL + token,
 * so the caller can fall back to the operator credential.
 */
export function readSeatEnv(cwd: string, env: NodeJS.ProcessEnv = process.env): SeatEnv | null {
  const fromProcess = fromMap(env as Record<string, string | undefined>);
  if (fromProcess) return fromProcess;
  try {
    return fromMap(parseEnv(readFileSync(join(cwd, SEAT_ENV_FILE), "utf8")));
  } catch {
    return null;
  }
}

function fromMap(m: Record<string, string | undefined>): SeatEnv | null {
  const baseUrl = m.MEMRACER_URL?.replace(/\/$/, "");
  const token = m.MEMRACER_TOKEN;
  if (!baseUrl || !token) return null;
  return {
    baseUrl,
    mcpUrl: m.MEMRACER_MCP_URL,
    token,
    project: m.MEMRACER_PROJECT,
    role: m.MEMRACER_ROLE,
  };
}
