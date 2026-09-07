import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Ensure `line` is present in `<folder>/.gitignore`, creating the file (and its
 * parent) if needed. Idempotent: an already-present line is left untouched.
 */
export async function appendGitignore(folder: string, line: string): Promise<void> {
  const file = join(folder, ".gitignore");
  let existing = "";
  try {
    existing = await readFile(file, "utf8");
  } catch {
    await mkdir(dirname(file), { recursive: true });
  }
  const lines = existing.split(/\r?\n/).map((l) => l.trim());
  if (lines.includes(line.trim())) return;
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  await appendFile(file, `${prefix}${line}\n`);
}
