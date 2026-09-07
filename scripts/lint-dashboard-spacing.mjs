import { readFile, readdir } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SPACING_PROPERTY = /^(?:padding|margin)(?:-(?:block|block-start|block-end|inline|inline-start|inline-end|top|right|bottom|left))?$|^(?:gap|row-gap|column-gap)$/i;
const RAW_LENGTH = /-?(?:\d*\.)?\d+(?:px|rem)\b/i;

export function findRawSpacingDeclarations(source, file = "<input>") {
  const violations = [];
  const declarations = /([\w-]+)\s*:\s*([^;{}"']*)(?:;|(?=["'}]))/g;
  for (const match of source.matchAll(declarations)) {
    const property = match[1];
    const value = match[2].trim();
    if (!SPACING_PROPERTY.test(property) || !RAW_LENGTH.test(value)) continue;
    const line = source.slice(0, match.index).split("\n").length;
    violations.push({ file, line, property, value });
  }
  return violations;
}

async function sourceFiles(path) {
  const entries = await readdir(path, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(child));
    else if (entry.isFile() && [".css", ".html"].includes(extname(entry.name))) files.push(child);
  }
  return files;
}

export async function lintDashboardSpacing(paths = ["src/dashboard/public", "src/dashboard/web"]) {
  const files = [];
  for (const path of paths) files.push(...await sourceFiles(resolve(path)));
  const violations = [];
  for (const file of files.sort()) {
    violations.push(...findRawSpacingDeclarations(await readFile(file, "utf8"), file));
  }
  return violations;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const violations = await lintDashboardSpacing(process.argv.slice(2).length > 0 ? process.argv.slice(2) : undefined);
  for (const violation of violations) {
    console.error(`${violation.file}:${violation.line} ${violation.property}: ${violation.value}`);
  }
  if (violations.length > 0) {
    console.error(`dashboard spacing lint failed: ${violations.length} raw px/rem declaration(s)`);
    process.exitCode = 1;
  } else {
    console.log("dashboard spacing lint passed: all padding, margin, and gap declarations use tokens or zero");
  }
}
