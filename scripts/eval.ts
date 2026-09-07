import { FakeDriver } from "../src/mediator/fake.js";
import { OpenRouterDriver } from "../src/mediator/openrouter.js";
import { PiDriver } from "../src/mediator/pi.js";
import type { MediatorDriver } from "../src/mediator/driver.js";
import { createCostTracker, fetchModelPricing, type CostTracker } from "../src/eval/cost.js";
import { runEval, type Scorecard } from "../src/eval/run.js";
import { answerFixtures, groomFixtures, reviewFixtures } from "../src/eval/fixtures.js";
import { runPipelineEval } from "../src/eval/pipeline.js";
import { runTrajectoryEval } from "../src/eval/trajectory.js";
import { runStochasticEval } from "../src/eval/stochastic.js";
import { makeOpenRouterJudge } from "../src/eval/judge.js";
import { runGoalStructureEval } from "../src/eval/goal-structure.js";
import { runGroomPostureEval } from "../src/eval/groom-posture.js";
import { runSecurityBypassEval } from "../src/eval/security-bypass.js";
import { runOutputReliabilityEval, type OutputReliabilityScorecard } from "../src/eval/output-reliability.js";
import { qualifyMediatorRouting, runRoutingToolQualification } from "../src/eval/routing-qualification.js";
import { runOverClarifyEval, type OverClarifyScorecard } from "../src/eval/over-clarify.js";
import { runOverMintEval, type OverMintScorecard } from "../src/eval/over-mint.js";
import {
  runProjectKnowledgeEval,
  type ProjectKnowledgeScorecard,
} from "../src/eval/project-knowledge.js";
import {
  groomingRubricClassifier,
  makeOpenRouterGroomQualityJudge,
  runGroomQualityEval,
  type GroomQualityScorecard,
} from "../src/eval/groom-quality.js";

interface Args {
  driver: string;
  model: string;
  json: boolean;
  pipeline: boolean;
  trajectory: boolean;
  stochastic: boolean;
  goalStructure: boolean;
  groomPosture: boolean;
  securityBypass: boolean;
  outputReliability: boolean;
  overClarify: boolean;
  overMint: boolean;
  projectKnowledge: boolean;
  groomQuality: boolean;
  routingQualification: boolean;
  baselineModel: string;
  candidateModel: string;
  trials: number;
  judgeModel: string;
}

/** Default judge: a strong model that must differ from the model under test. */
const DEFAULT_JUDGE_MODEL = "anthropic/claude-sonnet-4.5";

function parseArgs(argv: string[]): Args {
  const args: Args = {
    driver: "fake",
    model: "z-ai/glm-5.2",
    json: false,
    pipeline: false,
    trajectory: false,
    stochastic: false,
    goalStructure: false,
    groomPosture: false,
    securityBypass: false,
    outputReliability: false,
    overClarify: false,
    overMint: false,
    projectKnowledge: false,
    groomQuality: false,
    routingQualification: false,
    baselineModel: "z-ai/glm-5.2",
    candidateModel: "google/gemini-3.1-flash-lite",
    trials: 5,
    judgeModel: DEFAULT_JUDGE_MODEL,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--driver") args.driver = argv[++i] ?? "";
    else if (a === "--model") args.model = argv[++i] ?? "";
    else if (a === "--json") args.json = true;
    else if (a === "--pipeline") args.pipeline = true;
    else if (a === "--trajectory") args.trajectory = true;
    else if (a === "--stochastic") args.stochastic = true;
    else if (a === "--goal-structure") args.goalStructure = true;
    else if (a === "--groom-posture") args.groomPosture = true;
    else if (a === "--security-bypass") args.securityBypass = true;
    else if (a === "--output-reliability") args.outputReliability = true;
    else if (a === "--over-clarify") args.overClarify = true;
    else if (a === "--over-mint") args.overMint = true;
    else if (a === "--project-knowledge") args.projectKnowledge = true;
    else if (a === "--groom-quality") args.groomQuality = true;
    else if (a === "--routing-qualification") args.routingQualification = true;
    else if (a === "--baseline-model") args.baselineModel = argv[++i] ?? "";
    else if (a === "--candidate-model") args.candidateModel = argv[++i] ?? "";
    else if (a === "--trials") args.trials = Number(argv[++i] ?? "5");
    else if (a === "--judge-model") args.judgeModel = argv[++i] ?? DEFAULT_JUDGE_MODEL;
    else {
      console.error(`unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return args;
}

interface Threshold {
  name: string;
  value: (c: Scorecard) => number;
  pass: (v: number) => boolean;
  describe: string;
}

const thresholds: Threshold[] = [
  { name: "groom accuracy", value: (c) => c.groom.accuracy, pass: (v) => v >= 0.9, describe: ">= 0.90" },
  { name: "merge precision", value: (c) => c.groom.mergePrecision, pass: (v) => v >= 0.95, describe: ">= 0.95" },
  { name: "merge recall", value: (c) => c.groom.mergeRecall, pass: (v) => v >= 0.8, describe: ">= 0.80" },
  { name: "clarify rate", value: (c) => c.groom.clarifyRate, pass: (v) => v >= 0.8, describe: ">= 0.80" },
  { name: "review accuracy", value: (c) => c.review.accuracy, pass: () => true, describe: "(informational)" },
  { name: "bad-plan approvals", value: (c) => c.review.badPlanApprovals, pass: (v) => v === 0, describe: "== 0" },
  { name: "actionable feedback", value: (c) => c.review.actionableFeedbackRate, pass: (v) => v >= 0.9, describe: ">= 0.90" },
  { name: "answer accuracy", value: (c) => c.answer.accuracy, pass: (v) => v >= 0.9, describe: ">= 0.90" },
  { name: "invalid JSON", value: (c) => c.invalidJsonCount, pass: (v) => v === 0, describe: "== 0" },
  { name: "p95 latency (ms)", value: (c) => c.latency.p95Ms, pass: (v) => v < 20000, describe: "< 20000" },
];

function requireOpenRouterKey(): string {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    console.error(
      "OPENROUTER_API_KEY is not set. Export it (or put it in .env) before running a real-model eval.",
    );
    process.exit(1);
  }
  return key;
}

async function buildDriver(args: Args): Promise<{ driver: MediatorDriver; tracker: CostTracker | null }> {
  if (args.driver === "fake") return { driver: new FakeDriver(), tracker: null };
  if (args.driver === "openrouter" || args.driver === "pi") {
    const key = requireOpenRouterKey();
    const pricing = await fetchModelPricing(args.model);
    if (!pricing) console.error(`warning: no pricing found for model ${args.model}; cost will be null`);
    const tracker = createCostTracker(pricing);
    const meter = (u: { promptTokens: number; completionTokens: number }) => tracker.meter(u);
    const driver =
      args.driver === "pi"
        ? new PiDriver(key, args.model, { meter })
        : new OpenRouterDriver(key, args.model, undefined, { meter });
    return { driver, tracker };
  }
  console.error(`unknown driver "${args.driver}" — expected one of: openrouter, pi, fake`);
  process.exit(1);
}

function groomQualityDriverFor(
  args: Args,
  openRouterOptions?: ConstructorParameters<typeof OpenRouterDriver>[3],
): () => MediatorDriver {
  if (args.driver === "fake") return () => new FakeDriver();
  const key = requireOpenRouterKey();
  if (args.driver === "pi") return () => new PiDriver(key, args.model);
  if (args.driver === "openrouter") return () => new OpenRouterDriver(key, args.model, undefined, openRouterOptions);
  throw new Error(`unknown driver "${args.driver}" — expected one of: openrouter, pi, fake`);
}

function groomQualityOptions(args: Args) {
  if (args.driver === "fake") return { classifier: groomingRubricClassifier };
  const key = requireOpenRouterKey();
  return {
    classifier: groomingRubricClassifier,
    judge: makeOpenRouterGroomQualityJudge(key, args.judgeModel, args.model),
    judgeBudgetUsd: 0.20,
  };
}

function fmt(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(3);
}

function printOverClarify(card: OverClarifyScorecard): void {
  console.log(`\nOver-clarification eval — deterministic/offline, ${card.defaultableCases} defaultable fixtures\n`);
  for (const result of card.perCase) console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.name.padEnd(28)}  ${result.actual}`);
  console.log(`\nclarifications: ${card.clarifications}`);
  console.log(`penalty: ${card.penalty}`);
  console.log(`genuine decision protected: ${card.genuineDecisionProtected ? "yes" : "no"}`);
}

function printOverMint(card: OverMintScorecard): void {
  console.log(`\nOver-mint eval — deterministic/offline, ${card.cases} fixtures\n`);
  for (const result of card.perCase) {
    const trace = result.trace.map((step) => step.kind === "tool" ? step.name : "justify").join(" -> ");
    console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.name.padEnd(34)}  ${trace}`);
    for (const failure of result.failures) console.log(`        - ${failure}`);
  }
  for (const failure of card.promptFailures) console.log(`FAIL  prompt policy: ${failure}`);
  console.log(`\nover-mints: ${card.overMints}`);
  console.log(`penalty: ${card.penalty}`);
}

function printProjectKnowledge(card: ProjectKnowledgeScorecard): void {
  console.log(`\nProject-knowledge eval — deterministic/offline, ${card.cases} cases\n`);
  for (const result of card.perCase) {
    console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.name}`);
    for (const failure of result.failures) console.log(`        - ${failure}`);
  }
  console.log(`\ndomains: ${card.domainCount}`);
}

function printOutputReliability(card: OutputReliabilityScorecard): void {
  console.log(`\nOutput-reliability eval — deterministic/offline, ${card.simulatedMinutes} simulated minutes\n`);
  for (const result of card.perCase) {
    console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.signature.padEnd(18)}  ${result.jobs} jobs / ${result.requests} requests`);
    for (const failure of result.failures) console.log(`        - ${failure}`);
  }
  console.log(`\nfailed jobs: ${card.failedJobs}`);
  console.log(`metered completions: ${card.completionCount}`);
}

function printGroomQuality(card: GroomQualityScorecard): void {
  console.log(`\nGroom-quality eval — ${card.cases} labeled historical cases\n`);
  for (const [name, value] of Object.entries(card.metrics)) {
    console.log(`${name.padEnd(28)} ${(value * 100).toFixed(1)}%`);
  }
  console.log(`pass rate                    ${(card.passRate * 100).toFixed(1)}%`);
  console.log(`judge calls / cost           ${card.judgeCalls} / $${card.judgeCostUsd.toFixed(4)}`);
  console.log(`judge budget exhausted       ${card.judgeBudgetExhausted ? "yes" : "no"}`);
  console.log(`statistical regression       ${card.statisticalGate.regression ? "yes" : "no"}`);
}

/**
 * Pipeline mode: fixtures drive groom/review/answer through the real
 * pipelines + worker (registerPipelines over sqlite) and check DB-level
 * golden expectations — including the two shipped regressions (hallucinated
 * merge targets, groomed-task-in-own-context) that driver-isolation scoring
 * cannot see.
 */
async function runPipelineMode(args: Args): Promise<void> {
  const card = await runPipelineEval(() => {
    // Fresh driver per fixture: each harness owns its driver so state
    // (sessions, meters) never bleeds across cases.
    if (args.driver === "fake") return new FakeDriver();
    const key = requireOpenRouterKey();
    if (args.driver === "pi") return new PiDriver(key, args.model);
    if (args.driver === "openrouter") return new OpenRouterDriver(key, args.model);
    console.error(`unknown driver "${args.driver}" — expected one of: openrouter, pi, fake`);
    process.exit(1);
  });

  if (args.json) {
    console.log(JSON.stringify(card, null, 2));
  } else {
    console.log(`\nPipeline eval — driver: ${args.driver}, ${card.perCase.length} fixtures\n`);
    for (const c of card.perCase) {
      console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name.padEnd(42)}  ${c.ms.toFixed(0)}ms`);
      for (const f of c.failures) console.log(`        - ${f}`);
    }
  }
  if (card.failed > 0) {
    if (!args.json) console.log(`\nRESULT: FAIL (${card.failed} fixture(s))`);
    process.exit(1);
  }
  if (!args.json) console.log("\nRESULT: PASS");
}

/**
 * Trajectory mode: scenarios drive multi-step orchestrator runs through the
 * real Queue + worker + FakeDriver, then the ordered action trajectory is
 * matched against golden references (agentevals) and the primary task's state
 * path is checked for FSM reachability. A negative control asserts the eval
 * catches a wrong action sequence / illegal transition (the #75 park-loop
 * class). Deterministic and offline with the FakeDriver.
 */
async function runTrajectoryMode(args: Args): Promise<void> {
  const card = await runTrajectoryEval(() => {
    if (args.driver === "fake") return new FakeDriver();
    const key = requireOpenRouterKey();
    if (args.driver === "pi") return new PiDriver(key, args.model);
    if (args.driver === "openrouter") return new OpenRouterDriver(key, args.model);
    console.error(`unknown driver "${args.driver}" — expected one of: openrouter, pi, fake`);
    process.exit(1);
  });

  if (args.json) {
    console.log(JSON.stringify(card, null, 2));
  } else {
    console.log(`\nTrajectory eval — driver: ${args.driver}, ${card.perCase.length} scenarios\n`);
    for (const c of card.perCase) {
      console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name.padEnd(48)}  ${c.ms.toFixed(0)}ms`);
      for (const f of c.failures) console.log(`        - ${f}`);
    }
  }
  if (card.failed > 0) {
    if (!args.json) console.log(`\nRESULT: FAIL (${card.failed} scenario(s))`);
    process.exit(1);
  }
  if (!args.json) console.log("\nRESULT: PASS");
}

/**
 * Stochastic mode (Tier B): runs the SAME trajectory scenarios over N real-model
 * trials, reports the τ-bench pass^k reliability metric + a Wilson CI, and grades
 * arbitration quality with an LLM-as-judge (strong model != model under test,
 * temperature 0, per-dimension discrete rubric, pairwise both-orderings with
 * flip→tie). Thresholds SOFT-GATE (report-only) until the judge is calibrated
 * against a human-labeled set, so this ALWAYS exits 0 today — it is nightly
 * signal, never a PR gate. Skips cleanly (exit 0) when OPENROUTER_API_KEY is
 * absent so the nightly workflow stays green without the secret.
 */
async function runStochasticMode(args: Args): Promise<void> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    console.log(
      "skipping stochastic tier: OPENROUTER_API_KEY is not set. This real-model nightly tier " +
        "needs the key (export it locally, or set the repository secret in CI). Exiting 0.",
    );
    return;
  }

  const judgeChat = makeOpenRouterJudge(key, args.judgeModel, args.model);
  const card = await runStochasticEval(() => new OpenRouterDriver(key, args.model), {
    trials: args.trials,
    judge: { chat: judgeChat },
    // No human-labeled calibration set yet → decideGate() returns "soft".
    calibration: {},
  });

  // Report-only thresholds (include margin; never single-run equality).
  const PASS_K1_BAR = 0.9;
  const JUDGE_DIM_BAR = 4; // out of 5
  const breaches: string[] = [];
  if ((card.passK[1] ?? 0) < PASS_K1_BAR) breaches.push(`pass^1 ${(card.passK[1] ?? 0).toFixed(3)} < ${PASS_K1_BAR}`);
  if (card.judge) {
    for (const [dim, v] of Object.entries(card.judge.perDimension)) {
      if (v < JUDGE_DIM_BAR) breaches.push(`judge ${dim} ${v.toFixed(2)} < ${JUDGE_DIM_BAR}`);
    }
  }

  if (args.json) {
    console.log(JSON.stringify(card, null, 2));
  } else {
    console.log(`\nStochastic eval (Tier B) — model: ${args.model}, judge: ${args.judgeModel}, ${card.trials} trials\n`);
    console.log("scenario                                          passes   pass^1  pass^2  pass^3");
    console.log("------------------------------------------------  -------  ------  ------  ------");
    for (const s of card.perScenario) {
      const k = (n: number) => (s.passK[n] === undefined ? "  -  " : s.passK[n]!.toFixed(2));
      console.log(`${s.name.padEnd(48)}  ${`${s.passes}/${s.trials}`.padEnd(7)}  ${k(1)}    ${k(2)}    ${k(3)}`);
    }
    console.log(`\naggregate pass^1=${(card.passK[1] ?? 0).toFixed(3)} pass^2=${(card.passK[2] ?? 0).toFixed(3)} pass^3=${(card.passK[3] ?? 0).toFixed(3)}`);
    console.log(`pooled pass-rate 95% CI: [${card.ci.low.toFixed(3)}, ${card.ci.high.toFixed(3)}]`);
    if (card.judge) {
      console.log(`\njudge per-dimension (1-5):`);
      for (const [dim, v] of Object.entries(card.judge.perDimension)) console.log(`  ${dim.padEnd(24)} ${v.toFixed(2)}`);
      console.log(`judge pairwise vs golden: candidate=${card.judge.pairwise.candidate} reference=${card.judge.pairwise.reference} tie=${card.judge.pairwise.tie}`);
    }
    console.log(`\ngate: ${card.gate.mode.toUpperCase()} — ${card.gate.reason}`);
    if (breaches.length > 0) console.log(`threshold breaches (report-only under soft-gate): ${breaches.join("; ")}`);
    else console.log(`thresholds: all clear`);
  }

  // Hard-gate only once the judge is calibrated; today the gate is soft, so a
  // breach is reported but never fails the run.
  if (card.gate.mode === "hard" && breaches.length > 0) {
    if (!args.json) console.log(`\nRESULT: FAIL (hard-gate: ${breaches.join(", ")})`);
    process.exit(1);
  }
  if (!args.json) console.log(`\nRESULT: PASS (soft-gate — report-only)`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.routingQualification) {
    if (args.driver !== "openrouter") {
      throw new Error("routing qualification requires --driver openrouter");
    }
    const baselineArgs = { ...args, model: args.baselineModel };
    const candidateArgs = { ...args, model: args.candidateModel };
    // Keep the two 100-case provider runs serial. Qualification is an
    // operator gate, not a latency-sensitive path, and parallel cohorts would
    // add avoidable provider contention to the comparison.
    const reliability = await runOutputReliabilityEval({ simulatedMinutes: 60 });
    const baseline = await runGroomQualityEval(
      groomQualityDriverFor(baselineArgs),
      groomQualityOptions(baselineArgs),
    );
    const candidate = await runGroomQualityEval(
      groomQualityDriverFor(candidateArgs, { reasoning: false, maxTokens: 8_192 }),
      groomQualityOptions(candidateArgs),
    );
    const candidateTools = {
      off: await runRoutingToolQualification(new OpenRouterDriver(
        requireOpenRouterKey(), args.candidateModel, undefined,
        { reasoning: false, maxTokens: 8_192 },
      )),
      low: await runRoutingToolQualification(new OpenRouterDriver(
        requireOpenRouterKey(), args.candidateModel, undefined,
        { reasoning: { effort: "low" }, maxTokens: 8_192 },
      )),
    };
    const decision = qualifyMediatorRouting({
      baseline,
      candidate,
      reliability: { jobs: reliability.simulatedMinutes, failedJobs: reliability.failedJobs },
      candidateTools,
    });
    const report = {
      baseline_model: args.baselineModel,
      candidate_model: args.candidateModel,
      baseline_pass_rate: baseline.passRate,
      candidate_pass_rate: candidate.passRate,
      output_reliability: `${reliability.simulatedMinutes - reliability.failedJobs}/${reliability.simulatedMinutes}`,
      candidate_tool_probes: candidateTools,
      ...decision,
    };
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`Routing qualification: ${decision.qualified ? "PASS" : "FAIL"}`);
      console.log(`${args.baselineModel}: ${(baseline.passRate * 100).toFixed(1)}%`);
      console.log(`${args.candidateModel}: ${(candidate.passRate * 100).toFixed(1)}%`);
      console.log(`output reliability: ${report.output_reliability}`);
      for (const reason of decision.reasons) console.log(`- ${reason}`);
      if (decision.qualified) {
        console.log("Eligible setting: MEMRACER_MEDIATOR_CHEAP_QUALIFIED=true");
      }
    }
    if (!decision.qualified) process.exit(1);
    return;
  }
  if (args.outputReliability) {
    const card = await runOutputReliabilityEval();
    if (args.json) console.log(JSON.stringify(card, null, 2));
    else {
      printOutputReliability(card);
      console.log(`\nRESULT: ${card.failedJobs === 0 ? "PASS" : `FAIL (${card.failedJobs})`}`);
    }
    if (card.failedJobs > 0) process.exit(1);
    return;
  }
  if (args.groomQuality) {
    const card = await runGroomQualityEval(groomQualityDriverFor(args), groomQualityOptions(args));
    if (args.json) console.log(JSON.stringify(card, null, 2));
    else {
      printGroomQuality(card);
      const qualityFailure = card.judgeBudgetExhausted || card.statisticalGate.regression;
      console.log(`\nRESULT: ${qualityFailure ? "FAIL (groom-quality gate)" : "PASS"}`);
    }
    if (card.judgeBudgetExhausted || card.statisticalGate.regression) process.exit(1);
    return;
  }
  if (args.projectKnowledge) {
    const card = await runProjectKnowledgeEval();
    if (args.json) console.log(JSON.stringify(card, null, 2));
    else {
      printProjectKnowledge(card);
      console.log(`\nRESULT: ${card.failed === 0 ? "PASS" : `FAIL (${card.failed})`}`);
    }
    if (card.failed > 0) process.exit(1);
    return;
  }
  if (args.overMint) {
    const card = await runOverMintEval();
    if (args.json) console.log(JSON.stringify(card, null, 2));
    else {
      printOverMint(card);
      console.log(`\nRESULT: ${card.failed === 0 ? "PASS" : `FAIL (${card.failed})`}`);
    }
    if (card.failed > 0) process.exit(1);
    return;
  }
  if (args.overClarify) {
    const card = await runOverClarifyEval();
    if (args.json) console.log(JSON.stringify(card, null, 2));
    else {
      printOverClarify(card);
      console.log(`\nRESULT: ${card.failed === 0 ? "PASS" : `FAIL (${card.failed})`}`);
    }
    if (card.failed > 0) process.exit(1);
    return;
  }
  if (args.securityBypass) {
    const card = await runSecurityBypassEval();
    if (args.json) console.log(JSON.stringify(card, null, 2));
    else {
      console.log(`\nSecurity bypass eval — deterministic/offline, ${card.perCase.length} fixtures\n`);
      for (const result of card.perCase) {
        console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.name.padEnd(30)}  ${result.actual}`);
        for (const failure of result.failures) console.log(`        - ${failure}`);
      }
      for (const failure of card.promptFailures) console.log(`FAIL  prompt policy: ${failure}`);
      console.log(`\nRESULT: ${card.failed === 0 ? "PASS" : `FAIL (${card.failed})`}`);
    }
    if (card.failed > 0) process.exit(1);
    return;
  }
  if (args.groomPosture) {
    const card = await runGroomPostureEval();
    if (args.json) console.log(JSON.stringify(card, null, 2));
    else {
      console.log(`\nGroom posture eval — deterministic/offline, ${card.perCase.length} fixtures\n`);
      for (const result of card.perCase) {
        console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.name.padEnd(28)}  ${result.actual}`);
        for (const failure of result.failures) console.log(`        - ${failure}`);
      }
      for (const failure of card.promptFailures) console.log(`FAIL  prompt policy: ${failure}`);
      console.log(`\nRESULT: ${card.failed === 0 ? "PASS" : `FAIL (${card.failed})`}`);
    }
    if (card.failed > 0) process.exit(1);
    return;
  }
  if (args.goalStructure) {
    const card = await runGoalStructureEval();
    if (args.json) console.log(JSON.stringify(card, null, 2));
    else {
      console.log(`\nGoal structure eval — deterministic/offline, ${card.perCase.length} fixtures\n`);
      for (const result of card.perCase) {
        console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.name.padEnd(32)}  ${result.actual}`);
        for (const failure of result.failures) console.log(`      - ${failure}`);
      }
      console.log(`\nRESULT: ${card.failed === 0 ? "PASS" : `FAIL (${card.failed} fixture(s))`}`);
    }
    if (card.failed > 0) process.exit(1);
    return;
  }
  if (args.stochastic) return runStochasticMode(args);
  if (args.trajectory) return runTrajectoryMode(args);
  if (args.pipeline) return runPipelineMode(args);
  const jobCount = groomFixtures.length + reviewFixtures.length + answerFixtures.length;

  const { driver, tracker } = await buildDriver(args);

  const card = await runEval(driver, {
    costPer100Jobs: () => tracker?.costPer100Jobs(jobCount) ?? null,
  });
  const overClarify = await runOverClarifyEval();
  const overMint = await runOverMintEval();
  const projectKnowledge = await runProjectKnowledgeEval();
  const outputReliability = await runOutputReliabilityEval();
  const groomQuality = await runGroomQualityEval(groomQualityDriverFor(args), groomQualityOptions(args));

  if (args.json) {
    console.log(JSON.stringify({ mediator: card, overClarify, overMint, projectKnowledge, outputReliability, groomQuality }, null, 2));
  } else {
    console.log(`\nMediator eval — driver: ${args.driver}, model: ${args.model}, ${jobCount} cases\n`);
    console.log("metric               value    threshold");
    console.log("-------------------  -------  ----------");
    for (const t of thresholds) {
      const v = t.value(card);
      const mark = t.pass(v) ? "PASS" : "FAIL";
      console.log(`${t.name.padEnd(19)}  ${fmt(v).padEnd(7)}  ${t.describe.padEnd(10)}  ${t.describe === "(informational)" ? "" : mark}`);
    }
    console.log(`p50 latency (ms)     ${fmt(card.latency.p50Ms)}`);
    console.log(`cost per 100 jobs    ${card.costPer100Jobs === null ? "n/a (no meter data)" : `$${card.costPer100Jobs.toFixed(4)}`}`);
    const failures = card.perCase.filter((c) => !c.ok);
    if (failures.length > 0) {
      console.log(`\nfailed cases (${failures.length}):`);
      for (const c of failures) console.log(`  ${c.name}: expected ${c.expected}, got ${c.got}`);
    }
    printOverClarify(overClarify);
    printOverMint(overMint);
    printProjectKnowledge(projectKnowledge);
    printOutputReliability(outputReliability);
    printGroomQuality(groomQuality);
  }

  const failed = thresholds.filter((t) => !t.pass(t.value(card)));
  if (overClarify.failed > 0) {
    if (!args.json) console.log(`\nRESULT: FAIL (over-clarification penalty ${overClarify.penalty})`);
    process.exit(1);
  }
  if (overMint.failed > 0) {
    if (!args.json) console.log(`\nRESULT: FAIL (over-mint penalty ${overMint.penalty})`);
    process.exit(1);
  }
  if (projectKnowledge.failed > 0) {
    if (!args.json) console.log(`\nRESULT: FAIL (project-knowledge ${projectKnowledge.failed})`);
    process.exit(1);
  }
  if (outputReliability.failedJobs > 0) {
    if (!args.json) console.log(`\nRESULT: FAIL (output-reliability ${outputReliability.failedJobs})`);
    process.exit(1);
  }
  if (groomQuality.judgeBudgetExhausted || groomQuality.statisticalGate.regression) {
    if (!args.json) console.log("\nRESULT: FAIL (groom-quality gate)");
    process.exit(1);
  }
  if (failed.length > 0) {
    if (!args.json) console.log(`\nRESULT: FAIL (${failed.map((t) => t.name).join(", ")})`);
    process.exit(1);
  }
  if (!args.json) console.log("\nRESULT: PASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
