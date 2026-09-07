import { assertPinnedGlmCache, contextCacheReport } from "../src/eval/context-cache.js";
import { CONTEXT_CACHE_SCORECARD, promptSavings } from "../src/eval/context-cache-scorecard.js";
import type { MediatorContext } from "../src/mediator/driver.js";
import { OpenRouterDriver, promptCacheEnabled } from "../src/mediator/openrouter.js";

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) throw new Error("OPENROUTER_API_KEY is required for the context-cache canary");

const requestedMode = process.argv.includes("--on") ? "on" : "canary";
const turns = 6;
let sessionId = `memracer:context-cache:${Date.now()}`;
if (requestedMode === "canary") {
  let suffix = 0;
  while (!promptCacheEnabled("canary", 5, `${sessionId}:${suffix}`)) suffix += 1;
  sessionId = `${sessionId}:${suffix}`;
}

const decisions = Array.from({ length: 8 }, (_, index) => ({
  id: index + 1,
  task_id: index < 4 ? 261 : null,
  created_at: Date.now() - index * 1_000,
  kind: "decision",
  summary: `Decision narrative ${index}`,
  rationale: `Preserve this rationale verbatim for decision ${index}.`,
}));
const ctx: MediatorContext = {
  projectId: "memracer",
  projectName: "Memracer",
  queue: [{ id: 261, title: "Context engineering", state: "CLAIMED", priority: 2 }],
  decisions,
  memory: "",
  now: { now_iso: "2026-07-18T06:30:00.000Z", timezone: "America/Denver" },
  lineage: { rootThreadId: 11, ancestors: [], ownThreadIds: [12, 13, 14, 15], siblings: [] },
};
const driver = new OpenRouterDriver(apiKey, "z-ai/glm-5.2", undefined, {
  promptCacheMode: requestedMode,
  promptCacheCanaryPercent: 5,
  cacheSessionId: sessionId,
});

for (let turn = 0; turn < turns; turn += 1) {
  await driver.review(ctx, {
    taskId: 261,
    plan: [
      "Keep lineage history pull-based through thread_read.",
      "Preserve decision rationale verbatim while filtering unrelated records.",
      "Run the 100-case quality gate and verify provider cache reads on turns 2-6.",
    ].join("\n"),
  });
}

const report = contextCacheReport(driver.takeUsage(), turns);
assertPinnedGlmCache(report);
console.log(JSON.stringify({
  mode: requestedMode,
  sessionId,
  stageMeasurements: CONTEXT_CACHE_SCORECARD,
  preCachePromptSavings: promptSavings(),
  liveCacheReport: report,
}, null, 2));
