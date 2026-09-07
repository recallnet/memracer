import type { MediatorContext, ProjectKnowledgeRefreshInput } from "../mediator/driver.js";
import { OpenRouterDriver } from "../mediator/openrouter.js";

export type OutputReliabilitySignature = "xml-wrapper" | "truncated-json" | "duplicate-set" | "over-length-reason";

export interface OutputReliabilityCaseResult {
  signature: OutputReliabilitySignature;
  jobs: number;
  failures: string[];
  failedJobs: number;
  requests: number;
  completionCount: number;
  ok: boolean;
}

export interface OutputReliabilityScorecard {
  cases: number;
  simulatedMinutes: number;
  failedJobs: number;
  requests: number;
  completionCount: number;
  perCase: OutputReliabilityCaseResult[];
}

export interface ScriptedCompletion {
  content: string;
  finishReason?: string;
}

export interface OutputReliabilityEvalOptions {
  simulatedMinutes?: number;
  mutate?: (signature: OutputReliabilitySignature, completions: ScriptedCompletion[]) => ScriptedCompletion[];
}

const ctx: MediatorContext = {
  projectId: "reliability-eval",
  projectName: "Reliability eval",
  queue: [],
  decisions: [],
  memory: "",
};

const answer = { escalate: false, answer: "recovered", rationale: "valid structured output" };
const refreshInput: ProjectKnowledgeRefreshInput = {
  candidates: [{
    domain: "product-bounds",
    label: "Product and bounds",
    description: "Purpose and explicit scope boundaries.",
    last_refreshed_at: null,
    last_checked_at: null,
    triggers: ["TIME"],
    reasons: ["reliability eval"],
    concepts: [],
    open_question: null,
    event_generation: 0,
  }],
  repo: null,
};
const refresh = { checked_domains: ["product-bounds"], questions: [], rationale: "checked" } as const;
const overLengthReason = "r".repeat(350);
const normalizedReason = overLengthReason.slice(0, 300);
const groomInput = {
  taskId: 1,
  title: "Recover mediator output",
  body: "Keep proven recoverable output within the strict schema boundary.",
  priority: 0,
  submittedBy: "reliability-eval",
  evidence: [],
};
const groom = {
  action: "accept",
  title: groomInput.title,
  body: groomInput.body,
  priority: groomInput.priority,
  rationale: "recovered",
  knowledge_events: [{ domain: "architecture-tech", reason: normalizedReason }],
} as const;

function scriptedFetch(completions: ScriptedCompletion[], bodies: Array<Record<string, unknown>>): typeof fetch {
  let call = 0;
  return async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    const completion = completions[Math.min(call++, completions.length - 1)];
    return {
      ok: true,
      status: 200,
      json: async () => ({
        model: "eval/model",
        choices: [{ finish_reason: completion.finishReason ?? "stop", message: { content: completion.content } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0001 },
      }),
      text: async () => "",
    } as Response;
  };
}

async function runOne(
  signature: OutputReliabilitySignature,
  mutate?: OutputReliabilityEvalOptions["mutate"],
): Promise<{ failures: string[]; requests: number; completionCount: number }> {
  const bodies: Array<Record<string, unknown>> = [];
  const completions: ScriptedCompletion[] = signature === "xml-wrapper"
    ? [{ content: `<tool_call>${JSON.stringify(answer)}</tool_call>` }]
    : signature === "truncated-json"
      ? [
          { content: '{"escalate":false,"answer":"cut', finishReason: "length" },
          { content: JSON.stringify(answer) },
        ]
      : signature === "duplicate-set"
        ? [{ content: JSON.stringify({ ...refresh, checked_domains: ["product-bounds", "product-bounds"] }) }]
        : [{ content: JSON.stringify({ ...groom, knowledge_events: [{ domain: "architecture-tech", reason: overLengthReason }] }) }];
  const scripted = mutate?.(signature, completions) ?? completions;
  const driver = new OpenRouterDriver("eval-key", "eval/model", "https://eval.invalid", {
    fetch: scriptedFetch(scripted, bodies),
    hedgeDelayMs: 60_000,
  });
  const failures: string[] = [];
  try {
    if (signature === "duplicate-set") {
      const result = await driver.refreshProjectKnowledge(ctx, refreshInput);
      if (JSON.stringify(result) !== JSON.stringify(refresh)) failures.push("set normalization changed the valid result");
    } else if (signature === "over-length-reason") {
      const result = await driver.groom(ctx, groomInput);
      if (JSON.stringify(result) !== JSON.stringify(groom)) failures.push("knowledge-event reason was not truncated to exactly 300 characters");
    } else {
      const result = await driver.answer(ctx, { taskId: 1, question: "recover output" });
      if (JSON.stringify(result) !== JSON.stringify(answer)) failures.push("structured answer did not recover exactly");
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  const expectedRequests = signature === "truncated-json" ? 2 : 1;
  if (bodies.length !== expectedRequests) failures.push(`expected ${expectedRequests} request(s), got ${bodies.length}`);
  const budgets = bodies.map((body) => body.max_tokens);
  const expectedBudgets = signature === "truncated-json" ? [32_768, 65_536] : [32_768];
  if (JSON.stringify(budgets) !== JSON.stringify(expectedBudgets)) {
    failures.push(`expected token budgets ${expectedBudgets.join(",")}, got ${budgets.join(",")}`);
  }
  const completionCount = driver.takeUsage()?.completionCount ?? 0;
  if (completionCount !== expectedRequests) failures.push(`expected ${expectedRequests} metered completion(s), got ${completionCount}`);
  return { failures, requests: bodies.length, completionCount };
}

/** One deterministic job per simulated minute, evenly covering all live signatures. */
export async function runOutputReliabilityEval(options: OutputReliabilityEvalOptions = {}): Promise<OutputReliabilityScorecard> {
  const simulatedMinutes = options.simulatedMinutes ?? 60;
  const signatures: OutputReliabilitySignature[] = ["xml-wrapper", "truncated-json", "duplicate-set", "over-length-reason"];
  const grouped = new Map<OutputReliabilitySignature, OutputReliabilityCaseResult>(signatures.map((signature) => [signature, {
    signature,
    jobs: 0,
    failures: [],
    failedJobs: 0,
    requests: 0,
    completionCount: 0,
    ok: true,
  }]));
  for (let minute = 0; minute < simulatedMinutes; minute++) {
    const signature = signatures[minute % signatures.length];
    const result = await runOne(signature, options.mutate);
    const aggregate = grouped.get(signature)!;
    aggregate.jobs += 1;
    aggregate.requests += result.requests;
    aggregate.completionCount += result.completionCount;
    if (result.failures.length > 0) aggregate.failedJobs += 1;
    aggregate.failures.push(...result.failures.map((failure) => `minute ${minute + 1}: ${failure}`));
  }
  const perCase = [...grouped.values()].map((result) => ({ ...result, ok: result.failures.length === 0 }));
  return {
    cases: simulatedMinutes,
    simulatedMinutes,
    failedJobs: perCase.reduce((sum, result) => sum + result.failedJobs, 0),
    requests: perCase.reduce((sum, result) => sum + result.requests, 0),
    completionCount: perCase.reduce((sum, result) => sum + result.completionCount, 0),
    perCase,
  };
}
