import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { spawnSync } from "node:child_process";
import {
  EFFECT_WORKER_SCORECARD,
  measureTypeScriptSource,
  type TypeScriptSourceMetrics,
} from "../src/eval/effect-worker-scorecard.js";

async function measure(path: string): Promise<TypeScriptSourceMetrics> {
  return measureTypeScriptSource(await readFile(resolve(path), "utf8"), path);
}

function verifyQuality(): void {
  for (const args of [["eval"], ["eval", "--pipeline"]]) {
    const result = spawnSync("pnpm", args, { stdio: "inherit" });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

const current = {
  worker: await measure("src/mediator/worker.ts"),
  openRouter: await measure("src/mediator/openrouter.ts"),
};

if (!isDeepStrictEqual(current, EFFECT_WORKER_SCORECARD.candidate.source)) {
  console.error("Effect adoption source metrics changed; remeasure and review the scorecard.");
  console.error(JSON.stringify({ expected: EFFECT_WORKER_SCORECARD.candidate.source, current }, null, 2));
  process.exit(1);
}

if (process.argv.includes("--quality")) verifyQuality();

console.log(JSON.stringify({
  scorecard: EFFECT_WORKER_SCORECARD,
  currentSource: current,
}, null, 2));
