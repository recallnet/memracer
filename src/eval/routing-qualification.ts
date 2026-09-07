import { significantRegression, twoProportionZTest } from "./statistics.js";
import type { MediatorContext, MediatorDriver, MemoryToolExecutor } from "../mediator/driver.js";

interface QualitySummary {
  cases: number;
  passed: number;
  passRate: number;
  judgeBudgetExhausted: boolean;
  metrics: { jsonValidity: number; toolLoopSuccess: number };
}

export interface RoutingQualificationInput {
  baseline: QualitySummary;
  candidate: QualitySummary;
  reliability: { jobs: number; failedJobs: number };
  candidateTools: Record<"off" | "low", { calls: number; failed: boolean; error?: string }>;
}

export interface RoutingQualificationDecision {
  qualified: boolean;
  reasons: string[];
}

/** Hard gate used before MEMRACER_MEDIATOR_CHEAP_QUALIFIED may be enabled. */
export function qualifyMediatorRouting(input: RoutingQualificationInput): RoutingQualificationDecision {
  const reasons: string[] = [];
  if (input.candidate.cases < 100) {
    reasons.push(`candidate quality corpus has ${input.candidate.cases} cases; at least 100 are required`);
  }
  const passedReliability = input.reliability.jobs - input.reliability.failedJobs;
  if (input.reliability.jobs !== 60 || input.reliability.failedJobs !== 0) {
    reasons.push(`output reliability is ${passedReliability}/${input.reliability.jobs}; exactly 60/60 is required`);
  }
  if (input.candidate.metrics.jsonValidity !== 1) {
    reasons.push("candidate structured JSON reliability is not 100%");
  }
  if (input.candidate.metrics.toolLoopSuccess !== 1) {
    reasons.push("candidate tool-loop reliability is not 100%");
  }
  for (const mode of ["off", "low"] as const) {
    const probe = input.candidateTools[mode];
    if (probe.failed || probe.calls !== 1) {
      const detail = probe.error ? `: ${probe.error}` : "";
      reasons.push(`candidate ${mode}-reasoning tool probe made ${probe.calls} successful calls; exactly 1 is required${detail}`);
    }
  }
  if (input.candidate.judgeBudgetExhausted) reasons.push("candidate judge budget was exhausted");

  if (input.baseline.cases > 0 && input.candidate.cases > 0) {
    const significance = twoProportionZTest(
      input.candidate.passed,
      input.candidate.cases,
      input.baseline.passed,
      input.baseline.cases,
    );
    if (significantRegression(significance, input.candidate.cases, 0.02)) {
      reasons.push(
        `quality pass rate regressed from ${(input.baseline.passRate * 100).toFixed(1)}% to ` +
        `${(input.candidate.passRate * 100).toFixed(1)}%`,
      );
    }
  }
  return { qualified: reasons.length === 0, reasons };
}

/** One real candidate completion proving that its routed provider can execute our tool loop. */
export async function runRoutingToolQualification(
  driver: MediatorDriver,
): Promise<{ calls: number; failed: boolean; error?: string }> {
  let calls = 0;
  const tools: MemoryToolExecutor = {
    toolDefinitions: () => [{
      type: "function",
      function: {
        name: "qualification_probe",
        description: "Required routing qualification probe. Call this exactly once before answering.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["nonce"],
          properties: { nonce: { type: "string", const: "memracer-routing-qualification" } },
        },
      },
    }],
    async dispatch(name, args) {
      if (name !== "qualification_probe" || args.nonce !== "memracer-routing-qualification") {
        throw new Error("candidate dispatched an invalid qualification tool call");
      }
      calls += 1;
      return { qualified: true };
    },
  };
  const ctx: MediatorContext = {
    projectId: "routing-qualification",
    projectName: "Routing qualification",
    queue: [],
    decisions: [],
    memory: "",
    tools,
  };
  try {
    await driver.answer(ctx, {
      taskId: 1,
      question: "Call qualification_probe exactly once with the required nonce, then answer that the probe completed. Do not skip the tool call.",
    });
    return { calls, failed: calls !== 1 };
  } catch (error) {
    return { calls, failed: true, error: error instanceof Error ? error.message : String(error) };
  }
}
